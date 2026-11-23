# Nook Console

独立运行的 Web 终端服务（`nookconsole.service`），在进程、数据、鉴权与 Nginx 路由层与 Nook 主服务完全隔离——即使 Nook 崩溃或重启，独立控制台依然保持在线并可直接用于排查日志与恢复服务。

## 核心特性
- **零原生编译依赖 PTY 桥接**：Node + Fastify WebSocket + Python 3 标准库 `pty-bridge.py`，支持真实伪终端、动态窗口尺寸同步（`TIOCSWINSZ` / `SIGWINCH`）及 `vim` / `htop` / `agy` TUI。
- **多标签与 128KB 环形缓冲保活**：支持多标签新建、双击重命名、关闭与退出后重启；切视图、刷新页面或多端连接自动回放近期输出。
- **双通道鉴权**：独立口令登录（30 天 `HttpOnly` Cookie，首次启动可选单向复制 Nook 口令哈希，也可通过 `NOOK_CONSOLE_PASSWORD` 单独覆盖）+ 一次性 SSO Ticket 免密嵌入 Nook 侧边栏。
- **现代配色与彩色 Shell 初始化**：内置 Tokyo Night / Catppuccin Latte / 跟随主题三档配色切换与 `shell-init.sh`（Git 分支彩色提示符 + `ls`/`grep`/`diff` 彩色输出），不修改全局 `~/.bashrc`。
- **移动端适配与 Nook 联动**：触控端底部虚拟按键栏（`Esc`、`Tab`、`Ctrl`、`^C`、方向键、粘贴）、`visualViewport` 软键盘自适应、以及选中终端日志一键「发给对话」。

## 本地开发与构建

```bash
npm install
npm run typecheck
npm run build
npm start
```

配置模板见 [deploy/nookconsole.env.example](deploy/nookconsole.env.example)。
