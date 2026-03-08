# ChatGPT Desktop MCP (Terminal + Filesystem)

This is a local MCP server that exposes desktop-style tools similar to DesktopCommander:

- `list_directory`
- `read_file`
- `write_file`
- `search_files`
- `run_command`

It uses Streamable HTTP MCP on:

- `POST/GET/DELETE /mcp`
- `GET /health`

## 1) Install

```powershell
cd "C:\path\to\chatgpt-desktop-mcp"
npm install
```

## 2) Run Local MCP Server

Start the server (keep this terminal open):

```powershell
$env:ALLOWED_ROOTS="*"
$env:APPROVAL_ENABLED="false"
$env:PORT="8787"
node .\src\server.js
```

Local MCP URL:

- `http://localhost:8787/mcp`

## 3) Create Temporary Public URL (Cloudflare)

Open a second terminal and run:

```powershell
cloudflared tunnel --protocol http2 --url http://localhost:8787
```

Copy the printed URL, then append `/mcp`:

- `https://<random>.trycloudflare.com/mcp`

## 4) Add to ChatGPT App

In the ChatGPT custom MCP form:

1. `MCP Server URL`: `https://<random>.trycloudflare.com/mcp`
2. `Authentication`: `None` (if available)
3. Create connector

## 5) Verify

Check health endpoints:

- Local: `http://localhost:8787/health`
- Public: `https://<random>.trycloudflare.com/health`

If public health shows a Cloudflare error page, restart the tunnel and use the new URL.

## Example Prompts

- `List files in C:\Projects\chatgpt-desktop-mcp`
- `Read file C:\Projects\chatgpt-desktop-mcp\README.md`
- `Run command "npm -v" in C:\Projects\chatgpt-desktop-mcp`
- `Write a file C:\Projects\chatgpt-desktop-mcp\notes.txt with content hello`

## Notes

- Filesystem access behavior depends on `ALLOWED_ROOTS`:
  - `ALLOWED_ROOTS=*` => unrestricted filesystem access
  - `ALLOWED_ROOTS="path1;path2"` => restricted mode
- Command execution uses a timeout (`DEFAULT_TIMEOUT_MS`, default 120000).
- Output is truncated (`MAX_OUTPUT_CHARS`, default 20000).
- Security guidance: see [SECURITY.md](SECURITY.md)

## Permission prompts (Allow once / Allow session / Deny)

Risky tools require approval by default:

- `run_command`
- `write_file`

When a call is waiting, open:

- `http://localhost:8787/approvals`

Approve with:

- `allow_once` - allow this single request
- `allow_session` - allow this tool for the current MCP session
- `deny` - reject

Config:

- `APPROVAL_ENABLED=true|false` (default `true`)
- `APPROVAL_TIMEOUT_MS=120000` (default 2 minutes, then auto-deny)

Full filesystem mode:

- `ALLOWED_ROOTS=*` for unrestricted access
- Or set specific roots, e.g. `C:\Projects;D:\Workspace`
