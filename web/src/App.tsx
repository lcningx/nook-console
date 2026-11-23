import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ClipboardPaste,
  ExternalLink,
  FolderOpen,
  LogOut,
  Moon,
  Palette,
  Plus,
  ScrollText,
  Send,
  Sparkles,
  Sun,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  BASE_PATH,
  consoleApi,
  type TerminalPreset,
  type TerminalSessionSummary,
} from "./api";
import { TerminalView, type TerminalViewHandle } from "./terminal-view";

function isEmbeddedInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getInitialTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function basenameOf(p: string | null | undefined): string {
  if (!p) return "";
  const clean = p.replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

type TerminalPalettePref = "auto" | "dark" | "light";

function loadTerminalPalettePref(): TerminalPalettePref {
  try {
    const saved = window.localStorage.getItem("nook-console:term-palette");
    if (saved === "dark" || saved === "light" || saved === "auto") return saved;
  } catch {
    // ignore
  }
  return "dark";
}

function paletteLabel(pref: TerminalPalettePref): string {
  if (pref === "dark") return "Tokyo Night";
  if (pref === "light") return "Latte 浅色";
  return "跟随主题";
}

function nextPalettePref(pref: TerminalPalettePref): TerminalPalettePref {
  if (pref === "dark") return "light";
  if (pref === "light") return "auto";
  return "dark";
}

export function App() {
  const embedded = useMemo(() => isEmbeddedInIframe(), []);
  const initialQueryCwd = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("cwd")?.trim() || null;
  }, []);

  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const [themeMode, setThemeMode] = useState<"light" | "dark">(getInitialTheme);
  const [termPalettePref, setTermPalettePref] = useState<TerminalPalettePref>(
    loadTerminalPalettePref,
  );
  const [defaultCwd, setDefaultCwd] = useState("/root/.workspace");
  const [hostCwd, setHostCwd] = useState<string | null>(initialQueryCwd);
  const [terminals, setTerminals] = useState<TerminalSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [termSizes, setTermSizes] = useState<Record<string, { cols: number; rows: number }>>({});
  const [ctrlActive, setCtrlActive] = useState(false);

  const terminalSurface: "light" | "dark" =
    termPalettePref === "auto" ? themeMode : termPalettePref;

  const handleCyclePalette = () => {
    setTermPalettePref((prev) => {
      const next = nextPalettePref(prev);
      try {
        window.localStorage.setItem("nook-console:term-palette", next);
      } catch {
        // ignore
      }
      return next;
    });
  };

  const ctrlActiveRef = useRef(false);
  ctrlActiveRef.current = ctrlActive;

  const menuRef = useRef<HTMLDivElement>(null);
  const termHandlesRef = useRef<Map<string, TerminalViewHandle>>(new Map());
  const bootstrappedRef = useRef(false);

  // Sync theme to html root + localStorage
  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeMode === "dark");
    try {
      window.localStorage.setItem("nook-console:theme", themeMode);
    } catch {
      // ignore
    }
  }, [themeMode]);

  // Listen for Nook host postMessage (theme & active session cwd)
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; type?: string; mode?: string; cwd?: string } | null;
      if (!data || data.source !== "nook-host") return;
      if (data.type === "theme" && (data.mode === "dark" || data.mode === "light")) {
        setThemeMode(data.mode);
      } else if (data.type === "context" && typeof data.cwd === "string" && data.cwd.trim()) {
        setHostCwd(data.cwd.trim());
      }
    };
    window.addEventListener("message", onMessage);
    if (embedded) {
      window.parent.postMessage({ source: "nook-console", type: "ready" }, window.location.origin);
    }
    return () => window.removeEventListener("message", onMessage);
  }, [embedded]);

  // Close dropdown menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  // Check authentication
  useEffect(() => {
    consoleApi
      .me()
      .then((res) => {
        setAuthenticated(res.authenticated);
        if (res.defaultCwd) setDefaultCwd(res.defaultCwd);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true));
  }, []);

  const createTerminal = useCallback(
    async (opts?: { preset?: TerminalPreset; cwd?: string; title?: string }) => {
      setErrorMsg(null);
      setMenuOpen(false);
      try {
        const res = await consoleApi.createTerminal({
          preset: opts?.preset ?? "shell",
          cwd: opts?.cwd ?? hostCwd ?? defaultCwd,
          title: opts?.title,
        });
        setTerminals((prev) => [...prev, res.terminal]);
        setActiveId(res.terminal.id);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "创建终端失败");
      }
    },
    [hostCwd, defaultCwd],
  );

  // Load existing terminals once authenticated (auto-create one if empty)
  useEffect(() => {
    if (!authenticated || bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    consoleApi
      .listTerminals()
      .then(async (res) => {
        if (res.defaultCwd) setDefaultCwd(res.defaultCwd);
        if (res.terminals.length > 0) {
          setTerminals(res.terminals);
          setActiveId(res.terminals[res.terminals.length - 1].id);
        } else {
          const created = await consoleApi.createTerminal({
            preset: "shell",
            cwd: initialQueryCwd ?? res.defaultCwd,
          });
          setTerminals([created.terminal]);
          setActiveId(created.terminal.id);
        }
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : "加载终端列表失败");
      });
  }, [authenticated, initialQueryCwd]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await consoleApi.login(password);
      setPassword("");
      setAuthenticated(true);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleCloseTerminal = async (id: string) => {
    try {
      await consoleApi.closeTerminal(id);
    } catch {
      // ignore if already gone
    }
    termHandlesRef.current.delete(id);
    setTerminals((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[Math.min(idx, next.length - 1)] ?? null;
        setActiveId(fallback?.id ?? null);
      }
      return next;
    });
  };

  const handleRestartTerminal = useCallback(async (id: string) => {
    try {
      const res = await consoleApi.restartTerminal(id);
      setTerminals((prev) => prev.map((t) => (t.id === id ? res.terminal : t)));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "重启终端失败");
    }
  }, []);

  const handleCommitRename = async () => {
    const id = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!id || !title) return;
    try {
      const res = await consoleApi.renameTerminal(id, title);
      setTerminals((prev) => prev.map((t) => (t.id === id ? res.terminal : t)));
    } catch {
      // ignore
    }
  };

  const handleStatusChange = useCallback(
    (id: string, status: "running" | "exited", exitCode: number | null) => {
      setTerminals((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status, exitCode } : t)),
      );
    },
    [],
  );

  const handleSelectionChange = useCallback((id: string, selection: string) => {
    setSelections((prev) => {
      if (prev[id] === selection) return prev;
      return { ...prev, [id]: selection };
    });
  }, []);

  const handleSizeChange = useCallback((id: string, cols: number, rows: number) => {
    setTermSizes((prev) => {
      const cur = prev[id];
      if (cur && cur.cols === cols && cur.rows === rows) return prev;
      return { ...prev, [id]: { cols, rows } };
    });
  }, []);

  const activeSession = useMemo(
    () => terminals.find((t) => t.id === activeId) ?? null,
    [terminals, activeId],
  );
  const activeSelection = (activeId ? selections[activeId] : "")?.trim() ?? "";

  const handleSendToChat = () => {
    if (!embedded || !activeSelection) return;
    window.parent.postMessage(
      {
        source: "nook-console",
        type: "send-to-chat",
        text: activeSelection,
        title: activeSession?.title || "控制台",
      },
      window.location.origin,
    );
  };

  const sendVirtualKey = (seq: string) => {
    if (!activeId) return;
    const handle = termHandlesRef.current.get(activeId);
    handle?.sendInput(seq);
  };

  const handlePaste = async () => {
    if (!activeId) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        termHandlesRef.current.get(activeId)?.sendInput(text);
      }
    } catch {
      setErrorMsg("浏览器未授予剪贴板读取权限，请长按终端粘贴");
    }
  };

  const openStandaloneWindow = () => {
    const query = hostCwd ? `?cwd=${encodeURIComponent(hostCwd)}` : "";
    window.open(`${BASE_PATH}/${query}`, "_blank", "noopener,noreferrer");
  };

  if (!authChecked) {
    return (
      <div className="login-page">
        <span className="login-sub">连接控制台…</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={(e) => void handleLogin(e)}>
          <div className="login-header">
            <TerminalIcon size={26} />
            <h1 className="login-title">Nook 控制台</h1>
            <p className="login-sub">独立终端服务 · 输入口令继续</p>
          </div>
          <input
            type="password"
            className="login-input"
            placeholder="访问口令"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <button type="submit" className="login-btn" disabled={loginBusy || !password}>
            {loginBusy ? "验证中…" : "进入控制台"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="console-shell">
      <header className="console-topbar">
        <div className="tabs-scroll" role="tablist" aria-label="终端标签">
          {terminals.map((t) => {
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                className={isActive ? "tab-item active" : "tab-item"}
                onClick={() => setActiveId(t.id)}
                onDoubleClick={() => {
                  setRenamingId(t.id);
                  setRenameValue(t.title);
                }}
                title={`${t.title} (${t.cwd})`}
              >
                <span className={t.status === "running" ? "tab-dot" : "tab-dot exited"} />
                {renamingId === t.id ? (
                  <input
                    className="tab-rename-input"
                    value={renameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void handleCommitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCommitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span className="tab-title">{t.title}</span>
                )}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`关闭 ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseTerminal(t.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          <div className="split-btn-wrap" ref={menuRef}>
            <button
              type="button"
              className="icon-btn"
              title="新建终端"
              aria-label="新建终端"
              onClick={() => void createTerminal({ preset: "shell" })}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              style={{ minWidth: 24, padding: "0 4px" }}
              title="快捷新建"
              aria-label="快捷新建"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              <ChevronDown size={13} />
            </button>

            {menuOpen && (
              <div className="dropdown-menu">
                {hostCwd && hostCwd !== defaultCwd && (
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() =>
                      void createTerminal({
                        preset: "shell",
                        cwd: hostCwd,
                        title: basenameOf(hostCwd) || "对话目录",
                      })
                    }
                  >
                    <FolderOpen size={14} />
                    <span>当前对话目录</span>
                    <span className="sub">{basenameOf(hostCwd)}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => void createTerminal({ preset: "shell", cwd: defaultCwd })}
                >
                  <TerminalIcon size={14} />
                  <span>新建 Shell</span>
                  <span className="sub">{basenameOf(defaultCwd)}</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => void createTerminal({ preset: "agy", cwd: hostCwd ?? defaultCwd })}
                >
                  <Sparkles size={14} />
                  <span>打开 agy</span>
                  <span className="sub">/usage</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => void createTerminal({ preset: "nook-logs" })}
                >
                  <ScrollText size={14} />
                  <span>Nook 服务日志</span>
                  <span className="sub">journalctl</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            title={`终端配色：${paletteLabel(termPalettePref)}（点击切换）`}
            onClick={handleCyclePalette}
          >
            <Palette size={14} />
            <span className="desktop-only">{paletteLabel(termPalettePref)}</span>
          </button>

          {embedded && (
            <button
              type="button"
              className={activeSelection ? "icon-btn primary" : "icon-btn"}
              disabled={!activeSelection}
              title={activeSelection ? "将选中的终端输出发送到当前对话" : "先在终端中选中文字"}
              onClick={handleSendToChat}
            >
              <Send size={13} />
              <span className="desktop-only">发给对话</span>
            </button>
          )}

          {embedded ? (
            <button
              type="button"
              className="icon-btn"
              title="在新窗口独立打开控制台"
              aria-label="在新窗口独立打开控制台"
              onClick={openStandaloneWindow}
            >
              <ExternalLink size={14} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="icon-btn"
                title={themeMode === "dark" ? "切换浅色模式" : "切换深色模式"}
                onClick={() => setThemeMode((m) => (m === "dark" ? "light" : "dark"))}
              >
                {themeMode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="退出控制台登录"
                onClick={() =>
                  void consoleApi.logout().then(() => {
                    bootstrappedRef.current = false;
                    setTerminals([]);
                    setActiveId(null);
                    setAuthenticated(false);
                  })
                }
              >
                <LogOut size={14} />
              </button>
            </>
          )}
        </div>
      </header>

      <main className="console-body">
        {errorMsg && (
          <div
            className="term-banner"
            style={{ position: "absolute", top: 8, left: 10, right: 10, zIndex: 20 }}
          >
            <span style={{ color: "var(--danger)" }}>{errorMsg}</span>
            <button type="button" className="tab-close" onClick={() => setErrorMsg(null)}>
              <X size={13} />
            </button>
          </div>
        )}

        {terminals.length === 0 ? (
          <div className="empty-state">
            <TerminalIcon size={28} />
            <span>暂无打开的终端</span>
            <button
              type="button"
              className="icon-btn primary"
              onClick={() => void createTerminal({ preset: "shell" })}
            >
              <Plus size={14} />
              新建终端
            </button>
          </div>
        ) : (
          terminals.map((t) => (
            <TerminalView
              key={t.id}
              ref={(handle) => {
                if (handle) termHandlesRef.current.set(t.id, handle);
                else termHandlesRef.current.delete(t.id);
              }}
              session={t}
              active={t.id === activeId}
              terminalSurface={terminalSurface}
              ctrlActiveRef={ctrlActiveRef}
              onConsumeCtrl={() => setCtrlActive(false)}
              onStatusChange={handleStatusChange}
              onSizeChange={handleSizeChange}
              onSelectionChange={handleSelectionChange}
              onRestart={(id) => void handleRestartTerminal(id)}
            />
          ))
        )}
      </main>

      {activeSession && (
        <footer className="console-statusbar">
          <div className="statusbar-group">
            <span className="statusbar-pill">
              <span
                className={activeSession.status === "running" ? "tab-dot" : "tab-dot exited"}
              />
              {activeSession.cwd}
            </span>
          </div>
          <div className="statusbar-group">
            {activeId && termSizes[activeId] && (
              <span className="statusbar-pill">
                {termSizes[activeId].cols}×{termSizes[activeId].rows}
              </span>
            )}
            <button type="button" className="statusbar-btn" onClick={handleCyclePalette}>
              {paletteLabel(termPalettePref)}
            </button>
          </div>
        </footer>
      )}

      {terminals.length > 0 && (
        <div className="mobile-keys" role="toolbar" aria-label="快捷按键">
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x1b")}>
            Esc
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\t")}>
            Tab
          </button>
          <button
            type="button"
            className={ctrlActive ? "vkey active" : "vkey"}
            onClick={() => setCtrlActive((v) => !v)}
          >
            Ctrl
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x03")}>
            ^C
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x1b[A")}>
            ↑
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x1b[B")}>
            ↓
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x1b[D")}>
            ←
          </button>
          <button type="button" className="vkey" onClick={() => sendVirtualKey("\x1b[C")}>
            →
          </button>
          <button type="button" className="vkey" onClick={() => void handlePaste()} aria-label="粘贴">
            <ClipboardPaste size={13} style={{ verticalAlign: "middle" }} />
          </button>
        </div>
      )}
    </div>
  );
}
