import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const execAsync = promisify(exec);

const PORT = Number(process.env.PORT || 8787);
const RAW_ALLOWED_ROOTS = (process.env.ALLOWED_ROOTS || "*").trim();
const UNRESTRICTED_FS = RAW_ALLOWED_ROOTS === "*";
const ALLOWED_ROOTS = UNRESTRICTED_FS
  ? []
  : RAW_ALLOWED_ROOTS.split(";")
      .map((p) => path.resolve(p.trim()))
      .filter(Boolean);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 120000);
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS || 20000);
const APPROVAL_ENABLED = process.env.APPROVAL_ENABLED !== "false";
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS || 120000);

const pendingApprovals = new Map();
const sessionAllowRules = new Set();

function isInsideAllowedRoots(absPath) {
  if (UNRESTRICTED_FS) {
    return true;
  }
  return ALLOWED_ROOTS.some((root) => {
    const relative = path.relative(root, absPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function resolveSafePath(inputPath) {
  const candidate = path.resolve(inputPath);
  if (!isInsideAllowedRoots(candidate)) {
    throw new Error(`Path is outside allowed roots: ${candidate}`);
  }
  return candidate;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function getSessionKey(sessionId) {
  return sessionId || "anonymous";
}

function makeApprovalSummary(toolName, args, sessionId) {
  if (toolName === "run_command") {
    return {
      tool: toolName,
      sessionId: sessionId || null,
      command: args.command,
      cwd: args.cwd || null,
      timeoutMs: args.timeoutMs || null
    };
  }
  if (toolName === "write_file") {
    return {
      tool: toolName,
      sessionId: sessionId || null,
      path: args.path,
      append: Boolean(args.append),
      contentLength: typeof args.content === "string" ? args.content.length : null
    };
  }
  return { tool: toolName, sessionId: sessionId || null };
}

async function requireApproval(toolName, args, sessionId) {
  if (!APPROVAL_ENABLED) {
    return;
  }
  if (!["run_command", "write_file"].includes(toolName)) {
    return;
  }

  const sessionKey = getSessionKey(sessionId);
  if (sessionAllowRules.has(`${sessionKey}:${toolName}`)) {
    return;
  }

  const approvalId = crypto.randomUUID();
  const request = {
    id: approvalId,
    status: "pending",
    createdAt: new Date().toISOString(),
    summary: makeApprovalSummary(toolName, args, sessionId)
  };

  const action = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve("deny");
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(approvalId, {
      ...request,
      resolve,
      timeout
    });
    console.log(
      `[APPROVAL REQUIRED] ${toolName} (${approvalId}) -> http://localhost:${PORT}/approvals`
    );
  });

  if (action === "allow_session") {
    sessionAllowRules.add(`${sessionKey}:${toolName}`);
    return;
  }
  if (action === "allow_once") {
    return;
  }

  throw new Error(`Permission denied for ${toolName}. Approval ID: ${approvalId}`);
}

function createServer() {
  const server = new McpServer(
    {
      name: "chatgpt-desktop-mcp",
      version: "1.0.0"
    },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "list_directory",
    {
      description: "List files and folders in a directory.",
      inputSchema: {
        path: z.string().describe("Directory path to list.")
      }
    },
    async ({ path: targetPath }) => {
      const safePath = resolveSafePath(targetPath);
      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const data = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({ path: safePath, entries: data }, null, 2) }]
      };
    }
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file.",
      inputSchema: {
        path: z.string().describe("File path."),
        offset: z.number().int().min(0).default(0).optional(),
        length: z.number().int().positive().max(200000).optional()
      }
    },
    async ({ path: targetPath, offset = 0, length }) => {
      const safePath = resolveSafePath(targetPath);
      const content = await fs.readFile(safePath, "utf8");
      const slice = length ? content.slice(offset, offset + length) : content.slice(offset);
      return {
        content: [{ type: "text", text: truncate(slice) }]
      };
    }
  );

  server.registerTool(
    "write_file",
    {
      description: "Write UTF-8 text to a file.",
      inputSchema: {
        path: z.string().describe("File path."),
        content: z.string().describe("Text to write."),
        append: z.boolean().default(false).optional()
      }
    },
    async ({ path: targetPath, content, append = false }, extra) => {
      await requireApproval(
        "write_file",
        { path: targetPath, content, append },
        extra?.sessionId
      );
      const safePath = resolveSafePath(targetPath);
      const parentDir = path.dirname(safePath);
      try {
        await fs.stat(parentDir);
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          await fs.mkdir(parentDir, { recursive: true });
        } else {
          throw error;
        }
      }
      if (append) {
        await fs.appendFile(safePath, content, "utf8");
      } else {
        await fs.writeFile(safePath, content, "utf8");
      }
      return {
        content: [{ type: "text", text: `Wrote ${content.length} chars to ${safePath}` }]
      };
    }
  );

  server.registerTool(
    "search_files",
    {
      description: "Search files by file name under a directory.",
      inputSchema: {
        rootPath: z.string().describe("Root folder to search."),
        nameIncludes: z.string().describe("Case-insensitive substring to match.")
      }
    },
    async ({ rootPath, nameIncludes }) => {
      const root = resolveSafePath(rootPath);
      const needle = nameIncludes.toLowerCase();
      const matches = [];

      async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (!isInsideAllowedRoots(full)) {
            continue;
          }
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.toLowerCase().includes(needle)) {
            matches.push(full);
          }
        }
      }

      await walk(root);
      return {
        content: [{ type: "text", text: JSON.stringify({ count: matches.length, matches }, null, 2) }]
      };
    }
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell command (one-shot) and return stdout/stderr.",
      inputSchema: {
        command: z.string().describe("Shell command to execute."),
        cwd: z.string().optional().describe("Working directory."),
        timeoutMs: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd, timeoutMs }, extra) => {
      await requireApproval(
        "run_command",
        { command, cwd, timeoutMs },
        extra?.sessionId
      );
      const safeCwd = cwd ? resolveSafePath(cwd) : (UNRESTRICTED_FS ? process.cwd() : ALLOWED_ROOTS[0]);
      const result = await execAsync(command, {
        cwd: safeCwd,
        timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = {
        cwd: safeCwd,
        command,
        stdout: truncate(result.stdout || ""),
        stderr: truncate(result.stderr || "")
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const transports = {};

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "chatgpt-desktop-mcp",
    message: "Use /mcp for MCP requests.",
    endpoints: ["/mcp", "/health", "/approvals"]
  });
});

app.get("/approvals", (_req, res) => {
  const pending = [...pendingApprovals.values()].map((item) => ({
    id: item.id,
    status: item.status,
    createdAt: item.createdAt,
    summary: item.summary
  }));
  res.json({
    ok: true,
    approvalEnabled: APPROVAL_ENABLED,
    timeoutMs: APPROVAL_TIMEOUT_MS,
    pending
  });
});

app.post("/approvals/:id", (req, res) => {
  const { id } = req.params;
  const action = req.body?.action;
  const allowedActions = new Set(["allow_once", "allow_session", "deny"]);
  if (!allowedActions.has(action)) {
    res.status(400).json({
      ok: false,
      error: "Invalid action",
      allowed: [...allowedActions]
    });
    return;
  }

  const approval = pendingApprovals.get(id);
  if (!approval) {
    res.status(404).json({
      ok: false,
      error: "Approval request not found"
    });
    return;
  }

  clearTimeout(approval.timeout);
  pendingApprovals.delete(id);
  approval.resolve(action);

  res.json({
    ok: true,
    id,
    action
  });
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        }
      });
      transport.onclose = () => {
        if (transport.sessionId && transports[transport.sessionId]) {
          delete transports[transport.sessionId];
        }
      };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid MCP session state." },
      id: null
    });
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
      id: null
    });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    transport: "streamable-http",
    endpoint: "/mcp",
    unrestrictedFs: UNRESTRICTED_FS,
    allowedRoots: UNRESTRICTED_FS ? ["*"] : ALLOWED_ROOTS,
    approvalEnabled: APPROVAL_ENABLED,
    approvalPendingCount: pendingApprovals.size
  });
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
    message: "Use /mcp for MCP requests."
  });
});

app.listen(PORT, () => {
  console.log(`chatgpt-desktop-mcp listening on http://localhost:${PORT}/mcp`);
  console.log(`Allowed roots: ${UNRESTRICTED_FS ? "*" : ALLOWED_ROOTS.join("; ")}`);
  console.log(`Approval mode: ${APPROVAL_ENABLED ? "enabled" : "disabled"}`);
  if (APPROVAL_ENABLED) {
    console.log(`Approve/Deny UI: http://localhost:${PORT}/approvals`);
  }
});
