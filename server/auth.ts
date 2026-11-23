import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SSO_TICKET_TTL_MS = 45 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 12;

export const CONSOLE_AUTH_COOKIE = "nook_console_session";

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, "hex");
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function timingSafeEqualsText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readNookFallbackPasswordHash(nookDbPath: string | null): string | null {
  if (!nookDbPath || !fs.existsSync(nookDbPath)) return null;
  let roDb: DatabaseSync | null = null;
  try {
    roDb = new DatabaseSync(nookDbPath, { readOnly: true });
    const row = roDb
      .prepare("SELECT password_hash FROM admin_credentials WHERE id = 1")
      .get() as { password_hash?: string } | undefined;
    if (typeof row?.password_hash === "string" && row.password_hash.includes(":")) {
      return row.password_hash;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      roDb?.close();
    } catch {
      // ignore
    }
  }
}

export interface ConsoleAuthOptions {
  dataDir: string;
  ssoToken: string | null;
  explicitPassword: string | null;
  fallbackNookDbPath: string | null;
}

export class ConsoleAuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly ssoTickets = new Map<string, number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: ConsoleAuthOptions,
  ) {
    this.ensureAdminCredential();
  }

  private ensureAdminCredential(): void {
    const existing = this.db
      .prepare("SELECT password_hash FROM admin_credentials WHERE id = 1")
      .get() as { password_hash: string } | undefined;

    const now = Date.now();
    // If operator sets NOOK_CONSOLE_PASSWORD in env, keep DB synced to it
    if (this.options.explicitPassword && this.options.explicitPassword.length >= 4) {
      if (!existing || !verifyPassword(this.options.explicitPassword, existing.password_hash)) {
        const nextHash = hashPassword(this.options.explicitPassword);
        this.db
          .prepare(
            `INSERT INTO admin_credentials (id, password_hash, source, created_at, updated_at)
             VALUES (1, ?, 'env', ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               password_hash = excluded.password_hash,
               source = 'env',
               updated_at = excluded.updated_at`,
          )
          .run(nextHash, now, now);
      }
      return;
    }

    if (existing) return;

    // First-boot default: copy Nook's scrypt hash once so user has one familiar rescue password,
    // stored independently in nookconsole.sqlite (zero runtime dependency on nook.sqlite).
    const copiedHash = readNookFallbackPasswordHash(this.options.fallbackNookDbPath);
    if (copiedHash) {
      this.db
        .prepare(
          "INSERT INTO admin_credentials (id, password_hash, source, created_at, updated_at) VALUES (1, ?, 'nook_copy', ?, ?)",
        )
        .run(copiedHash, now, now);
      return;
    }

    // Standalone fallback: generate random initial password
    const pwd = crypto.randomBytes(9).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO admin_credentials (id, password_hash, source, created_at, updated_at) VALUES (1, ?, 'generated', ?, ?)",
      )
      .run(hashPassword(pwd), now, now);
    fs.mkdirSync(this.options.dataDir, { recursive: true });
    fs.writeFileSync(path.join(this.options.dataDir, "initial-password.txt"), `${pwd}\n`, {
      mode: 0o600,
    });
  }

  private createSessionToken(): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(hashToken(token), now, now + SESSION_TTL_MS, now);
    return token;
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now >= rec.resetAt) return { allowed: true };
    if (rec.count >= MAX_ATTEMPTS) {
      return { allowed: false, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
    }
    return { allowed: true };
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now >= rec.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      rec.count += 1;
    }
  }

  login(
    password: string,
    ip: string,
  ): { ok: true; token: string } | { ok: false; error: string; status: number } {
    const rl = this.checkRateLimit(ip);
    if (!rl.allowed) {
      return {
        ok: false,
        error: `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`,
        status: 429,
      };
    }
    const row = this.db
      .prepare("SELECT password_hash FROM admin_credentials WHERE id = 1")
      .get() as { password_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      this.recordFailure(ip);
      return { ok: false, error: "口令不正确", status: 401 };
    }
    this.attempts.delete(ip);
    return { ok: true, token: this.createSessionToken() };
  }

  verifySsoBearer(authHeader: string | undefined): boolean {
    if (!this.options.ssoToken || !authHeader) return false;
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) return false;
    return timingSafeEqualsText(match[1].trim(), this.options.ssoToken);
  }

  mintSsoTicket(): string {
    const now = Date.now();
    for (const [k, exp] of this.ssoTickets) {
      if (exp <= now) this.ssoTickets.delete(k);
    }
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.ssoTickets.set(ticket, now + SSO_TICKET_TTL_MS);
    return ticket;
  }

  consumeSsoTicket(ticket: string | undefined): string | null {
    if (!ticket) return null;
    const exp = this.ssoTickets.get(ticket);
    this.ssoTickets.delete(ticket);
    if (!exp || exp <= Date.now()) return null;
    return this.createSessionToken();
  }

  verifySession(token: string | undefined): boolean {
    if (!token) return false;
    const now = Date.now();
    const tHash = hashToken(token);
    const row = this.db
      .prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?")
      .get(tHash) as { expires_at: number } | undefined;
    if (!row) return false;
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tHash);
      return false;
    }
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(now, now + SESSION_TTL_MS, tHash);
    return true;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
  }
}
