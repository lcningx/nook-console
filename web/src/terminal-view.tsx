import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { RotateCw } from "lucide-react";
import { buildTerminalWsUrl, type TerminalSessionSummary } from "./api";

const DARK_THEME: ITheme = {
  background: "#151822",
  foreground: "#c0caf5",
  cursor: "#7aa2f7",
  cursorAccent: "#151822",
  selectionBackground: "rgba(122, 162, 247, 0.3)",
  black: "#1d202f",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#565f89",
  brightRed: "#ff899d",
  brightGreen: "#b9f27c",
  brightYellow: "#ff9e64",
  brightBlue: "#8db0ff",
  brightMagenta: "#c0a3ff",
  brightCyan: "#b4f9f8",
  brightWhite: "#c0caf5",
};

const LIGHT_THEME: ITheme = {
  background: "#f6f7fb",
  foreground: "#383a42",
  cursor: "#1e66f5",
  cursorAccent: "#f6f7fb",
  selectionBackground: "rgba(30, 102, 245, 0.18)",
  black: "#4c4f69",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  magenta: "#8839ef",
  cyan: "#04a5e5",
  white: "#acb0be",
  brightBlack: "#7c7f93",
  brightRed: "#e64553",
  brightGreen: "#2e8b57",
  brightYellow: "#fe640b",
  brightBlue: "#209fb5",
  brightMagenta: "#ea76cb",
  brightCyan: "#179299",
  brightWhite: "#1e1e2e",
};

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export interface TerminalViewHandle {
  sendInput: (text: string) => void;
  focus: () => void;
  fit: () => void;
  getSelection: () => string;
}

interface TerminalViewProps {
  session: TerminalSessionSummary;
  active: boolean;
  terminalSurface: "light" | "dark";
  ctrlActiveRef: React.RefObject<boolean>;
  onConsumeCtrl: () => void;
  onStatusChange: (id: string, status: "running" | "exited", exitCode: number | null) => void;
  onSizeChange: (id: string, cols: number, rows: number) => void;
  onSelectionChange: (id: string, selection: string) => void;
  onRestart: (id: string) => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    {
      session,
      active,
      terminalSurface,
      ctrlActiveRef,
      onConsumeCtrl,
      onStatusChange,
      onSizeChange,
      onSelectionChange,
      onRestart,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const activeRef = useRef(active);
    const [disconnected, setDisconnected] = useState(false);

    activeRef.current = active;

    const sendRaw = (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    };

    const syncSize = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      const host = hostRef.current;
      if (!term || !fit || !host) return;
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const ws = wsRef.current;
      if (term.cols >= 10 && term.rows >= 4) {
        onSizeChange(session.id, term.cols, term.rows);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        sendInput: (text: string) => {
          sendRaw(text);
          termRef.current?.focus();
        },
        focus: () => {
          termRef.current?.focus();
        },
        fit: () => {
          syncSize();
        },
        getSelection: () => termRef.current?.getSelection() ?? "",
      }),
      [],
    );

    // Update theme dynamically without remounting terminal
    useEffect(() => {
      if (termRef.current) {
        termRef.current.options.theme = terminalSurface === "dark" ? DARK_THEME : LIGHT_THEME;
      }
    }, [terminalSurface]);

    // Mount xterm + WebSocket lifecycle
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const isMobileViewport = window.matchMedia("(max-width: 768px)").matches;
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: '"Fira Code Variable", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: isMobileViewport ? 12.5 : 13.5,
        lineHeight: 1.32,
        scrollback: 5000,
        allowProposedApi: true,
        theme: terminalSurface === "dark" ? DARK_THEME : LIGHT_THEME,
      });
      const fit = new FitAddon();
      const links = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(links);
      term.open(host);

      termRef.current = term;
      fitRef.current = fit;

      const onDataDisp = term.onData((data) => {
        if (ctrlActiveRef.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 65 && code <= 90) {
            onConsumeCtrl();
            sendRaw(String.fromCharCode(code - 64));
            return;
          }
          onConsumeCtrl();
        }
        sendRaw(data);
      });

      const onSelDisp = term.onSelectionChange(() => {
        onSelectionChange(session.id, term.getSelection());
      });

      let closed = false;
      let reconnectTimer: number | undefined;
      let pingTimer: number | undefined;

      const connect = () => {
        if (closed) return;
        const ws = new WebSocket(buildTerminalWsUrl(session.id));
        wsRef.current = ws;

        ws.onopen = () => {
          if (closed || wsRef.current !== ws) {
            ws.close();
            return;
          }
          setDisconnected(false);
          requestAnimationFrame(() => {
            syncSize();
            if (activeRef.current) term.focus();
          });
          if (pingTimer) window.clearInterval(pingTimer);
          pingTimer = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 25_000);
        };

        ws.onmessage = (ev) => {
          if (closed || wsRef.current !== ws) return;
          try {
            const msg = JSON.parse(String(ev.data)) as {
              type: string;
              data?: string;
              replay?: string;
              exitCode?: number | null;
              session?: TerminalSessionSummary;
            };
            if (msg.type === "ready") {
              term.reset();
              if (msg.replay) {
                term.write(decodeBase64ToBytes(msg.replay));
              }
              if (msg.session) {
                onStatusChange(session.id, msg.session.status, msg.session.exitCode);
              }
              requestAnimationFrame(() => syncSize());
            } else if (msg.type === "output" && msg.data) {
              term.write(decodeBase64ToBytes(msg.data));
            } else if (msg.type === "exit") {
              onStatusChange(session.id, "exited", msg.exitCode ?? 0);
            } else if (msg.type === "restarted" && msg.session) {
              term.reset();
              onStatusChange(session.id, msg.session.status, msg.session.exitCode);
              requestAnimationFrame(() => syncSize());
            }
          } catch {
            // ignore malformed frames
          }
        };

        ws.onclose = (ev) => {
          if (closed || wsRef.current !== ws) return;
          if (pingTimer) {
            window.clearInterval(pingTimer);
            pingTimer = undefined;
          }
          if (ev.code === 1000 || ev.code === 4401 || ev.code === 4404) {
            return;
          }
          setDisconnected(true);
          reconnectTimer = window.setTimeout(connect, 1800);
        };
      };

      connect();

      const ro = new ResizeObserver(() => {
        if (activeRef.current) {
          requestAnimationFrame(() => syncSize());
        }
      });
      ro.observe(host);

      const vv = window.visualViewport;
      const onViewportResize = () => {
        if (activeRef.current) {
          requestAnimationFrame(() => syncSize());
        }
      };
      vv?.addEventListener("resize", onViewportResize);

      return () => {
        closed = true;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        if (pingTimer) window.clearInterval(pingTimer);
        ro.disconnect();
        vv?.removeEventListener("resize", onViewportResize);
        onDataDisp.dispose();
        onSelDisp.dispose();
        wsRef.current?.close(1000);
        wsRef.current = null;
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.id]);

    // Fit & focus whenever this tab becomes active
    useEffect(() => {
      if (!active) return;
      const raf = requestAnimationFrame(() => {
        syncSize();
        termRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }, [active]);

    return (
      <div className={active ? "term-pane" : "term-pane hidden"}>
        {disconnected && (
          <div className="term-banner">
            <span>连接已断开，正在重连…</span>
          </div>
        )}
        {session.status === "exited" && (
          <div className="term-banner">
            <span>进程已退出（代码 {session.exitCode ?? 0}）</span>
            <button
              type="button"
              className="icon-btn primary"
              onClick={() => onRestart(session.id)}
            >
              <RotateCw size={13} />
              重新启动
            </button>
          </div>
        )}
        <div
          className={
            terminalSurface === "dark"
              ? "term-surface dark-surface"
              : "term-surface light-surface"
          }
        >
          <div
            ref={hostRef}
            className="term-canvas"
            onClick={() => termRef.current?.focus()}
          />
        </div>
      </div>
    );
  },
);
