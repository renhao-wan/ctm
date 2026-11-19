# ctm 开发与打包

这个文件给**改 ctm 本身**的人看。只想用的话，读 [`README.md`](../README.md) 就够了。

---

## 形态：插件 + 宿主

本仓库同时是 **Claude Code 插件**和**终端宿主**，两者缺一不可：

```text
终端窗口 B ── ctm 宿主 ── ConPTY ── claude B      ← 主动送达靠宿主
                                        ▲
claude A（已安装插件）── /ctm:ask ──────┘        ← 插件负责发令与查看
                    │
                    └─ B 没开时，A 按 meta.json 记录重新拉起 B 的宿主与窗口
```

- **插件**提供 `/ctm:list`、`/ctm:ask`、`/ctm:tell`、`/ctm:start`，通过内置 MCP server 访问收件箱
- **宿主**持有目标会话的 PTY，在目标空闲时把消息写成一条用户输入
- **按需启动**：目标会话离线时，发送方先入队，再用目标 meta.json 里记录的 `cwd` / `node` / 入口路径、分组和启动参数（含 `--resume`）在新终端窗口把它拉起来；宿主启动后自动补投收件箱里的消息

托管会话之所以能收发消息，是因为 `src/session.mjs` 里的 `pluginArgs()` 会**自动追加 `--plugin-dir <ctm 目录>`**——不这么做，会话里的 AI 就没有 `ctm_*` 工具。用户显式传了 `--plugin-dir` 时不重复添加；`CTM_NO_PLUGIN=1` 可关闭，便于排查「是插件导致启动异常」这类问题。

安装包自带 `node-pty` 的预编译二进制（`prebuilds/` 下有 win32-x64、win32-arm64、darwin-x64、darwin-arm64），终端用户不需要 Visual Studio 或 build-tools。Linux 没有预编译包，需要本地编译。

---

## 打包与发布

```bash
npm pack                    # 生成 renhao-wan-ctm-<version>.tgz；prepack 会先跑全部单元测试
npm test                    # 单元测试：TUI / 收件箱 / 拉起 / 分组 / 解析 / 频道 / MCP
npm run test:smoke          # 冒烟：单会话托管
npm run test:m2             # 端到端：主动投递
```

npm 包的 `files` 字段决定别人装到的是什么：

```json
"files": [".claude-plugin", ".mcp.json", "commands", "docs", "src", "LICENSE", "README.md"]
```

`.claude-plugin/`、`.mcp.json`、`commands/` 必须在里面，否则全局安装后 `--plugin-dir` 指过去找不到插件清单。

发布后自检：

```bash
npm view @renhao-wan/ctm            # 元数据
npm install -g @renhao-wan/ctm      # 真实安装一次
ctm doctor
```

**已知坑**：直接用 registry PUT API 发布 scoped 包时，路径必须写成 `@scope%2fname`（`@` 不编码、`/` 转小写 `%2f`），且 `_attachments` 的键要用**去掉 scope 的**文件名（`ctm-0.3.0.tgz` 而不是 `renhao-wan-ctm-0.3.0.tgz`）。否则元数据写进去了，tarball 却是 404。

---

## 关于 Claude Code 版本

**`ctm` 启动的 `claude` 与你在终端里执行 `claude` 得到的必须是同一个二进制文件。** 这一点不是自动成立的。

`node-pty` 在 Windows 上通过 `CreateProcessW` 启动进程，它只按 `.exe` 扩展名查找，**不认 `PATHEXT`，也不认 npm 生成的 sh 包装脚本和 `.cmd`**。

如果本机存在多个 Claude Code 安装（例如 npm 全局安装 + 某个 IDE/工具自带的 SDK），而 npm 全局目录里只有 `claude`、`claude.cmd`、`claude.ps1` 三个 shim、没有 `claude.exe`，那么：

```text
你在终端里执行 claude        → 经 claude.cmd 转到 npm 包里的 claude.exe
node-pty 执行 spawn('claude') → 跳过 shim，落到 PATH 后面另一个 claude.exe
```

本机实测过这个情况：终端是 2.1.234，PTY 托管却是 2.1.319。2026-11-18 已将两处统一为 2.1.319（SHA256 相同），但解析约束仍然保留——CC GUI 升级 SDK 或 npm 全局再次升级时仍可能分叉。

`ctm` 因此自己做路径解析（`src/resolve-claude.mjs`）：

1. `CTM_CLAUDE_BIN` 环境变量最优先
2. 否则按 PATH 顺序找位置最靠前的 `claude` 入口；若是 shim，解析其内容拿到真实 `.exe`
3. 多个候选时选 PATH 中更靠前的那个，并在 `ctm doctor` 中列出全部候选

`ctm doctor` 会把解析结果与 shell 中 `claude --version` 对照，不一致时直接报失败。

如需固定版本：

```bash
set CTM_CLAUDE_BIN=D:\nodejs\GlobalNodeModules\node_modules\@anthropic-ai\claude-code\bin\claude.exe
```

### 和 CC GUI 的关系

CC GUI（`ccgui-next.exe`）**不用 PATH 上的 `claude`**，它启动的是自己下载的 SDK 副本：

```text
C:\Users\Lenovo\.codemoss\dependencies\claude-sdk\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe
```

它支持「自定义 Claude Code 路径」，但当前留空（界面显示「自动检测」），所以实际用的就是上面这份。CC GUI 的「更新至 x.y.z」也只更新这份副本，不会动 npm 全局。

三处（终端、CC GUI、`ctm`）是否指向同一个文件，用脚本查：

```bash
node ../cc-wrapped/verify/diff-installs.mjs
```

输出会并列给出路径、`--version`、SHA256，并以 `RESULT=SAME` / `RESULT=DIVERGED` 结尾。

### CC GUI 插件

同一套检测逻辑也做成了 CC GUI 插件（不是 Claude Code 插件），并扩展到宿主支持的 13 个 CLI 引擎：

```text
D:\projects\claudecode-plugings\ccgui-plugin-cli-install-audit\
├── manifest.json      # id: cli-install-audit
├── main.js            # 自包含单文件，内置引擎表
├── docs/icon.png
├── README.md / LICENSE
└── .github/workflows/release.yml   # 打 tag 自动发 Release
```

安装：CC GUI 侧边栏「插件」→「从本地目录安装」→ 选上面这个目录。入口在**设置 → 插件 → CLI 安装检测**，命令面板搜「CLI 安装检测」也能直接跳到该区块。刻意不占聊天右侧面板。

插件只声明三项权限：`ui:settings-section`（设置页区块）、`ui:command`（命令面板入口）与 `exec:powershell`（经 `ctx.bridge.invoke('plugin_exec_run')` 读取 PATH、进程与文件哈希）。

它比命令行脚本多几项能力：用 `Get-CimInstance Win32_Process` 读取 **CC GUI 实际 spawn 的进程路径**，回溯父进程链标出「CC GUI / 终端」归属，按路径统计同一二进制的实例数，并对每个引擎分别给出「一致 / 分叉 / 未安装」。

---

## 已验证的关键约束

这些结论都来自实测，不是推测：

| 约束 | 说明 |
|---|---|
| 消息必须分两步写入 | 先写文本，等待 200ms，再写 `\r`。一次写入不会提交 |
| 首条消息需要 settle 期 | TUI 就绪后仍会重绘，立即写入会被吞掉 |
| 就绪判定必须多标记 | 不同版本的底部状态栏文案不同，单一标记会失效 |
| 投递前检查用户按键 | 输入框有残留时，注入内容会与残留合并成一条消息 |
| 消息前缀必须明确 | `[web]` 无效；必须写成「来自会话 web，工作区 …」 |
| 信任提示不能直接回车 | 2.1.319 默认选中 `No, exit`，回车会让 claude 以 code=1 退出；必须先下移到 `Yes`，确认选中项后再回车 |
| 状态感知用 hook | `Stop` / `PreToolUse` / `PostToolUse` 在 PTY 会话中正常触发，不需要解析 transcript |
| 提交确认要多信号 | 只看 `esc to interrupt` 会在 thinking 阶段误判；结合 hook 事件，超时后补发一次回车 |
| 并发首条消息需要重试 | 5 个会话同时启动时首帧重绘更严重；确认失败会保持未投递并在下一轮重试，实测 3 轮 15/15 |

细节与原始数据见 `../cc-wrapped/ctm-verified-findings.md`。

---

## 已知限制（实现层面）

用户视角的限制见 [`README.md`](../README.md#已知限制)。这里只列改代码时会碰到的：

- 已启动的普通 `claude` 会话无法被接管（`AttachConsole` 返回拒绝访问）；只能新开托管会话。
- `needs-input` 的识别依赖屏幕尾部文案：已知的 `Do you want to proceed?`、`Do you want to allow this connection?`，以及通用组合 `Do you want to …?` + `1. Yes` + `Esc to cancel`（实测 2.1.319 写文件提示是 `Do you want to create <file>?`）。只有文案、没有编号选项或取消提示时不算权限确认。Claude Code 改版后若文案变化，需要同步 `src/tui.mjs` 的标记。
- 信任提示的自动选择依赖当前布局（`❯` 紧邻选项文本）。布局变化时不猜按键，会话转为 `needs-input` 并暂停投递。
- 15 秒的 `launch.lock` 用来防止多个发送方同时拉起同一个会话。
- 按需启动默认新开终端窗口，优先用 `wt.exe`，缺失时回退 `cmd.exe /c start`。无桌面会话（纯后台）环境下只能用 `CTM_LAUNCH_MODE=background`。
- 分组与频道都是协作边界，**不是安全边界**：同一用户仍可直接读改 `~/.ctm/` 下的文件。

---

## 目录

```text
.claude-plugin/
  plugin.json           插件清单
docs/
  guide.html            动画版使用指南（浏览器直接打开）
  DEVELOPERS.md         本文件
.mcp.json               插件内置 MCP server 的启动配置
commands/
  list.md               /ctm:list
  ask.md                /ctm:ask
  tell.md               /ctm:tell
  reply.md              /ctm:reply
  start.md              /ctm:start
  room.md               /ctm:room
src/
  main.mjs              CLI
  session.mjs           PTY 宿主、状态机、收件箱投递
  tui.mjs               ANSI 清洗、就绪判定、启动状态机
  resolve-claude.mjs    claude 可执行文件解析
  hooks.mjs             临时 hook 配置生成
  hook-probe.cjs        hook 事件落盘
  registry.mjs          会话注册表
  inbox.mjs             收件箱（跨进程投递队列）
  launch.mjs            按需启动离线的托管会话
  groups.mjs            分组可见性与 claude 包装判定
  rooms.mjs             讨论频道：存储、可见性、轮次、摘要
  mcp-server.mjs        插件 MCP server
test/
  unit-tui.mjs          TUI 判定逻辑单元测试
  unit-inbox.mjs        收件箱单元测试
  unit-launch.mjs       按需启动单元测试
  unit-groups.mjs       分组可见性与包装判定单元测试
  unit-resolve.mjs      claude 可执行文件解析单元测试
  unit-rooms.mjs        讨论频道单元测试
  unit-mcp.mjs          MCP server 工具语义测试（假入口，不启动 claude）
  m1-smoke.mjs          M1 单会话冒烟测试
  m2-delivery.mjs       M2 主动投递端到端测试
  m3-lazy-launch.mjs    M3 离线会话被自动拉起并补投
  m4-wrap.mjs           M4 claude 包装启动托管会话
```

设计阶段的验证脚本（`v*.mjs`、`diag-*.mjs`）与原始记录在 `../cc-wrapped/verify/`，不属于本工程。
