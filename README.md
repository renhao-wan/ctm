# ctm — Claude Terminal Multiplexer

用 ConPTY 托管 Claude Code 交互式会话，让同一台机器上的多个会话可以互相发消息、感知状态、按组讨论，而不修改 Claude Code 本身。

> 当前状态：M1（宿主 + 单会话托管 + 状态机）、M2（主动投递）、M3（离线会话按需拉起并补投）、分组隔离、claude 命令包装、M4（组内讨论频道）、M5（npm 打包与自检）均已通过。设计与验证文档在仓库外层的 `../cc-wrapped/`：`ctm-design.md`、`ctm-verified-findings.md`、`ctm-verification-plan.md`。
>
> **第一次用？先看动画版指南：[`docs/guide.html`](docs/guide.html)**（浏览器直接打开，六个场景可逐步播放）。

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
- **按需启动**：目标会话离线时，发送方先入队，再用目标 meta.json 里记录的 `cwd` / `node` / 入口路径在新终端窗口把它拉起来；宿主启动后自动补投收件箱里的消息

**硬约束**：需要接收消息的会话必须至少被 `ctm new` 启动过一次，之后可以关闭窗口——注册信息（`meta.json`）会保留，其他会话仍能把它重新拉起。普通 `claude` 会话没有输入通道，插件无法给它送信。发送方可以是任意安装了本插件的会话。

---

## 快速开始

```bash
npm install
node src/main.mjs doctor          # 环境自检
node src/main.mjs new web --cwd D:/projects/web --group frontend
node src/main.mjs list
node src/main.mjs resume              # 在新的托管会话里恢复历史对话（claude --resume）
node src/main.mjs start web           # 窗口关掉后重新拉起
node src/main.mjs kill web
node src/main.mjs install-wrap        # 让 claude 命令自动变成托管会话
node src/main.mjs room create api 认证接口怎么改 --group frontend
node src/main.mjs room start api      # 把议题投递给同组成员
```

`ctm new` 会接管当前终端：输入输出透传给托管的 `claude`，Ctrl+C 结束。

在另一个 Claude Code 会话里安装本插件后：

```text
/ctm:list                          # 查看托管会话、状态与未读数
/ctm:ask web 认证服务的端口是多少？   # 提问；web 没开时自动拉起
/ctm:tell web 接口字段已经改了        # 单向通知
/ctm:reply 7f3a1c2d 收到，马上看       # 回复收件箱里的某条消息
/ctm:start web                     # 只启动，不发消息

/ctm:room create api 认证接口怎么改   # 建一个讨论频道
/ctm:room start api 第一轮：字段命名  # 把议题投递给同组成员
/ctm:room say api 先加版本号          # 发言
/ctm:room show api                 # 查看发言
/ctm:room summary api              # 生成 summary.md
```

本地开发时可用 `claude --plugin-dir D:/projects/claudecode-plugings/ctm` 临时加载，正式安装走 `/plugin`。

### B 没开窗口时

只要 B 至少被 `ctm new` 启动过一次，之后就可以关掉它的窗口。再给 B 发消息时：

```text
A 的会话里：/ctm:ask web 认证模块的入口在哪？
```

发生的事：

1. 消息先写入 `web` 的收件箱（落盘，不会丢）
2. `web` 离线，发送方读取它的 `meta.json`，在新终端窗口重新执行同一个宿主
3. 新宿主启动 `claude`、自动处理信任提示，就绪后把收件箱里的消息作为用户输入提交
4. 新窗口里能直接看到这条消息和 `claude` 的回答

本机实测：从发起到收到回答约 25 秒（claude 2.1.319）。不发消息、只想开窗口时用 `/ctm:start web` 或 `ctm start web`。

---

## 分组：a,b,c 互相可见，d,e 互相可见

会话在启动时归组，组内互通，组间**双向隔离**——列表里看不见，发消息也会被拒绝。

```bash
ctm new a --group frontend
ctm new b --group frontend
ctm new c --group frontend

ctm new d --group backend
ctm new e --group backend
```

- `/ctm:list` 只显示同组会话（`ctm_list` 带 `all: true` 可临时查看全部，用于排查）
- `/ctm:ask`、`/ctm:tell`、`/ctm:start` 对跨组目标统一返回「不存在或不在当前可见组内」
- 一个会话可以属于多个组，交集即桥接：`ctm new b --group frontend --group shared`
- **没有组的会话是独立单组**，只看得见自己
- 组的来源优先级：启动参数 `--group` > 环境变量 `CTM_GROUP` > 项目里的 `.ctm.json`

项目内固定分组，不必每次带参数：

```json
// D:/projects/web/.ctm.json
{ "group": "frontend" }
```

> 分组约束的是**会话之间**的自动传播。没有会话身份的操作者（CLI、未包装的普通 claude）视为用户本人，不受限制。

---

## 让 `claude` 命令直接变成托管会话

不想到处记 `ctm new`，可以生成一个包装脚本：

```bash
node src/main.mjs install-wrap
```

它会在 `~/.ctm/bin/claude.cmd` 生成包装，把这个目录放到 PATH 最前面即可：

```bat
set PATH=%USERPROFILE%\.ctm\bin;%PATH%
```

之后：

```text
claude                      → 自动 ctm new，会话名取当前目录名
claude --resume             → 交互式，仍然托管
claude --version / -p / mcp → 原样透传给真正的 claude
```

- 同名会话还在运行时会自动加后缀（`web-2`、`web-3`）
- 默认组取自 `--group`、`CTM_GROUP` 或当前目录的 `.ctm.json`
- 解析器会跳过这个包装脚本，不会递归调用自己

这样「敲 `claude` 就进会话」和「这个会话能收信」变成同一件事。

---

## 讨论频道：组内多轮

频道属于一个组，组外会话看不见，也发不进来。

```bash
ctm room create api 认证接口怎么改 --group frontend
ctm room say api 先加版本号
ctm room start api 第一轮：字段命名
ctm room show api
ctm room summary api
```

存储结构：

```text
~/.ctm/rooms/api/
├── meta.json       # 议题、组、轮次、创建者
├── messages.jsonl  # 按时间追加的发言，带轮次
└── summary.md      # 按轮次汇总，summary 命令生成
```

- `start` 把本轮议题写进频道，并投递到同组每个成员的收件箱；离线成员启动后自动补投
- **不自动多轮**：每轮都要显式 `start`，避免会话互相触发、token 失控
- 发言用 `say`，查看用 `show`，收尾用 `summary`
- 频道名会清洗成安全文件名，不能借 `../` 跳出 `~/.ctm/rooms/`
- 在 Claude Code 会话里用 `/ctm:room <动作> ...`，语义相同

---

## 打包与安装

```bash
npm pack                    # 生成 ctm-0.3.0.tgz；prepack 会先跑全部单元测试
npm install -g ./ctm-0.3.0.tgz
ctm doctor
```

包内含插件清单（`.claude-plugin/`、`.mcp.json`、`commands/`）与宿主代码。作为 Claude Code 插件加载：

```bash
claude --plugin-dir "$(npm root -g)/ctm"      # Git Bash
claude --plugin-dir "$(npm root -g)\ctm"      # PowerShell
```

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

## 环境要求

- Windows 10 1809+（ConPTY）
- Node.js 18+
- Claude Code（已安装并在 PATH 中，或设置 `CTM_CLAUDE_BIN`）
- Git（已有插件 hook 需要 bash；不在标准路径时 `ctm` 会尝试探测并注入 PATH）

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

细节与原始数据见 `../cc-wrapped/ctm-verified-findings.md`。

---

## 已知限制

- 已启动的普通 `claude` 会话无法被接管（`AttachConsole` 返回拒绝访问）；只能新开托管会话。
- 用户输入残留内容超过 2 秒未变化时，宿主无法观测输入框状态，仍可能污染。
- 工具权限确认会阻塞轮次：`Write` 等操作需要用户确认时，会话不会发 `Stop`。宿主会把这种屏幕标记为 `needs-input`、暂停投递，并在 `ctm list` / `/ctm:list` 中显示；**但不会代替用户确认**，需要你到该窗口按键。
- `needs-input` 的识别依赖屏幕尾部文案：已知的 `Do you want to proceed?`、`Do you want to allow this connection?`，以及通用组合 `Do you want to …?` + `1. Yes` + `Esc to cancel`（实测 2.1.319 写文件提示是 `Do you want to create <file>?`）。Claude Code 改版后若文案变化，需要同步 `src/tui.mjs` 的标记。
- 讨论频道不自动多轮：`start` 只投递议题，不等待成员发言，也不会自动发起下一轮。轮次由人显式推进。
- 讨论频道的组隔离与消息一致，但它不是安全边界：同一用户仍可直接读写 `~/.ctm/rooms/`。
- 信任提示的自动选择依赖当前布局（`❯` 紧邻选项文本）。布局变化时不猜按键，会话会停在启动阶段直到超时，需要用户手动处理。
- 项目目录自带 `.mcp.json` 时，claude 启动会要求确认是否加载其中的 MCP server。MCP server 可以执行任意代码，宿主**不代替用户授权**，会话停在 `needs-input`，需要用户按键确认一次。
- 首条消息：提交确认现在同时看屏幕与 hook 事件，超时后会补发一次回车。2.1.319 单会话冒烟 6/6 成功；5 会话并发启动时实测仍有 4/5 首条失败，并发场景需要重新验证。
- 按需启动依赖 `meta.json`：`ctm kill` 会删除它，被 kill 掉的会话无法再由其他会话拉起。要保留"随时可唤醒"能力请直接关闭窗口（Ctrl+C），不要用 `ctm kill`。
- 按需启动默认新开终端窗口，优先用 `wt.exe`，缺失时回退 `cmd.exe /c start`。无桌面会话（纯后台）环境下只能用 `CTM_LAUNCH_MODE=background`，此时没有可视窗口。
- 拉起后的会话会重新走一遍启动流程（信任提示、项目 `.mcp.json` 确认等），因此从发消息到实际送达有几十秒延迟，期间消息安全地留在收件箱。
- 15 秒的 `launch.lock` 用来防止多个发送方同时拉起同一个会话；在此期间重复请求会返回"启动进行中"。
- 分组是协作边界，不是安全边界：同一用户仍可直接读改 `~/.ctm/` 下的文件。它防止的是会话之间的意外串扰。
- `ctm install-wrap` 只生成脚本，不修改 PATH；需要手动把 `~/.ctm/bin` 放到 PATH 前面。
- 包装后的 `claude` 在同一目录重复打开时，会话名会自动加 `-2`、`-3`，旧窗口关闭后名字会被复用。

---

## 目录

```text
.claude-plugin/
  plugin.json           插件清单
docs/
  guide.html            动画版使用指南（浏览器直接打开）
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
