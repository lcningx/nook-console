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

export const BASE_PATH = (import.meta.env.BASE_URL || "/console/").replace(/\/+$/, "");

async function reqJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_PATH}${url}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export const consoleApi = {
  me: () => reqJson<{ authenticated: boolean; defaultCwd: string }>("/api/auth/me"),
  login: (password: string) =>
    reqJson<{ authenticated: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => reqJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  listTerminals: () =>
    reqJson<{ terminals: TerminalSessionSummary[]; defaultCwd: string }>("/api/terminals"),
  createTerminal: (params?: {
    title?: string;
    cwd?: string;
    preset?: TerminalPreset;
    cols?: number;
    rows?: number;
  }) =>
    reqJson<{ terminal: TerminalSessionSummary }>("/api/terminals", {
      method: "POST",
      body: JSON.stringify(params ?? {}),
    }),
  renameTerminal: (id: string, title: string) =>
    reqJson<{ terminal: TerminalSessionSummary }>(`/api/terminals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  restartTerminal: (id: string) =>
    reqJson<{ terminal: TerminalSessionSummary }>(
      `/api/terminals/${encodeURIComponent(id)}/restart`,
      { method: "POST" },
    ),
  closeTerminal: (id: string) =>
    reqJson<{ ok: boolean }>(`/api/terminals/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

export function buildTerminalWsUrl(id: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BASE_PATH}/ws/${encodeURIComponent(id)}`;
}
