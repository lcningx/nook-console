import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4790),
  NOOK_CONSOLE_BASE_PATH: z.string().default("/console"),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  DEFAULT_CWD: z.string().default("/root/.workspace"),
  AGY_BIN: z.string().default("/root/.local/bin/agy"),
  MAX_TERMINALS: z.coerce.number().int().min(1).max(32).default(12),
  NOOK_CONSOLE_AUTH_SECRET: z.string().default("nook-console-dev-secret-change-in-production"),
  NOOK_CONSOLE_SSO_TOKEN: z.string().optional(),
  NOOK_CONSOLE_PASSWORD: z.string().optional(),
  NOOK_CONSOLE_FALLBACK_NOOK_DB: z.string().optional(),
});

export interface ConsoleConfig {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  basePath: string;
  dataDir: string;
  dbPath: string;
  defaultCwd: string;
  agyBin: string;
  maxTerminals: number;
  authSecret: string;
  ssoToken: string | null;
  explicitPassword: string | null;
  fallbackNookDbPath: string | null;
}

export function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function loadConfig(): ConsoleConfig {
  const parsed = EnvSchema.parse(process.env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  const basePath = normalizeBasePath(parsed.NOOK_CONSOLE_BASE_PATH);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    basePath,
    dataDir,
    dbPath: path.join(dataDir, "nookconsole.sqlite"),
    defaultCwd: path.resolve(parsed.DEFAULT_CWD),
    agyBin: parsed.AGY_BIN,
    maxTerminals: parsed.MAX_TERMINALS,
    authSecret: parsed.NOOK_CONSOLE_AUTH_SECRET,
    ssoToken: parsed.NOOK_CONSOLE_SSO_TOKEN?.trim() || null,
    explicitPassword: parsed.NOOK_CONSOLE_PASSWORD?.trim() || null,
    fallbackNookDbPath: parsed.NOOK_CONSOLE_FALLBACK_NOOK_DB?.trim()
      ? path.resolve(parsed.NOOK_CONSOLE_FALLBACK_NOOK_DB.trim())
      : null,
  };
}
