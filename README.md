# Tmux

A graphical tmux workspace for Windows. Manage remote projects and terminals over SSH, with independently resizable terminal panes in a browser app window.

## Features

- Server sidebar, multiple projects, and draggable, closable tabs.
- Edit project names and paths from the context menu, or attach to existing tmux sessions.
- Independent font sizes per pane: Ctrl + mouse wheel to zoom, Ctrl + arrow keys to create splits.
- Text selection, clipboard shortcuts, and automatic scrolling at selection edges.
- Cross-screen selection in full-screen Codex: overlapping rows preserve selected text, a bounded wheel queue limits backlog, and continuous output does not postpone selection updates.
- SSH/WebSocket reconnection, output flow control, and liveness checks for SSH forwarding.
- A translucent light interface with a coastal background.

## Requirements

This version targets **Windows + WSL Ubuntu-22.04 + Microsoft Edge**. A cross-platform installer is not included.

1. Install Node.js (version 24 recommended), the OpenSSH client, and Edge on Windows.
2. Install the `Ubuntu-22.04` WSL distribution with `python3`, `tmux`, and `ssh`.
3. Remote Linux servers also need `python3` and `tmux`.
4. Configure SSH aliases and keys in `%USERPROFILE%\.ssh\config` on Windows. Verify that `ssh <alias>` works and complete host-key verification first. Background operations use noninteractive key authentication.

Example (replace with your own connection details):

```sshconfig
Host my-server
    HostName server.example.com
    User your-user
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 15
    ServerAliveCountMax 3
```

## Getting started

```powershell
git clone https://github.com/junkzhu/TmuxHub.git
cd TmuxHub
npm ci
npm start
```

The application listens on `127.0.0.1:18763` and opens `/launch`, which redirects to a page with temporary connection credentials. You can also double-click `launch.vbs` to hide the background console. The launcher expects Node at `%ProgramFiles%\nodejs\node.exe`.

The Edge executable path is currently set to `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. If your installation differs, update `openApp()` in `server.js`. The WSL distribution name is configured in `server.js` and `projects.cjs`.

Closing a tab or the app window disconnects the client while processes continue running in remote tmux sessions. This version does not guarantee process recovery after a server reboot.

## Selecting and copying text

Drag with the left mouse button to select text. Move to the top or bottom edge of a pane to scroll automatically, or use the wheel while holding the left mouse button. Ctrl+C copies when text is selected; otherwise, it retains the terminal interrupt behavior. Ctrl+Shift+C and Ctrl+Shift+V also copy and paste. Alt+mouse preserves interaction with terminal applications.

Full-screen applications redraw their own history. Cross-screen selection requires sufficient overlapping text between consecutive screens. Redraws that cannot be matched reliably are not stitched together. Scrolling is not pixel-smooth like a web page, and responsiveness depends on remote latency.

## Configuration and privacy

- `projects.json` is generated at runtime, stores personal project settings, and is excluded from Git.
- SSH configurations, private keys, login credentials, personal project lists, and terminal screenshots are not included in this repository.
- Server aliases ending in `-gateway` are hidden by default.
- `proxy-tunnel.js` and `proxy-watchdog.py` use forwarding settings from the existing SSH configuration. The current background warm-up aliases are `hpc` and `cislab` (see `server.js`); remove or adjust them if you use different aliases.
- `wsl-proxy-bridge.py` and `wsl-proxy-client.cjs` are optional tools for bridging WSL to a Windows local proxy, using Windows port 7890 by default. They do not exchange remote login keys.

## Tests

```powershell
npm test
```

Tests cover text selection, full-screen scroll queuing and direction reversal, cross-screen text retention, clipboard shortcuts, split boundaries, and proxy liveness checks. They use isolated mocks without connecting to personal servers or closing existing sessions.
