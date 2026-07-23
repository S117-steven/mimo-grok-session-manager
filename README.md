# MiMo Session Manager

A lightweight, local-only web session manager for [MiMo Code](https://github.com/XiaoMi/MiMo). Browse, organize, and continue your MiMo conversations from a clean browser UI.

## Features

- **Session List** — View all MiMo sessions with title, workspace, and last-updated time
- **Workspace Filter** — Filter sessions by project directory
- **Sorting** — Sort by update time, title, workspace, or custom order
- **Pin / Unpin** — Pin important sessions to the top
- **Rename** — Rename any session directly from the manager
- **Hide / Restore** — Hide clutter without deleting real sessions (reversible)
- **Batch Operations** — Select multiple sessions for bulk hide/restore
- **New Conversation** — Start a new MiMo session in any local folder (with folder browser)
- **Continue Session** — Resume any session in a new terminal window

## Screenshot

```
┌─────────────────────────────────────────────────────────┐
│  MiMo Code Session Manager                              │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐                  │
│  │  12     │ │  35      │ │  4      │                  │
│  │ Visible │ │  Total   │ │Workspaces│                  │
│  └─────────┘ └──────────┘ └─────────┘                  │
│                                                         │
│  Workspace: [All ▾]  Sort: [Last Updated ▾]            │
│                                                         │
│  [x] 1  Fix login bug        /project-a   2025-07-20   │
│       [Pin] [Rename] [Continue] [Hide]                 │
│  [ ] 2  Add dark mode        /project-b   2025-07-19   │
│       [Pin] [Rename] [Continue] [Hide]                 │
└─────────────────────────────────────────────────────────┘
```

## Requirements

- **Node.js 20+** ([download](https://nodejs.org/))
- **MiMo CLI** installed and accessible via `mimo.cmd` in your PATH
- A readable MiMo SQLite database (auto-detected at default location)

## Quick Start (Windows)

### Option A: Double-click start.bat

1. Download or clone this repo
2. Open a terminal in the project folder
3. Run:
   ```powershell
   npm install
   ```
4. Double-click `start.bat` — it starts the server and opens your browser

### Option B: Command Line

```powershell
# Clone the repository
git clone https://github.com/S117-steven/MiMo-Session-Manager.git
cd MiMo-Session-Manager

# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://127.0.0.1:3456** in your browser.

### Option C: Desktop Shortcut

```powershell
npm install
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
```

This creates a "MiMo Session Manager" shortcut on your desktop.

## How It Works

1. The server reads your MiMo SQLite database (where MiMo stores all session data)
2. It presents a web UI at `http://127.0.0.1:3456`
3. You can view, sort, filter, rename, pin, hide, and continue sessions
4. Clicking "Continue" opens a new terminal with that MiMo session
5. Clicking "New Conversation" lets you start fresh in any folder

> **Note:** This manager only reads MiMo's database. It does not modify your actual session data (except renaming titles and managing preferences).

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MIMO_DB_PATH` | `%USERPROFILE%\.local\share\mimocode\mimocode.db` | Path to MiMo SQLite database |
| `MIMO_COMMAND` | auto-detected via `where mimo.cmd` | Absolute path to `mimo.cmd` |
| `MIMO_MANAGER_STATE_PATH` | `%USERPROFILE%\.local\share\mimo-session-manager\state.json` | Path to manager preferences |
| `PORT` | `3456` | Server port |

### Example

```powershell
$env:MIMO_DB_PATH = "C:\custom\path\mimocode.db"
npm start
```

## Security

- Server only listens on `127.0.0.1` — no LAN/internet access
- CORS is not enabled; POST requests validate `Origin` header
- Session IDs are strictly validated (pattern: `ses_[A-Za-z0-9_-]`)
- "Continue session" reads the workspace directory from the database, not from user input
- Strict Content Security Policy (CSP) headers
- All dynamic content rendered via DOM API (no `innerHTML`)

## Project Structure

```
MiMo-Session-Manager/
├── server.js           # Node.js HTTP server + SQLite API
├── app.js              # Frontend JavaScript
├── index.html          # Web UI (single page)
├── package.json        # Dependencies and scripts
├── start.bat           # Windows launcher
├── create-shortcut.ps1 # Creates desktop shortcut
├── LICENSE             # MIT License
└── test/
    └── server.test.js  # Test suite
```

## Development

```powershell
# Syntax check
npm run check

# Run tests
npm test

# Check for vulnerabilities
npm audit
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | Close existing server process or set `PORT=3457` |
| Database read failed | Verify MiMo is installed and has been used at least once |
| "mimo.cmd was not found" | Ensure MiMo CLI is in your PATH, or set `MIMO_COMMAND` |
| Session won't continue | Check that the workspace directory still exists |
| Browser shows blank page | Make sure `npm install` was run and `node_modules/` exists |

## License

[MIT](LICENSE)
