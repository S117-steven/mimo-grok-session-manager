'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GROK_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.grok');
const GROK_BIN = path.join(GROK_DIR, 'bin', 'grok.exe');
const GROK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSessionsDir() {
    return process.env.GROK_SESSIONS_DIR || path.join(GROK_DIR, 'sessions');
}

function decodeEncodedCwd(encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function formatLocalDateTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = value => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        '-',
        pad(date.getMonth() + 1),
        '-',
        pad(date.getDate()),
        ' ',
        pad(date.getHours()),
        ':',
        pad(date.getMinutes()),
        ':',
        pad(date.getSeconds())
    ].join('');
}

function readSummary(sessionDir) {
    const summaryPath = path.join(sessionDir, 'summary.json');
    if (!fs.existsSync(summaryPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    } catch { return null; }
}

function writeSummary(sessionDir, summary) {
    const summaryPath = path.join(sessionDir, 'summary.json');
    const temporaryPath = `${summaryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, summaryPath);
}

function sessionFromSummary(sessionId, sessionDir, encodedCwd, summary) {
    const updatedAt = summary.updated_at || summary.last_active_at || null;
    return {
        id: sessionId,
        title: summary.manager_title || summary.generated_title || summary.session_summary || 'Untitled',
        directory: summary.info?.cwd || decodeEncodedCwd(encodedCwd),
        createdAt: summary.created_at || null,
        updatedAt,
        updated: formatLocalDateTime(updatedAt),
        timeUpdated: updatedAt ? new Date(updatedAt).getTime() : 0,
        messageCount: summary.num_messages || 0,
        model: summary.current_model_id || 'grok',
        provider: 'grok'
    };
}

function listGrokSessions(sessionsDir = getSessionsDir()) {
    if (!fs.existsSync(sessionsDir)) return [];

    const sessions = [];
    let cwdDirs;
    try {
        cwdDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory());
    } catch { return []; }

    for (const cwdDir of cwdDirs) {
        const encodedCwd = cwdDir.name;
        const cwdPath = path.join(sessionsDir, encodedCwd);

        let sessionDirs;
        try {
            sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true })
                .filter(entry => entry.isDirectory());
        } catch { continue; }

        for (const sessionDir of sessionDirs) {
            const fullPath = path.join(cwdPath, sessionDir.name);
            const summary = readSummary(fullPath);
            if (!summary) continue;
            sessions.push(sessionFromSummary(sessionDir.name, fullPath, encodedCwd, summary));
        }
    }

    return sessions.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0));
}

function findGrokSessionPath(id, sessionsDir = getSessionsDir()) {
    if (!GROK_SESSION_ID_PATTERN.test(id) || !fs.existsSync(sessionsDir)) return null;

    let cwdDirs;
    try {
        cwdDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory());
    } catch { return null; }

    for (const cwdDir of cwdDirs) {
        const fullPath = path.join(sessionsDir, cwdDir.name, id);
        if (fs.existsSync(path.join(fullPath, 'summary.json'))) {
            return { fullPath, encodedCwd: cwdDir.name };
        }
    }
    return null;
}

function findGrokSession(id, sessionsDir = getSessionsDir()) {
    const located = findGrokSessionPath(id, sessionsDir);
    if (!located) return null;
    const summary = readSummary(located.fullPath);
    if (!summary) return null;
    return sessionFromSummary(id, located.fullPath, located.encodedCwd, summary);
}

function renameGrokSession(id, title, sessionsDir = getSessionsDir()) {
    const located = findGrokSessionPath(id, sessionsDir);
    if (!located) return false;
    const summary = readSummary(located.fullPath);
    if (!summary) return false;
    summary.manager_title = title;
    writeSummary(located.fullPath, summary);
    return true;
}

function createGrokLauncher(spawnImpl = spawn) {
    return ({ id, directory }) => new Promise((resolve, reject) => {
        const grokArgs = [GROK_BIN];
        if (id) grokArgs.push('--resume', id);
        const env = { ...process.env };
        env.__GROK_CMD = grokArgs.map(a => `"${String(a).replace(/"/g, '""')}"`).join(' ');
        const child = spawnImpl('cmd.exe', ['/d', '/k', 'chcp 65001 >nul & %__GROK_CMD%'], {
            cwd: directory,
            detached: true,
            env,
            stdio: 'ignore',
            windowsHide: false,
            shell: false
        });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

function isGrokInstalled() {
    return fs.existsSync(GROK_BIN);
}

module.exports = {
    listGrokSessions,
    findGrokSession,
    findGrokSessionPath,
    renameGrokSession,
    createGrokLauncher,
    isGrokInstalled,
    GROK_BIN,
    GROK_SESSION_ID_PATTERN,
    getSessionsDir
};
