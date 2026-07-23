const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { createServer, createTerminalLauncher } = require('../server');

const SESSION_A = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_B = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHECKPOINT = 'ses_cccccccccccccccccccccccccc';

function createFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-manager-test-'));
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-manager-workspace-'));
    const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-manager-empty-workspace-'));
    const dbPath = path.join(directory, 'mimocode.db');
    const statePath = path.join(directory, 'manager-state.json');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT NOT NULL,
            title TEXT NOT NULL,
            time_updated INTEGER NOT NULL
        );
        CREATE TABLE project (
            id TEXT PRIMARY KEY,
            worktree TEXT NOT NULL,
            time_updated INTEGER NOT NULL
        );
    `);
    const insert = db.prepare('INSERT INTO session (id, directory, title, time_updated) VALUES (?, ?, ?, ?)');
    insert.run(SESSION_A, directory, 'Older session', 1000);
    insert.run(SESSION_B, secondDirectory, 'Newer session', 2000);
    insert.run(CHECKPOINT, directory, 'checkpoint-writer:hidden', 3000);
    db.prepare('INSERT INTO project (id, worktree, time_updated) VALUES (?, ?, ?)')
        .run('project-empty', emptyWorkspace, 4000);
    db.close();
    return { directory, secondDirectory, emptyWorkspace, dbPath, statePath };
}

async function startFixtureServer(existingFixture) {
    const fixture = existingFixture || createFixture();
    const launches = [];
    const newLaunches = [];
    const pickedDirectory = fixture.secondDirectory;
    const previousGrokDir = process.env.GROK_SESSIONS_DIR;
    process.env.GROK_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-grok-empty-'));
    const server = createServer({
        dbPath: fixture.dbPath,
        statePath: fixture.statePath,
        launcher: async session => launches.push(session),
        newLauncher: async workspace => newLaunches.push(workspace),
        folderPicker: async () => pickedDirectory
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        ...fixture,
        launches,
        newLaunches,
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {
            await new Promise(resolve => server.close(resolve));
            if (previousGrokDir === undefined) delete process.env.GROK_SESSIONS_DIR;
            else process.env.GROK_SESSIONS_DIR = previousGrokDir;
        }
    };
}

async function jsonRequest(baseUrl, pathname, options) {
    const response = await fetch(`${baseUrl}${pathname}`, options);
    return { response, data: await response.json() };
}

test('lists sessions from SQLite, excludes checkpoints, and sorts newest first', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const { response, data } = await jsonRequest(fixture.baseUrl, '/api/sessions');
    assert.equal(response.status, 200);
    assert.deepEqual(data.sessions.map(session => session.id), [SESSION_B, SESSION_A]);
    assert.deepEqual(data.workspaces.map(workspace => workspace.directory), [
        fixture.emptyWorkspace,
        fixture.secondDirectory,
        fixture.directory
    ]);
    assert.equal(data.workspaces[0].sessionCount, 0);
    assert.equal(data.preferences.sortBy, 'updated-desc');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
});

test('renames a session and stores XSS-like text literally', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);
    const title = `x');alert("not executable");//`;

    const { response } = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SESSION_A, title })
    });
    assert.equal(response.status, 200);

    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT title FROM session WHERE id = ?').pluck().get(SESSION_A), title);
    db.close();
});

test('continue uses the database directory and never accepts a client directory', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const { response } = await jsonRequest(fixture.baseUrl, '/api/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SESSION_A, directory: 'C:\\attacker-controlled' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.launches, [{ id: SESSION_A, directory: fixture.directory }]);
});

test('terminal launcher keeps an interactive CMD window open for continue and new sessions', async () => {
    const calls = [];
    const fakeSpawn = (command, args, options) => {
        calls.push({ command, args, options });
        return {
            once(event, handler) {
                if (event === 'spawn') queueMicrotask(handler);
                return this;
            },
            unref() {}
        };
    };
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-xdg-'));
    const launcher = createTerminalLauncher(String.raw`D:\npm-global\mimo.cmd`, fakeSpawn);
    try {
        await launcher({ id: SESSION_A, directory: String.raw`C:\work` });
        await launcher({ directory: String.raw`C:\new-work` });
    } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
    }
    assert.equal(calls[0].command, 'cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 2), ['/d', '/k']);
    assert.match(calls[0].args[2], /chcp 65001/);
    assert.match(calls[0].args[2], /%__MIMO_CMD%/);
    // Session ID and -s flag are now passed through the environment variable
    assert.match(calls[0].options.env.__MIMO_CMD, /"-s"/);
    assert.match(calls[0].options.env.__MIMO_CMD, new RegExp(SESSION_A));
    assert.equal(calls[0].options.cwd, 'C:\\work');
    assert.equal(calls[0].options.windowsHide, false);
    assert.ok(calls[0].options.env.XDG_CONFIG_HOME);

    assert.deepEqual(calls[1].args.slice(0, 2), ['/d', '/k']);
    assert.doesNotMatch(calls[1].options.env.__MIMO_CMD || '', /"-s"/);
    assert.equal(calls[1].options.cwd, 'C:\\new-work');
});
test('persists sorting, pinning, custom order, and hidden state without deleting sessions', async t => {
    const fixture = await startFixtureServer();
    const preferences = await jsonRequest(fixture.baseUrl, '/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sortBy: 'custom',
            pinnedIds: [SESSION_A],
            customOrder: [SESSION_A, SESSION_B]
        })
    });
    assert.equal(preferences.response.status, 200);

    const hidden = await jsonRequest(fixture.baseUrl, '/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SESSION_B, hidden: true })
    });
    assert.equal(hidden.response.status, 200);
    assert.deepEqual(hidden.data.preferences.hiddenIds, [SESSION_B]);

    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) FROM session WHERE id = ?').pluck().get(SESSION_B), 1);
    db.close();
    await fixture.close();

    const restarted = await startFixtureServer(fixture);
    t.after(restarted.close);
    const loaded = await jsonRequest(restarted.baseUrl, '/api/sessions');
    assert.equal(loaded.data.preferences.sortBy, 'custom');
    assert.deepEqual(loaded.data.preferences.pinnedIds, [SESSION_A]);
    assert.deepEqual(loaded.data.preferences.hiddenIds, [SESSION_B]);
    assert.deepEqual(loaded.data.preferences.customOrder, [SESSION_A, SESSION_B]);

    const restored = await jsonRequest(restarted.baseUrl, '/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SESSION_B, hidden: false })
    });
    assert.deepEqual(restored.data.preferences.hiddenIds, []);
});

test('batch hides and restores selected sessions without deleting database records', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const hidden = await jsonRequest(fixture.baseUrl, '/api/hide-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [SESSION_A, SESSION_B], hidden: true })
    });
    assert.equal(hidden.response.status, 200);
    assert.equal(hidden.data.affected, 2);
    assert.deepEqual(new Set(hidden.data.preferences.hiddenIds), new Set([SESSION_A, SESSION_B]));

    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) FROM session WHERE id IN (?, ?)').pluck().get(SESSION_A, SESSION_B), 2);
    db.close();

    const restored = await jsonRequest(fixture.baseUrl, '/api/hide-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [SESSION_A, SESSION_B], hidden: false })
    });
    assert.deepEqual(restored.data.preferences.hiddenIds, []);
});

test('creates a new conversation in any existing local folder and rejects invalid paths', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);
    const arbitraryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-arbitrary-folder-'));

    const created = await jsonRequest(fixture.baseUrl, '/api/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: arbitraryDirectory })
    });
    assert.equal(created.response.status, 200);
    assert.deepEqual(fixture.newLaunches, [{ directory: arbitraryDirectory }]);

    const rejected = await jsonRequest(fixture.baseUrl, '/api/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: path.join(fixture.directory, 'missing-folder') })
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(fixture.newLaunches.length, 1);
});

test('browse-folders lists directories', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const drives = await jsonRequest(fixture.baseUrl, '/api/browse-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(drives.response.status, 200);
    assert.equal(drives.data.path, '');
    assert.ok(Array.isArray(drives.data.entries));

    const sub = await jsonRequest(fixture.baseUrl, '/api/browse-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fixture.directory })
    });
    assert.equal(sub.response.status, 200);
    assert.ok(sub.data.path.length > 0);
    assert.ok(Array.isArray(sub.data.entries));
});

test('rejects invalid IDs before invoking the launcher', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const { response, data } = await jsonRequest(fixture.baseUrl, '/api/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ses_ok & calc.exe' })
    });
    assert.equal(response.status, 400);
    assert.equal(data.error.code, 'invalid_session_id');
    assert.equal(fixture.launches.length, 0);
});

test('returns useful client errors for unknown sessions, bad JSON, content type, size, and method', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const unknown = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ses_zzzzzzzzzzzzzzzzzzzzzzzzzz', title: 'Title' })
    });
    assert.equal(unknown.response.status, 404);

    const badJson = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
    });
    assert.equal(badJson.response.status, 400);

    const wrongType = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}'
    });
    assert.equal(wrongType.response.status, 415);

    const almostJson = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json-evil' },
        body: '{}'
    });
    assert.equal(almostJson.response.status, 415);

    const tooLarge = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SESSION_A, title: 'x'.repeat(40 * 1024) })
    });
    assert.equal(tooLarge.response.status, 413);

    const wrongMethod = await jsonRequest(fixture.baseUrl, '/api/sessions', { method: 'POST' });
    assert.equal(wrongMethod.response.status, 405);
});

test('rejects cross-origin POST requests and invalid Host headers', async t => {
    const fixture = await startFixtureServer();
    t.after(fixture.close);

    const origin = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ id: SESSION_A, title: 'Blocked' })
    });
    assert.equal(origin.response.status, 403);
    assert.equal(origin.data.error.code, 'invalid_origin');

    const port = fixture.server.address().port;
    const hostStatus = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/sessions',
            headers: { Host: 'evil.example' }
        }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
    assert.equal(hostStatus, 403);
});

test('internal errors do not expose database paths', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-manager-missing-'));
    const dbPath = path.join(directory, 'secret-database-name.db');
    const server = createServer({
        dbPath,
        statePath: path.join(directory, 'state.json'),
        launcher: async () => {},
        logger: { error() {} }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const { response, data } = await jsonRequest(baseUrl, '/api/sessions');
    assert.equal(response.status, 500);
    assert.equal(data.error.code, 'internal_error');
    assert.doesNotMatch(JSON.stringify(data), /secret-database-name|mimo-manager-missing/);
});

test('frontend is valid JavaScript and contains no inline event handlers', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    new vm.Script(app);
    assert.doesNotMatch(html, /\son\w+=/i);
    assert.match(html, /id="workspaceFilter"/);
    assert.match(html, /id="sortSelect"/);
    assert.match(html, /id="newSessionButton"/);
    assert.match(html, /id="selectVisibleButton"/);
    assert.match(html, /id="hideSelectedButton"/);
    assert.match(html, /id="workspaceTags"/);
    assert.match(html, /id="folderBrowser"/);
    assert.match(html, /data-provider="grok"/);
    assert.match(html, /id="createGrokSessionButton"/);
    assert.match(app, /createGrokSession/);
    assert.match(app, /continueGrokSession/);
    assert.doesNotMatch(app, /if \(!isGrok\) \{\s*actions\.append\(createButton\(isPinned/);
});

function createGrokFixtureSession(rootDir, {
    id = '019f90cd-9a0f-71a3-b8fa-c762dbff617e',
    cwd = 'C:\\Users\\test\\project',
    title = 'Original Grok Title'
} = {}) {
    const encodedCwd = encodeURIComponent(cwd);
    const sessionDir = path.join(rootDir, encodedCwd, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    const summary = {
        info: { id, cwd },
        session_summary: title,
        generated_title: title,
        created_at: '2026-07-23T10:00:00.000Z',
        updated_at: '2026-07-23T12:00:00.000Z',
        num_messages: 3,
        current_model_id: 'grok-4.5'
    };
    fs.writeFileSync(path.join(sessionDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return { id, cwd, sessionDir, summaryPath: path.join(sessionDir, 'summary.json') };
}

async function startGrokAwareServer() {
    const fixture = createFixture();
    const grokRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-grok-sessions-'));
    const previousGrokDir = process.env.GROK_SESSIONS_DIR;
    process.env.GROK_SESSIONS_DIR = grokRoot;
    const grokSession = createGrokFixtureSession(grokRoot, { cwd: fixture.directory });
    const grokLaunches = [];
    const server = createServer({
        dbPath: fixture.dbPath,
        statePath: fixture.statePath,
        launcher: async () => {},
        newLauncher: async () => {},
        grokLauncher: async session => { grokLaunches.push(session); },
        folderPicker: async () => fixture.directory
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        ...fixture,
        grokRoot,
        grokSession,
        grokLaunches,
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {
            await new Promise(resolve => server.close(resolve));
            if (previousGrokDir === undefined) delete process.env.GROK_SESSIONS_DIR;
            else process.env.GROK_SESSIONS_DIR = previousGrokDir;
        }
    };
}

test('lists, renames, pins, and hides Grok sessions like MiMo sessions', async t => {
    const fixture = await startGrokAwareServer();
    t.after(fixture.close);

    const listed = await jsonRequest(fixture.baseUrl, '/api/sessions');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.data.grokSessions.length, 1);
    assert.equal(listed.data.grokSessions[0].id, fixture.grokSession.id);
    assert.equal(listed.data.grokSessions[0].title, 'Original Grok Title');
    assert.equal(listed.data.grokSessions[0].provider, 'grok');
    assert.ok(listed.data.workspaces.some(workspace =>
        workspace.directory.toLowerCase() === fixture.directory.toLowerCase() &&
        workspace.sessionCount >= 2
    ));

    const renamedTitle = 'Renamed Grok Session';
    const renamed = await jsonRequest(fixture.baseUrl, '/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fixture.grokSession.id, title: renamedTitle })
    });
    assert.equal(renamed.response.status, 200);
    const summary = JSON.parse(fs.readFileSync(fixture.grokSession.summaryPath, 'utf8'));
    assert.equal(summary.manager_title, renamedTitle);
    assert.equal(summary.generated_title, 'Original Grok Title');

    const afterRename = await jsonRequest(fixture.baseUrl, '/api/sessions');
    assert.equal(afterRename.data.grokSessions[0].title, renamedTitle);

    const preferences = await jsonRequest(fixture.baseUrl, '/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sortBy: 'custom',
            pinnedIds: [fixture.grokSession.id, SESSION_A],
            customOrder: [fixture.grokSession.id, SESSION_A, SESSION_B]
        })
    });
    assert.equal(preferences.response.status, 200);
    assert.deepEqual(preferences.data.preferences.pinnedIds, [fixture.grokSession.id, SESSION_A]);
    assert.deepEqual(preferences.data.preferences.customOrder, [fixture.grokSession.id, SESSION_A, SESSION_B]);

    const hidden = await jsonRequest(fixture.baseUrl, '/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fixture.grokSession.id, hidden: true })
    });
    assert.equal(hidden.response.status, 200);
    assert.deepEqual(hidden.data.preferences.hiddenIds, [fixture.grokSession.id]);

    const batch = await jsonRequest(fixture.baseUrl, '/api/hide-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [fixture.grokSession.id, SESSION_B], hidden: true })
    });
    assert.equal(batch.response.status, 200);
    assert.deepEqual(new Set(batch.data.preferences.hiddenIds), new Set([fixture.grokSession.id, SESSION_B]));

    const continued = await jsonRequest(fixture.baseUrl, '/api/continue-grok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fixture.grokSession.id })
    });
    assert.equal(continued.response.status, 200);
    assert.equal(fixture.grokLaunches.length, 1);
    assert.equal(fixture.grokLaunches[0].id, fixture.grokSession.id);
});





