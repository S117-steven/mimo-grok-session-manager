const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const Database = require('better-sqlite3');
const {
    listGrokSessions,
    findGrokSession,
    renameGrokSession,
    createGrokLauncher,
    isGrokInstalled,
    GROK_SESSION_ID_PATTERN
} = require('./grok-sessions');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 32 * 1024;
const BODY_TIMEOUT_MS = 5000;
const MAX_TITLE_LENGTH = 200;
const MIMO_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{1,128}$/;
// Accepts MiMo (`ses_...`) and Grok Build (UUIDv7) session IDs.
const SESSION_ID_PATTERN = new RegExp(
    `^(?:${MIMO_SESSION_ID_PATTERN.source.slice(1, -1)}|${GROK_SESSION_ID_PATTERN.source.slice(1, -1)})$`,
    'i'
);
const SORT_OPTIONS = new Set(['updated-desc', 'updated-asc', 'title-asc', 'title-desc', 'workspace-asc', 'custom']);
const DEFAULT_STATE = Object.freeze({ sortBy: 'updated-desc', pinnedIds: [], hiddenIds: [], customOrder: [] });

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function sendError(res, error, logger) {
    if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
        return;
    }
    logger.error(error);
    sendJson(res, 500, { error: { code: 'internal_error', message: 'Server failed to process the request' } });
}

function applySecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
}

function validateRequestSource(req) {
    const host = req.headers.host || '';
    const localPort = req.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
    if (!allowedHosts.has(host.toLowerCase())) {
        throw new HttpError(403, 'invalid_host', 'Request host is not allowed');
    }
    if (req.method === 'POST' && req.headers.origin) {
        const allowedOrigins = new Set(Array.from(allowedHosts, value => `http://${value}`));
        if (!allowedOrigins.has(req.headers.origin.toLowerCase())) {
            throw new HttpError(403, 'invalid_origin', 'Request origin is not allowed');
        }
    }
}

function readJsonBody(req) {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
        throw new HttpError(415, 'unsupported_media_type', 'Request must use application/json');
    }
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => finish(new HttpError(408, 'request_timeout', 'Request body timed out')), BODY_TIMEOUT_MS);
        function cleanup() {
            clearTimeout(timer);
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('aborted', onAborted);
            req.off('error', onError);
        }
        function finish(error, value) {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value);
        }
        function onData(chunk) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                req.resume();
                finish(new HttpError(413, 'payload_too_large', 'Request body is too large'));
                return;
            }
            body += chunk;
        }
        function onEnd() {
            try {
                const parsed = JSON.parse(body);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new HttpError(400, 'invalid_json', 'JSON body must be an object');
                }
                finish(null, parsed);
            } catch (error) {
                finish(error instanceof HttpError ? error : new HttpError(400, 'invalid_json', 'Invalid JSON body'));
            }
        }
        function onAborted() { finish(new HttpError(400, 'request_aborted', 'Request was aborted')); }
        function onError() { finish(new HttpError(400, 'request_error', 'Failed to read request')); }
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('aborted', onAborted);
        req.on('error', onError);
    });
}

function validateId(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
        throw new HttpError(400, 'invalid_session_id', 'Invalid session id');
    }
    return id;
}

function validateTitle(title) {
    if (typeof title !== 'string') throw new HttpError(400, 'invalid_title', 'Title must be a string');
    const normalized = title.trim();
    if (!normalized) throw new HttpError(400, 'invalid_title', 'Title cannot be empty');
    if (normalized.length > MAX_TITLE_LENGTH) throw new HttpError(400, 'invalid_title', `Title cannot exceed ${MAX_TITLE_LENGTH} characters`);
    return normalized;
}

function validateIdArray(value, field) {
    if (!Array.isArray(value) || value.length > 10000) throw new HttpError(400, 'invalid_preferences', `${field} must be an array`);
    return [...new Set(value.map(validateId))];
}

function validateLocalDirectory(directory) {
    if (typeof directory !== 'string' || directory.length > 2000) throw new HttpError(400, 'invalid_directory', 'Invalid folder path');
    const trimmed = directory.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || trimmed.startsWith('\\\\')) {
        throw new HttpError(400, 'invalid_directory', 'Choose a local absolute folder path');
    }
    const resolved = path.resolve(trimmed);
    try {
        if (!fs.statSync(resolved).isDirectory()) throw new HttpError(409, 'directory_not_found', 'Folder does not exist');
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, 'directory_not_found', 'Folder does not exist');
    }
    return resolved;
}

function withDatabase(dbPath, options, operation) {
    let db;
    try {
        db = new Database(dbPath, { ...options, fileMustExist: true });
        db.pragma('busy_timeout = 3000');
        return operation(db);
    } finally {
        if (db) db.close();
    }
}

function listSessions(dbPath) {
    return withDatabase(dbPath, { readonly: true }, db => db.prepare(`
        SELECT id, title, directory, time_updated AS timeUpdated,
            datetime(time_updated / 1000, 'unixepoch', 'localtime') AS updated
        FROM session
        WHERE title NOT LIKE 'checkpoint-writer:%'
        ORDER BY time_updated DESC
    `).all());
}

function renameSession(dbPath, id, title) {
    return withDatabase(dbPath, {}, db => db.prepare("UPDATE session SET title = ? WHERE id = ? AND title NOT LIKE 'checkpoint-writer:%'").run(title, id).changes);
}

function findSession(dbPath, id) {
    return withDatabase(dbPath, { readonly: true }, db => db.prepare("SELECT id, directory FROM session WHERE id = ? AND title NOT LIKE 'checkpoint-writer:%'").get(id));
}

function findMissingSessionIds(dbPath, ids) {
    const missingFromMimo = withDatabase(dbPath, { readonly: true }, db => {
        const existing = new Set();
        for (let offset = 0; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(`SELECT id FROM session WHERE id IN (${placeholders}) AND title NOT LIKE 'checkpoint-writer:%'`).all(...chunk).forEach(row => existing.add(row.id));
        }
        return ids.filter(id => !existing.has(id));
    });
    if (!missingFromMimo.length) return [];
    const existingGrokIds = new Set(listGrokSessions().map(session => session.id));
    return missingFromMimo.filter(id => !existingGrokIds.has(id));
}

function listWorkspaces(dbPath, grokSessions = []) {
    return withDatabase(dbPath, { readonly: true }, db => {
        const rows = db.prepare(`
            SELECT directory, COUNT(*) AS sessionCount, MAX(time_updated) AS timeUpdated
            FROM session
            WHERE title NOT LIKE 'checkpoint-writer:%'
            GROUP BY directory
            ORDER BY timeUpdated DESC
        `).all();
        const merged = new Map();
        rows.forEach(item => {
            const key = item.directory.toLowerCase();
            const existing = merged.get(key);
            if (existing) existing.sessionCount += item.sessionCount;
            else merged.set(key, { directory: item.directory, sessionCount: item.sessionCount, timeUpdated: item.timeUpdated || 0 });
        });
        const hasProjectTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'").get();
        if (hasProjectTable) {
            db.prepare("SELECT worktree, time_updated AS timeUpdated FROM project WHERE worktree <> '/' ORDER BY time_updated DESC").all().forEach(project => {
                const key = project.worktree.toLowerCase();
                if (!merged.has(key)) merged.set(key, { directory: project.worktree, sessionCount: 0, timeUpdated: project.timeUpdated || 0 });
            });
        }
        grokSessions.forEach(session => {
            if (!session.directory) return;
            const key = session.directory.toLowerCase();
            const existing = merged.get(key);
            if (existing) {
                existing.sessionCount += 1;
                existing.timeUpdated = Math.max(existing.timeUpdated || 0, session.timeUpdated || 0);
            } else {
                merged.set(key, {
                    directory: session.directory,
                    sessionCount: 1,
                    timeUpdated: session.timeUpdated || 0
                });
            }
        });
        return [...merged.values()]
            .map(({ directory, sessionCount }) => ({ directory, sessionCount }))
            .sort((a, b) => {
                const left = merged.get(a.directory.toLowerCase())?.timeUpdated || 0;
                const right = merged.get(b.directory.toLowerCase())?.timeUpdated || 0;
                return right - left;
            });
    });
}

function normalizeState(value = {}) {
    return {
        sortBy: SORT_OPTIONS.has(value.sortBy) ? value.sortBy : DEFAULT_STATE.sortBy,
        pinnedIds: Array.isArray(value.pinnedIds) ? [...new Set(value.pinnedIds.filter(id => SESSION_ID_PATTERN.test(id)))] : [],
        hiddenIds: Array.isArray(value.hiddenIds) ? [...new Set(value.hiddenIds.filter(id => SESSION_ID_PATTERN.test(id)))] : [],
        customOrder: Array.isArray(value.customOrder) ? [...new Set(value.customOrder.filter(id => SESSION_ID_PATTERN.test(id)))] : []
    };
}

function loadState(statePath, logger) {
    try {
        if (!fs.existsSync(statePath)) return normalizeState();
        return normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    } catch (error) {
        logger.error(error);
        return normalizeState();
    }
}

function saveState(statePath, state) {
    const normalized = normalizeState(state);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, statePath);
    return normalized;
}

function resolveMimoCommand() {
    if (process.env.MIMO_COMMAND) return path.resolve(process.env.MIMO_COMMAND);
    const output = execFileSync('where.exe', ['mimo.cmd'], { encoding: 'utf8', windowsHide: true });
    const command = output.split(/\r?\n/).find(Boolean);
    if (!command) throw new Error('mimo.cmd was not found');
    return path.resolve(command.trim());
}

function quoteCmdArg(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function createMimoLaunchEnv() {
    const env = { ...process.env };
    if (!env.XDG_CONFIG_HOME) {
        env.XDG_CONFIG_HOME = path.join(
            env.LOCALAPPDATA || env.TEMP || env.USERPROFILE,
            'mimo-session-manager',
            'xdg-config'
        );
    }
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    return env;
}

function createTerminalLauncher(mimoCommand, spawnImpl = spawn) {
    return ({ id, directory }) => new Promise((resolve, reject) => {
        const mimoArgs = [mimoCommand];
        if (id) mimoArgs.push('-s', id);
        // Pass the full mimo command through an environment variable so that
        // cmd.exe expands %__MIMO_CMD% at runtime.  This avoids a quoting bug
        // where Node.js's spawn escapes embedded " as \" in the command-line
        // string passed to CreateProcess — an escape that cmd.exe does NOT
        // understand, causing the mimo launch to fail silently.
        const env = createMimoLaunchEnv();
        env.__MIMO_CMD = mimoArgs.map(quoteCmdArg).join(' ');
        const child = spawnImpl('cmd.exe', ['/d', '/k', 'chcp 65001 >nul & %__MIMO_CMD%'], {
            cwd: directory,
            detached: true,
            env,
            stdio: 'ignore',
            windowsHide: false,
            shell: false
        });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

function createFolderPicker() {
    const vbsPath = path.join(__dirname, '.folder-picker.vbs');
    const vbscript = [
        'Dim objShell, objFolder',
        'Set objShell = CreateObject("Shell.Application")',
        'Set objFolder = objShell.BrowseForFolder(0, "Select a local folder for a new MiMo conversation", 0)',
        'If Not objFolder Is Nothing Then',
        '  WScript.Echo objFolder.Self.Path',
        'End If'
    ].join('\r\n');
    return () => new Promise((resolve, reject) => {
        fs.writeFileSync(vbsPath, vbscript, 'utf8');
        execFile('cscript.exe', ['//NoLogo', vbsPath], { encoding: 'utf8', timeout: 60000 }, (error, stdout) => {
            try { fs.unlinkSync(vbsPath); } catch {}
            if (error) reject(error);
            else resolve(stdout.trim() || null);
        });
    });
}

function requireMethod(req, res, method) {
    if (req.method !== method) {
        res.setHeader('Allow', method);
        throw new HttpError(405, 'method_not_allowed', 'Method is not allowed');
    }
}

function createServer(options = {}) {
    const dbPath = options.dbPath || process.env.MIMO_DB_PATH || path.join(process.env.USERPROFILE, '.local', 'share', 'mimocode', 'mimocode.db');
    const statePath = options.statePath || process.env.MIMO_MANAGER_STATE_PATH || path.join(process.env.USERPROFILE, '.local', 'share', 'mimo-session-manager', 'state.json');
    const launcher = options.launcher || createTerminalLauncher(resolveMimoCommand());
    const newLauncher = options.newLauncher || launcher;
    const folderPicker = options.folderPicker || createFolderPicker();
    const grokLauncher = options.grokLauncher || (isGrokInstalled() ? createGrokLauncher() : null);
    const logger = options.logger || console;
    const indexPath = options.indexPath || path.join(__dirname, 'index.html');
    const appPath = options.appPath || path.join(__dirname, 'app.js');

    return http.createServer(async (req, res) => {
        applySecurityHeaders(res);
        try {
            validateRequestSource(req);
            const requestUrl = new URL(req.url, 'http://localhost');
            if (requestUrl.pathname === '/') {
                requireMethod(req, res, 'GET');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fs.readFileSync(indexPath, 'utf8'));
                return;
            }
            if (requestUrl.pathname === '/app.js') {
                requireMethod(req, res, 'GET');
                res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
                res.end(fs.readFileSync(appPath, 'utf8'));
                return;
            }
            if (requestUrl.pathname === '/api/sessions') {
                requireMethod(req, res, 'GET');
                const grokSessions = listGrokSessions();
                sendJson(res, 200, {
                    sessions: listSessions(dbPath),
                    grokSessions,
                    workspaces: listWorkspaces(dbPath, grokSessions),
                    preferences: loadState(statePath, logger)
                });
                return;
            }
            if (requestUrl.pathname === '/api/preferences') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                const state = loadState(statePath, logger);
                if ('sortBy' in body) {
                    if (!SORT_OPTIONS.has(body.sortBy)) throw new HttpError(400, 'invalid_preferences', 'Invalid sort option');
                    state.sortBy = body.sortBy;
                }
                if ('pinnedIds' in body) state.pinnedIds = validateIdArray(body.pinnedIds, 'pinnedIds');
                if ('customOrder' in body) state.customOrder = validateIdArray(body.customOrder, 'customOrder');
                sendJson(res, 200, { preferences: saveState(statePath, state) });
                return;
            }
            if (requestUrl.pathname === '/api/hide' || requestUrl.pathname === '/api/hide-batch') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                const ids = requestUrl.pathname === '/api/hide' ? [validateId(body.id)] : validateIdArray(body.ids, 'ids');
                if (ids.length === 0) throw new HttpError(400, 'empty_selection', 'Select at least one session');
                if (typeof body.hidden !== 'boolean') throw new HttpError(400, 'invalid_hidden_value', 'hidden must be boolean');
                const missing = findMissingSessionIds(dbPath, ids);
                if (missing.length) throw new HttpError(404, 'session_not_found', 'Some sessions no longer exist');
                const state = loadState(statePath, logger);
                const hidden = new Set(state.hiddenIds);
                ids.forEach(id => body.hidden ? hidden.add(id) : hidden.delete(id));
                state.hiddenIds = [...hidden];
                sendJson(res, 200, { affected: ids.length, preferences: saveState(statePath, state) });
                return;
            }
            if (requestUrl.pathname === '/api/rename') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                const id = validateId(body.id);
                const title = validateTitle(body.title);
                let renamed = false;
                if (MIMO_SESSION_ID_PATTERN.test(id)) {
                    renamed = renameSession(dbPath, id, title) === 1;
                } else if (GROK_SESSION_ID_PATTERN.test(id)) {
                    renamed = renameGrokSession(id, title);
                }
                if (!renamed) throw new HttpError(404, 'session_not_found', 'Session was not found');
                sendJson(res, 200, { success: true });
                return;
            }
            if (requestUrl.pathname === '/api/continue') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                const session = findSession(dbPath, validateId(body.id));
                if (!session) throw new HttpError(404, 'session_not_found', 'Session was not found');
                validateLocalDirectory(session.directory);
                await launcher(session);
                sendJson(res, 200, { success: true });
                return;
            }
            if (requestUrl.pathname === '/api/new') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                await newLauncher({ directory: validateLocalDirectory(body.directory) });
                sendJson(res, 200, { success: true });
                return;
            }
            if (requestUrl.pathname === '/api/continue-grok') {
                requireMethod(req, res, 'POST');
                if (!grokLauncher) throw new HttpError(501, 'grok_not_installed', 'Grok Build is not installed');
                const body = await readJsonBody(req);
                const session = findGrokSession(validateId(body.id));
                if (!session) throw new HttpError(404, 'session_not_found', 'Grok session was not found');
                validateLocalDirectory(session.directory);
                await grokLauncher(session);
                sendJson(res, 200, { success: true });
                return;
            }
            if (requestUrl.pathname === '/api/new-grok') {
                requireMethod(req, res, 'POST');
                if (!grokLauncher) throw new HttpError(501, 'grok_not_installed', 'Grok Build is not installed');
                const body = await readJsonBody(req);
                await grokLauncher({ directory: validateLocalDirectory(body.directory) });
                sendJson(res, 200, { success: true });
                return;
            }
            if (requestUrl.pathname === '/api/browse-folders') {
                requireMethod(req, res, 'POST');
                const body = await readJsonBody(req);
                const dir = typeof body.path === 'string' ? body.path.trim() : '';
                if (!dir) {
                    const drives = [];
                    for (let i = 65; i <= 90; i++) {
                        const letter = String.fromCharCode(i);
                        if (fs.existsSync(`${letter}:\\`)) drives.push(`${letter}:\\`);
                    }
                    sendJson(res, 200, { path: '', entries: drives });
                    return;
                }
                const resolved = path.resolve(dir);
                try {
                    const entries = fs.readdirSync(resolved, { withFileTypes: true })
                        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
                        .map(d => d.name)
                        .sort();
                    sendJson(res, 200, { path: resolved, entries });
                } catch {
                    throw new HttpError(409, 'directory_not_found', 'Folder does not exist or is not accessible');
                }
                return;
            }
            throw new HttpError(404, 'not_found', 'Resource was not found');
        } catch (error) {
            if (!res.headersSent) sendError(res, error, logger);
        }
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const server = createServer();
    server.on('error', error => {
        console.error(`MiMo Session Manager failed to start: ${error.message}`);
        process.exitCode = 1;
    });
    server.listen(port, DEFAULT_HOST, () => {
        console.log(`MiMo Session Manager running at http://${DEFAULT_HOST}:${port}`);
    });
}

module.exports = {
    createServer,
    createTerminalLauncher,
    createFolderPicker,
    resolveMimoCommand,
    SESSION_ID_PATTERN
};

