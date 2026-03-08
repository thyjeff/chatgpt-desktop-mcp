# Security Notice

This MCP server can execute shell commands and read/write files on the host machine.

## High-risk capabilities

- `run_command` can execute arbitrary shell commands.
- `write_file` can create or modify files.
- `ALLOWED_ROOTS=*` grants full filesystem access.

## Safe publishing checklist

- Never commit `.env` or credentials.
- Keep `.gitignore` in place (`.env`, `*.log`, `node_modules`).
- Prefer restricted roots (`ALLOWED_ROOTS="D:\Projects"`) over `*`.
- Enable approval mode for risky tools in shared/public setups:
  - `APPROVAL_ENABLED=true`
  - `APPROVAL_TIMEOUT_MS=120000`

## Network exposure warning

If you expose this server through a public tunnel, anyone with access to the endpoint may be able to run tools depending on your connector/auth setup. Use private URLs and additional authentication controls.
