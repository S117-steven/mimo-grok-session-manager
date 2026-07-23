# MiMo & Grok Session Manager

[English](#english) | 中文

MiMo Code 和 Grok Build 的轻量级本地会话管理器。通过统一的浏览器界面管理两个平台的对话。

## 功能

- **双平台支持** — 同时管理 MiMo Code 和 Grok Build 的会话
- **会话列表** — 查看所有会话，显示标题、工作区、更新时间和消息数
- **工作区筛选** — 按项目目录过滤会话
- **多种排序** — 按更新时间、标题、工作区或自定义顺序排序
- **置顶/取消置顶** — 将重要会话置顶显示
- **重命名** — 直接在管理器中重命名会话
- **隐藏/恢复** — 隐藏杂乱会话（不删除真实数据，可随时恢复）
- **批量操作** — 多选会话进行批量隐藏/恢复
- **新建对话** — 在任意本地文件夹中新建对话（带文件夹浏览器）
- **继续对话** — 在新终端窗口中恢复任意会话

## 界面预览

```
┌──────────────────────────────────────────────────────────────┐
│  MiMo & Grok Session Manager                                 │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐         │
│  │  12     │ │  35      │ │  4      │ │  8       │         │
│  │ 可见会话 │ │ 全部会话  │ │ 工作区  │ │ MiMo     │         │
│  └─────────┘ └──────────┘ └─────────┘ └──────────┘         │
│                                                              │
│  平台: [全部 ▾]  工作区: [全部 ▾]  排序: [最近更新 ▾]       │
│                                                              │
│  [x] 1  🔵 修复登录bug      /project-a   2025-07-20        │
│       [置顶] [重命名] [继续] [隐藏]                           │
│  [ ] 2  🟣 优化推理速度      /project-b   2025-07-19        │
│       [置顶] [重命名] [继续] [隐藏]                           │
└──────────────────────────────────────────────────────────────┘
```

## 环境要求

- **Node.js 20+**（[下载](https://nodejs.org/)）
- **MiMo Code** — 已安装且 `mimo.cmd` 在系统 PATH 中
- **Grok Build** — 已安装且位于 `~/.grok/bin/grok.exe`（可选，不安装也能用）
- 对应平台的会话数据可读

## 快速开始（Windows）

### 方式一：双击 start.bat

1. 下载或克隆本仓库
2. 在项目文件夹中打开终端
3. 运行：
   ```powershell
   npm install
   ```
4. 双击 `start.bat` — 自动启动服务器并打开浏览器

### 方式二：命令行

```powershell
# 克隆仓库
git clone https://github.com/S117-steven/mimo-grok-session-manager.git
cd mimo-grok-session-manager

# 安装依赖
npm install

# 启动服务
npm start
```

然后在浏览器中打开 **http://127.0.0.1:3456**

### 方式三：创建桌面快捷方式

```powershell
npm install
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
```

## 工作原理

1. 服务器分别读取 MiMo 的 SQLite 数据库和 Grok 的 `summary.json` 文件
2. 在 `http://127.0.0.1:3456` 提供统一的 Web 界面
3. 你可以在同一个列表中查看、排序、筛选两个平台的会话
4. 点击"继续"会在新终端中打开对应的 CLI 工具并恢复会话
5. 点击"新建对话"可以在任意文件夹中开始新会话

> **注意：** 本管理器仅读取会话数据。不会删除或破坏真实会话（隐藏操作完全可逆）。

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIMO_DB_PATH` | `%USERPROFILE%\.local\share\mimocode\mimocode.db` | MiMo SQLite 数据库路径 |
| `MIMO_COMMAND` | 自动检测（通过 `where mimo.cmd`） | `mimo.cmd` 的绝对路径 |
| `GROK_SESSIONS_DIR` | `%USERPROFILE%\.grok\sessions` | Grok 会话目录 |
| `MIMO_MANAGER_STATE_PATH` | `%USERPROFILE%\.local\share\mimo-session-manager\state.json` | 管理器偏好设置路径 |
| `PORT` | `3456` | 服务器端口 |

### 示例

```powershell
$env:MIMO_DB_PATH = "C:\自定义路径\mimocode.db"
npm start
```

## 安全说明

- 服务器仅监听 `127.0.0.1`，不支持局域网/互联网访问
- 未启用 CORS，POST 请求校验 `Origin` 头
- 会话 ID 严格校验
- "继续会话"从数据库/文件系统读取工作区目录，不接受客户端传入的路径
- 严格的 Content Security Policy (CSP) 头
- 所有动态内容通过 DOM API 渲染（无 `innerHTML`）

## 项目结构

```
mimo-grok-session-manager/
├── server.js            # Node.js HTTP 服务器 + API
├── app.js               # 前端 JavaScript
├── index.html           # Web 界面（单页应用）
├── grok-sessions.js     # Grok 会话读取/管理模块
├── package.json         # 依赖和脚本
├── start.bat            # Windows 启动器
├── create-shortcut.ps1  # 创建桌面快捷方式
├── LICENSE              # MIT 许可证
└── test/
    └── server.test.js   # 测试套件（含 MiMo + Grok）
```

## 开发

```powershell
# 语法检查
npm run check

# 运行测试
npm test

# 检查安全漏洞
npm audit
```

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | 关闭已有服务器进程，或设置 `PORT=3457` |
| MiMo 数据库读取失败 | 确认已安装 MiMo 且至少使用过一次 |
| Grok 会话不显示 | 确认 Grok Build 已安装且位于 `~/.grok/` |
| 提示 "mimo.cmd was not found" | 确保 MiMo CLI 在系统 PATH 中，或设置 `MIMO_COMMAND` |
| 无法继续会话 | 检查该会话的工作区目录是否仍然存在 |
| 浏览器显示空白页 | 确保已运行 `npm install` 且 `node_modules/` 存在 |

## 许可证

[MIT](LICENSE)

---

<a id="english"></a>

# MiMo & Grok Session Manager

A lightweight, local-only session manager for both **MiMo Code** and **Grok Build**. Manage conversations from both platforms in a single, clean browser UI.

## Features

- **Dual-platform** — Manage MiMo Code and Grok Build sessions side by side
- **Session List** — View all sessions with title, workspace, update time, and message count
- **Workspace Filter** — Filter sessions by project directory
- **Sorting** — Sort by update time, title, workspace, or custom order
- **Pin / Unpin** — Pin important sessions to the top
- **Rename** — Rename any session directly from the manager
- **Hide / Restore** — Hide clutter without deleting real sessions (reversible)
- **Batch Operations** — Select multiple sessions for bulk hide/restore
- **New Conversation** — Start a new session in any local folder (with folder browser)
- **Continue Session** — Resume any session in a new terminal window

## Requirements

- **Node.js 20+** ([download](https://nodejs.org/))
- **MiMo Code** — installed with `mimo.cmd` in your PATH
- **Grok Build** — installed at `~/.grok/bin/grok.exe` (optional; MiMo works without it)

## Quick Start (Windows)

```powershell
git clone https://github.com/S117-steven/mimo-grok-session-manager.git
cd mimo-grok-session-manager
npm install
npm start
```

Then open **http://127.0.0.1:3456** in your browser. Or double-click `start.bat`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MIMO_DB_PATH` | `%USERPROFILE%\.local\share\mimocode\mimocode.db` | MiMo SQLite database path |
| `MIMO_COMMAND` | auto-detected via `where mimo.cmd` | Absolute path to `mimo.cmd` |
| `GROK_SESSIONS_DIR` | `%USERPROFILE%\.grok\sessions` | Grok sessions directory |
| `MIMO_MANAGER_STATE_PATH` | `%USERPROFILE%\.local\share\mimo-session-manager\state.json` | Manager preferences path |
| `PORT` | `3456` | Server port |

## Security

- Server only listens on `127.0.0.1` — no LAN/internet access
- No CORS; POST requests validate `Origin` header
- Session IDs strictly validated
- "Continue session" reads workspace from database/filesystem, not user input
- Strict Content Security Policy (CSP)
- All dynamic content rendered via DOM API (no `innerHTML`)

## License

[MIT](LICENSE)
