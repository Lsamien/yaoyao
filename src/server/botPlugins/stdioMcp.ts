// Adapted from OpenMausBot server/stdio-mcp.ts (Apache-2.0).
// Shared raw MCP transport. Keep this module Node-only: the Pi extension
// imports a shipped source copy from an external agent process.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  scope?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Content remains opaque here so images, audio, resource links, embedded
 * files, annotations and structured output survive the engine boundary. */
export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** A valid JSON-RPC refusal is not a broken subprocess/transport. */
export class McpRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.code = code; }
}

export interface StdioMcpOptions {
  onRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  /** A complete inherited environment, before the explicitly granted env. */
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  /** Harness leases own and reap a dedicated group. Pi leaves its children
   * in Pi's existing group so killing Pi still kills all of its tools. */
  ownProcessGroup?: boolean;
}

const MCP_STARTUP_TIMEOUT_MS = 8_000;
const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;
const MCP_MAX_LIST_PAGES = 100;
const MCP_MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Newline-delimited JSON-RPC 2.0, the transport used by the harness proxies. */
export class StdioMcp {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private disposed = false;
  private closed: Promise<void>;
  private shutdownTimer?: ReturnType<typeof setTimeout>;
  private clientName: string;
  private ownsProcessGroup: boolean;
  private options: StdioMcpOptions;
  private inbound = new Map<string | number, AbortController>();
  capabilities: Record<string, unknown> = {};
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(def: McpServerDef, options: StdioMcpOptions = {}) {
    this.options = options;
    this.clientName = options.clientName ?? "yaoyao-bot-plugins";
    this.ownsProcessGroup = options.ownProcessGroup === true;
    this.child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...(options.env ?? process.env), ...def.env },
      ...(process.platform === "win32" ? { windowsHide: true } : this.ownsProcessGroup ? { detached: true } : {}),
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", () => {
        // A proxy can exit while one of its children is still running. Kill
        // its dedicated group before relinquishing the lease.
        this.killTree("SIGKILL");
        if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
        resolve();
      });
    });
    this.child.stderr.on("data", () => { /* drain without exposing secrets */ });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (error) => this.closeWithError(error));
    this.child.on("exit", (code) => this.closeWithError(new Error(`MCP server exited (code ${code ?? "?"})`)));
    this.child.stdin.on("error", () => this.closeWithError(new Error("MCP server stdin closed")));
  }

  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) { try { this.child.kill(signal); } catch { /* already gone */ } }
      });
      return;
    }
    try {
      if (this.ownsProcessGroup) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch { /* process group already gone */ }
  }

  private closeWithError(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    this.killTree("SIGTERM");
    this.shutdownTimer = setTimeout(() => this.killTree("SIGKILL"), 500);
    this.shutdownTimer.unref();
  }

  private onData(chunk: string): void {
    if (this.disposed) return;
    this.buf += chunk;
    let newline: number;
    while ((newline = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, newline).trim();
      this.buf = this.buf.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) {
        this.closeWithError(new Error("MCP frame exceeded the size limit"));
        return;
      }
      let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== "object") continue;
      if (!message.method && typeof message.id === "number" && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new McpRpcError(message.error.message ?? "MCP error", message.error.code ?? -32603));
        else entry.resolve(message.result);
      } else if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string") {
        const { id, method, params } = message;
        const controller = new AbortController();
        if (this.inbound.has(id)) continue;
        this.inbound.set(id, controller);
        const timer = setTimeout(() => controller.abort(), MCP_TOOL_TIMEOUT_MS);
        timer.unref();
        void Promise.resolve().then(() => {
          if (!this.options.onRequest) throw new Error("Client method not supported");
          const aborted = new Promise<never>((_, reject) => {
            if (controller.signal.aborted) reject(new Error("MCP request cancelled"));
            else controller.signal.addEventListener("abort", () => reject(new Error("MCP request cancelled")), { once: true });
          });
          return Promise.race([this.options.onRequest(method, params, controller.signal), aborted]);
        }).then(result => {
          if (!this.disposed && !controller.signal.aborted) this.write({ jsonrpc: "2.0", id, result });
        }, () => {
          if (!this.disposed) this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "客户端请求被拒绝或不可用" } });
        }).catch(() => {}).finally(() => { clearTimeout(timer); this.inbound.delete(id); });
      } else if (typeof message.method === "string") {
        if (message.method === "notifications/cancelled") {
          const id = (message.params as { requestId?: string | number } | undefined)?.requestId;
          if (id !== undefined) this.inbound.get(id)?.abort();
        }
        try { this.options.onNotification?.(message.method, message.params); } catch { /* observers cannot break transport */ }
      }
    }
    if (Buffer.byteLength(this.buf, "utf8") > MCP_MAX_FRAME_BYTES) {
      this.closeWithError(new Error("MCP frame exceeded the size limit without a newline"));
    }
  }

  private write(frame: unknown): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("MCP server stdin is closed");
    }
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private call(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new Error(`MCP ${method} aborted`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        complete();
      };
      const cancel = (reason: string) => {
        this.pending.delete(id);
        try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }); } catch { /* closed */ }
        settle(() => reject(new Error(reason)));
      };
      const onAbort = () => cancel(`MCP ${method} aborted`);
      const timer = setTimeout(() => cancel(`MCP ${method} timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        this.pending.delete(id);
        settle(() => reject(error));
      }
    });
  }

  async init(signal?: AbortSignal): Promise<void> {
    const result = await this.call("initialize", {
      protocolVersion: "2025-06-18", capabilities: this.options.onRequest ? { sampling: {}, elicitation: { form: {} } } : {}, clientInfo: { name: this.clientName, version: "1" },
    }, MCP_STARTUP_TIMEOUT_MS, signal) as { capabilities?: Record<string, unknown> };
    this.capabilities = result?.capabilities ?? {};
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (!this.capabilities.tools && (this.capabilities.resources || this.capabilities.prompts)) return [];
    const tools: McpTool[] = [];
    const seenCursors = new Set<string>();
    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page++) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, Math.max(1, deadline - Date.now()), signal) as
        { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list returned no tools array");
      for (const tool of result.tools) {
        if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) {
          throw new Error("MCP tools/list returned an invalid tool");
        }
        tools.push(tool as McpTool);
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return tools;
      if (seenCursors.has(result.nextCursor)) throw new Error("MCP tools/list repeated a pagination cursor");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MCP_MAX_LIST_PAGES} pages`);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    const result = await this.call("tools/call", { name, arguments: args ?? {} }, MCP_TOOL_TIMEOUT_MS, signal);
    if (!result || typeof result !== "object" || !Array.isArray((result as McpToolResult).content)) {
      throw new Error("MCP tools/call returned an invalid result");
    }
    return result as McpToolResult;
  }

  /** Capability-specific resources and prompts use the same owned transport. */
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.call(method, params, MCP_TOOL_TIMEOUT_MS, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP returned an invalid result");
    return value as Record<string, unknown>;
  }

  /** Synchronous revocation; waitClosed also waits for the process tree. */
  dispose(): void { this.closeWithError(new Error("MCP client disposed")); }
  async waitClosed(): Promise<void> { await this.closed; }
}
