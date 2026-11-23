import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_RING_BYTES = 128 * 1024;

export type TerminalPreset = "shell" | "agy" | "nook-logs";

export interface TerminalSessionSummary {
  id: string;
  title: string;
  cwd: string;
  preset: TerminalPreset;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  lastActivityAt: number;
  clientCount: number;
}

export interface WsSocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface TerminalSessionEntry {
  id: string;
  title: string;
  cwd: string;
  preset: TerminalPreset;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  lastActivityAt: number;
  child: ChildProcessWithoutNullStreams | null;
  ringChunks: Buffer[];
  ringBytes: number;
  clients: Set<WsSocketLike>;
}

export interface TerminalManagerOptions {
  defaultCwd: string;
  agyBin: string;
  maxTerminals: number;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSessionEntry>();
  private readonly bridgeScriptPath: string;
  private readonly shellInitPath: string;
  private counter = 0;

  constructor(private readonly options: TerminalManagerOptions) {
    const localBridge = path.join(__dirname, "pty-bridge.py");
    const fallbackBridge = path.resolve(process.cwd(), "server/pty-bridge.py");
    this.bridgeScriptPath = fs.existsSync(localBridge) ? localBridge : fallbackBridge;

    const localInit = path.join(__dirname, "shell-init.sh");
    const fallbackInit = path.resolve(process.cwd(), "server/shell-init.sh");
    this.shellInitPath = fs.existsSync(localInit) ? localInit : fallbackInit;
  }

  private resolveSafeCwd(rawCwd?: string): string {
    if (rawCwd && rawCwd.trim()) {
      const candidate = path.resolve(rawCwd.trim());
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // fallback below
      }
    }
    try {
      if (fs.statSync(this.options.defaultCwd).isDirectory()) {
        return this.options.defaultCwd;
      }
    } catch {
      // fallback below
    }
    return os.homedir();
  }

  private resolvePresetCommand(preset: TerminalPreset): { cmd: string[]; defaultTitle: string } {
    if (preset === "agy") {
      const agyBin = fs.existsSync(this.options.agyBin) ? this.options.agyBin : "agy";
      return { cmd: [agyBin], defaultTitle: "agy" };
    }
    if (preset === "nook-logs") {
      return {
        cmd: ["journalctl", "-u", "nook.service", "-n", "100", "-f", "--no-pager"],
        defaultTitle: "nook 日志",
      };
    }
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
    const shellName = path.basename(shell);
    if (shellName === "bash" && fs.existsSync(this.shellInitPath)) {
      return { cmd: [shell, "--rcfile", this.shellInitPath, "-i"], defaultTitle: shellName };
    }
    return { cmd: [shell, "-l"], defaultTitle: shellName };
  }

  private toSummary(entry: TerminalSessionEntry): TerminalSessionSummary {
    return {
      id: entry.id,
      title: entry.title,
      cwd: entry.cwd,
      preset: entry.preset,
      cols: entry.cols,
      rows: entry.rows,
      status: entry.status,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      clientCount: entry.clients.size,
    };
  }

  listSessions(): TerminalSessionSummary[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this.toSummary(entry));
  }

  getSession(id: string): TerminalSessionSummary | null {
    const entry = this.sessions.get(id);
    return entry ? this.toSummary(entry) : null;
  }

  createSession(params?: {
    title?: string;
    cwd?: string;
    preset?: TerminalPreset;
    cols?: number;
    rows?: number;
  }): TerminalSessionSummary {
    if (this.sessions.size >= this.options.maxTerminals) {
      throw new Error(`最多同时打开 ${this.options.maxTerminals} 个终端，请先关闭闲置标签。`);
    }
    const preset: TerminalPreset = params?.preset ?? "shell";
    const cwd = this.resolveSafeCwd(params?.cwd);
    const cols = Math.max(20, Math.min(400, Math.round(params?.cols ?? 100)));
    const rows = Math.max(5, Math.min(200, Math.round(params?.rows ?? 30)));
    const { defaultTitle } = this.resolvePresetCommand(preset);
    this.counter += 1;

    const id = crypto.randomBytes(4).toString("hex");
    const title =
      params?.title?.trim() ||
      (preset === "shell" ? `${defaultTitle} ${this.counter}` : defaultTitle);
    const now = Date.now();

    const entry: TerminalSessionEntry = {
      id,
      title: title.slice(0, 48),
      cwd,
      preset,
      cols,
      rows,
      status: "running",
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      child: null,
      ringChunks: [],
      ringBytes: 0,
      clients: new Set(),
    };

    this.sessions.set(id, entry);
    this.spawnBridge(entry);
    return this.toSummary(entry);
  }

  private spawnBridge(entry: TerminalSessionEntry): void {
    const { cmd } = this.resolvePresetCommand(entry.preset);
    const child = spawn(
      "python3",
      [
        this.bridgeScriptPath,
        "--cols",
        String(entry.cols),
        "--rows",
        String(entry.rows),
        "--cwd",
        entry.cwd,
        "--cmd",
        JSON.stringify(cmd),
      ],
      {
        cwd: entry.cwd,
        env: {
          ...process.env,
          HOME: process.env.HOME || os.homedir(),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    entry.child = child;
    entry.status = "running";
    entry.exitCode = null;
    entry.lastActivityAt = Date.now();

    child.stdout.on("data", (chunk: Buffer) => {
      if (entry.child !== child) return;
      this.appendOutput(entry, chunk);
      this.broadcastJson(entry, {
        type: "output",
        data: chunk.toString("base64"),
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (entry.child !== child) return;
      this.appendOutput(entry, chunk);
      this.broadcastJson(entry, {
        type: "output",
        data: chunk.toString("base64"),
      });
    });

    child.on("exit", (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      entry.status = "exited";
      entry.exitCode = typeof code === "number" ? code : signal ? 128 : 0;
      entry.lastActivityAt = Date.now();
      this.broadcastJson(entry, {
        type: "exit",
        exitCode: entry.exitCode,
      });
    });

    child.on("error", (err) => {
      if (entry.child !== child) return;
      const errBuf = Buffer.from(`\r\n[Nook Console] 无法启动进程: ${err.message}\r\n`, "utf8");
      this.appendOutput(entry, errBuf);
      this.broadcastJson(entry, { type: "output", data: errBuf.toString("base64") });
      entry.child = null;
      entry.status = "exited";
      entry.exitCode = 1;
      this.broadcastJson(entry, { type: "exit", exitCode: 1 });
    });
  }

  private appendOutput(entry: TerminalSessionEntry, chunk: Buffer): void {
    entry.lastActivityAt = Date.now();
    entry.ringChunks.push(chunk);
    entry.ringBytes += chunk.length;
    while (entry.ringBytes > MAX_RING_BYTES && entry.ringChunks.length > 1) {
      const removed = entry.ringChunks.shift();
      if (removed) {
        entry.ringBytes -= removed.length;
      }
    }
    if (entry.ringBytes > MAX_RING_BYTES && entry.ringChunks.length === 1) {
      const single = entry.ringChunks[0];
      entry.ringChunks[0] = single.subarray(single.length - MAX_RING_BYTES);
      entry.ringBytes = entry.ringChunks[0].length;
    }
  }

  private sendControl(entry: TerminalSessionEntry, payload: Record<string, unknown>): void {
    if (!entry.child || entry.status !== "running" || !entry.child.stdin.writable) return;
    try {
      entry.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // ignore broken pipe during shutdown
    }
  }

  private broadcastJson(entry: TerminalSessionEntry, msg: Record<string, unknown>): void {
    if (entry.clients.size === 0) return;
    const raw = JSON.stringify(msg);
    for (const ws of entry.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(raw);
        } catch {
          // ignore
        }
      }
    }
  }

  attachClient(id: string, ws: WsSocketLike): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    entry.clients.add(ws);

    // Replay ring buffer immediately so reconnecting/switching tabs restores full screen
    const replayBuf = entry.ringChunks.length > 0 ? Buffer.concat(entry.ringChunks) : null;
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ready",
          session: this.toSummary(entry),
          replay: replayBuf ? replayBuf.toString("base64") : "",
        }),
      );
    }

    ws.on("close", () => {
      entry.clients.delete(ws);
    });
    return true;
  }

  writeInput(id: string, text: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry || entry.status !== "running") return false;
    entry.lastActivityAt = Date.now();
    this.sendControl(entry, {
      t: "i",
      d: Buffer.from(text, "utf8").toString("base64"),
    });
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    const nextCols = Math.max(10, Math.min(400, Math.round(cols)));
    const nextRows = Math.max(4, Math.min(200, Math.round(rows)));
    if (entry.cols === nextCols && entry.rows === nextRows) return true;
    entry.cols = nextCols;
    entry.rows = nextRows;
    this.sendControl(entry, { t: "r", c: nextCols, r: nextRows });
    return true;
  }

  renameSession(id: string, title: string): TerminalSessionSummary | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    const clean = title.trim().slice(0, 48);
    if (clean) {
      entry.title = clean;
    }
    return this.toSummary(entry);
  }

  restartSession(id: string): TerminalSessionSummary | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    this.killChild(entry);
    entry.ringChunks = [];
    entry.ringBytes = 0;
    this.spawnBridge(entry);
    this.broadcastJson(entry, {
      type: "restarted",
      session: this.toSummary(entry),
    });
    return this.toSummary(entry);
  }

  closeSession(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    this.sessions.delete(id);
    this.killChild(entry);
    for (const ws of Array.from(entry.clients)) {
      try {
        ws.close(1000, "Terminal closed");
      } catch {
        // ignore
      }
    }
    entry.clients.clear();
    return true;
  }

  private killChild(entry: TerminalSessionEntry): void {
    const child = entry.child;
    if (!child) return;
    entry.child = null;
    try {
      child.stdin.write(`${JSON.stringify({ t: "k", s: "TERM" })}\n`);
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1500);
    timer.unref();
  }

  shutdownAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.closeSession(id);
    }
  }
}
