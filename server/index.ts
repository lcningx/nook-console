import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { CONSOLE_AUTH_COOKIE, ConsoleAuthService } from "./auth.js";
import { TerminalManager } from "./terminal-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WsClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(400),
    rows: z.number().int().min(4).max(200),
  }),
]);

function sanitizeRedirectTarget(rawTo: string | undefined, basePath: string): string {
  const defaultTarget = basePath ? `${basePath}/` : "/";
  if (!rawTo) return defaultTarget;
  const trimmed = rawTo.trim();
  if (!trimmed || trimmed.startsWith("//") || /^https?:/i.test(trimmed)) {
    return defaultTarget;
  }
  if (basePath && (trimmed === basePath || trimmed.startsWith(`${basePath}/`) || trimmed.startsWith(`${basePath}?`))) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `${basePath}${trimmed}`;
  }
  if (trimmed.startsWith("?")) {
    return `${defaultTarget}${trimmed}`;
  }
  return defaultTarget;
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const auth = new ConsoleAuthService(db, {
    dataDir: config.dataDir,
    ssoToken: config.ssoToken,
    explicitPassword: config.explicitPassword,
    fallbackNookDbPath: config.fallbackNookDbPath,
  });
  const terminals = new TerminalManager({
    defaultCwd: config.defaultCwd,
    agyBin: config.agyBin,
    maxTerminals: config.maxTerminals,
  });

  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.authSecret });
  await app.register(websocket);

  const prefix = config.basePath; // e.g. "/console" or ""
  const cookiePath = prefix || "/";

  const requireAuth = async (
    req: { cookies: Record<string, string | undefined> },
    reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  ) => {
    if (!auth.verifySession(req.cookies[CONSOLE_AUTH_COOKIE])) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

  // === Health ===
  app.get(`${prefix}/api/health`, async () => ({
    ok: true,
    service: "nook-console",
    basePath: prefix,
    terminals: terminals.listSessions().length,
  }));

  // === Auth ===
  app.get(`${prefix}/api/auth/me`, async (req) => ({
    authenticated: auth.verifySession(req.cookies[CONSOLE_AUTH_COOKIE]),
    defaultCwd: config.defaultCwd,
  }));

  app.post(`${prefix}/api/auth/login`, async (req, reply) => {
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请输入口令" });
    }
    const res = auth.login(parsed.data.password, req.ip);
    if (!res.ok) {
      return reply.code(res.status).send({ error: res.error });
    }
    const isSecure = config.nodeEnv === "production" || req.protocol === "https";
    reply.setCookie(CONSOLE_AUTH_COOKIE, res.token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      path: cookiePath,
      maxAge: 30 * 24 * 60 * 60,
    });
    return { authenticated: true };
  });

  app.post(`${prefix}/api/auth/logout`, async (req, reply) => {
    auth.logout(req.cookies[CONSOLE_AUTH_COOKIE]);
    reply.clearCookie(CONSOLE_AUTH_COOKIE, { path: cookiePath });
    return { ok: true };
  });

  // Internal SSO ticket minting (called by Nook backend over loopback with Bearer token)
  app.post(`${prefix}/api/auth/sso-ticket`, async (req, reply) => {
    if (!auth.verifySsoBearer(req.headers.authorization)) {
      return reply.code(401).send({ ok: false, error: "Unauthorized SSO caller" });
    }
    const ticket = auth.mintSsoTicket();
    return { ok: true, ticket };
  });

  // Browser SSO ticket exchange -> sets HttpOnly session cookie & redirects cleanly
  app.get(`${prefix}/api/auth/sso`, async (req, reply) => {
    const query = req.query as { ticket?: string; to?: string };
    const token = auth.consumeSsoTicket(query.ticket);
    const target = sanitizeRedirectTarget(query.to, prefix);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    if (token) {
      const isSecure = config.nodeEnv === "production" || req.protocol === "https";
      reply.setCookie(CONSOLE_AUTH_COOKIE, token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: "lax",
        path: cookiePath,
        maxAge: 30 * 24 * 60 * 60,
      });
    }
    return reply.redirect(target);
  });

  // === Terminal REST API ===
  app.get(`${prefix}/api/terminals`, { preHandler: requireAuth }, async () => {
    return { terminals: terminals.listSessions(), defaultCwd: config.defaultCwd };
  });

  app.post(`${prefix}/api/terminals`, { preHandler: requireAuth }, async (req, reply) => {
    const parsed = z
      .object({
        title: z.string().max(48).optional(),
        cwd: z.string().max(512).optional(),
        preset: z.enum(["shell", "agy", "nook-logs"]).optional(),
        cols: z.number().int().min(10).max(400).optional(),
        rows: z.number().int().min(4).max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "无效的终端参数" });
    }
    try {
      const session = terminals.createSession(parsed.data);
      return { terminal: session };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "创建终端失败" });
    }
  });

  app.patch(`${prefix}/api/terminals/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ title: z.string().min(1).max(48) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "名称不能为空" });
    }
    const updated = terminals.renameSession(id, parsed.data.title);
    if (!updated) {
      return reply.code(404).send({ error: "终端不存在" });
    }
    return { terminal: updated };
  });

  app.post(`${prefix}/api/terminals/:id/restart`, { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restarted = terminals.restartSession(id);
    if (!restarted) {
      return reply.code(404).send({ error: "终端不存在" });
    }
    return { terminal: restarted };
  });

  app.delete(`${prefix}/api/terminals/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!terminals.closeSession(id)) {
      return reply.code(404).send({ error: "终端不存在" });
    }
    return { ok: true };
  });

  // === Terminal WebSocket ===
  app.get(`${prefix}/ws/:id`, { websocket: true }, (socket, req) => {
    if (!auth.verifySession(req.cookies[CONSOLE_AUTH_COOKIE])) {
      socket.close(4401, "Unauthorized");
      return;
    }
    const { id } = req.params as { id: string };
    if (!terminals.attachClient(id, socket)) {
      socket.close(4404, "Terminal not found");
      return;
    }

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const text = Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.from(raw).toString("utf8");
        const parsed = WsClientFrameSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.type === "ping") {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "pong" }));
          }
        } else if (msg.type === "input") {
          terminals.writeInput(id, msg.data);
        } else if (msg.type === "resize") {
          terminals.resize(id, msg.cols, msg.rows);
        }
      } catch {
        // ignore malformed frames
      }
    });
  });

  // === Static Web Hosting ===
  const webDist = path.resolve(__dirname, "../web");
  if (fs.existsSync(webDist)) {
    const staticPrefix = prefix ? `${prefix}/` : "/";
    if (prefix) {
      app.get(prefix, async (_req, reply) => reply.redirect(`${prefix}/`));
    }
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: staticPrefix,
      wildcard: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith(`${prefix}/api/`) ||
        req.url.startsWith(`${prefix}/ws/`) ||
        req.url.startsWith(`${prefix}/assets/`)
      ) {
        return reply.code(404).send({ error: "Not found" });
      }
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return reply.sendFile("index.html");
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info("Shutting down Nook Console...");
    terminals.shutdownAll();
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Nook Console listening on http://${config.host}:${config.port}${prefix || "/"}`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
