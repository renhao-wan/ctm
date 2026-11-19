# ctm — Claude Terminal Multiplexer

让你的几个 Claude Code 窗口互相说话。

平时你开三个窗口跑 Claude Code，A 想知道 B 的进展，只能自己切窗口、复制粘贴。ctm 把这件事变成一句话：

```text
在你的 Claude Code 会话里：/ctm:ask web 认证服务的端口是多少？
```

B 会自己收到这条消息并回答；B 的窗口没开也没关系，ctm 会把它重新拉起来。

**第一次用先看动画版指南**：[`docs/guide.html`](docs/guide.html)——浏览器直接打开，六个场景可逐步播放。

---

## 安装

需要 Node.js 18+ 和已安装好的 Claude Code。

```bash
npm install -g @renhao-wan/ctm
ctm doctor
```

`ctm doctor` 输出「结论：通过」就说明装好了。它会顺带检查一件容易出错的事：ctm 用的 `claude` 和你终端里敲的 `claude` 是不是同一个文件。

安装包自带 `node-pty` 的 Windows/macOS 预编译二进制，**不需要** Visual Studio 或 build-tools。

> **Git Bash 用户注意**：PATH 里要写 `/c/Users/...` 这种带斜杠的形式，写 `C:/Users/...` 会被 Bash 忽略。

---

## 两个窗口试着聊一下

打开两个终端窗口，都在某个项目目录下执行：

```bash
ctm new web --cwd D:/projects/web --group dev
ctm new api --cwd D:/projects/api --group dev
```

`ctm new` 会接管当前窗口、直接跑起 claude，和你平时敲 `claude` 一样，只是外面多包了一层。`Ctrl+C` 结束。

现在在 `web` 窗口里对 Claude 说：

```text
/ctm:ask api 认证服务的端口配在哪？
```

几秒后 `api` 窗口就会自己收到这句话，Claude 开始回答。

不想每次记 `ctm new`？看下面的[让 claude 命令直接变成托管会话](#让-claude-命令直接变成托管会话)。

---

## 常用命令

| 你在终端里敲 | 作用 |
|---|---|
| `ctm new <名字> [--cwd 路径] [--group 组]` | 开一个新的托管会话 |
| `ctm list` | 看有哪些会话、在不在线、有几条未读 |
| `ctm start <名字>` | 会话窗口关了，重新拉起来 |
| `ctm kill <名字>` | 彻底删掉这个会话的注册信息 |
| `ctm resume` | 在新的托管会话里恢复上一次对话（等价 `claude --resume`） |
| `ctm doctor` | 环境自检 |
| `ctm room <动作> <频道> [内容]` | 组内讨论频道，见下文 |

在你和 Claude 的对话里敲：

| 斜杠命令 | 作用 |
|---|---|
| `/ctm:list` | 看同组会话、状态、未读数 |
| `/ctm:ask web 问题` | 提问，等它回答；窗口没开会自动拉起 |
| `/ctm:tell web 通知内容` | 单向通知，不等回答 |
| `/ctm:reply <消息id> 内容` | 回复收件箱里的某条消息 |
| `/ctm:start web` | 只把会话拉起来，不发消息 |
| `/ctm:room ...` | 讨论频道，见下文 |

---

## 窗口关了还能收到消息吗

能。只要某个会话**至少被 `ctm new` 启动过一次**，它的注册信息就留在 `~/.ctm/` 里，之后窗口关掉也能被重新拉起来。

流程是这样的：

1. 消息先写进目标会话的收件箱并落盘，不会丢
2. ctm 发现它离线，就在一个新的终端窗口里按原样重新启动它（连同分组和启动参数）
3. 新窗口启动完成后，收件箱里的消息会作为用户输入被提交
4. 你能在那个窗口里直接看到这条消息和 Claude 的回答

本机实测：从发消息到收到回答约 25 秒。

**注意**：只有 `ctm` 启动的会话才有收消息的通道。你直接敲 `claude` 开的普通会话收不到消息（但可以发）。

**`ctm kill` 会删掉注册信息**，被 kill 的会话就再也拉不起来了。想保留「随时能唤醒」的能力，直接关窗口或 `Ctrl+C`，别用 `kill`。

---

## 让 `claude` 命令直接变成托管会话

不想每次记 `ctm new`，可以生成一个包装脚本：

```bash
ctm install-wrap
```

它会在 `~/.ctm/bin/` 里生成一个包装脚本（Windows 上是 `claude.cmd`），把这个目录放到 PATH 最前面即可：

```bat
:: CMD
set PATH=%USERPROFILE%\.ctm\bin;%PATH%
```

```powershell
# PowerShell
$env:PATH = "$env:USERPROFILE\.ctm\bin;$env:PATH"
```

> **Git Bash 用不了这个包装**：Windows 上只生成 `claude.cmd`，而 Git Bash 不认 `.cmd`。在 Git Bash 里请直接用 `ctm new`。

之后：

```text
claude                      → 自动变成托管会话，名字取当前目录名
claude --resume             → 交互式，仍然托管
claude --version / -p / mcp → 原样透传给真正的 claude，不受影响
```

同一目录重复打开会自动加后缀（`web-2`、`web-3`）。

**这一步只需要做一次，而且完全可选**——不做也能用 `ctm new`。只有换了 Node 安装、移动了 ctm 目录或重装过 ctm 时，包装脚本里记录的绝对路径会失效，需要重新执行一次。

---

## 分组：只有同一组才互相看得见

会话在启动时归组。组内互通，组间**双向隔离**：列表里看不见，发消息也会被拒绝。

```bash
ctm new a --group frontend
ctm new b --group frontend
ctm new d --group backend
```

- 一个会话可以属于多个组，交集即桥接：`ctm new b --group frontend --group shared`
- **没有组的会话是独立单组**，只看得见自己
- 组的来源优先级：启动参数 `--group` > 环境变量 `CTM_GROUP` > 项目里的 `.ctm.json`

项目内固定分组，不必每次带参数：

```json
// D:/projects/web/.ctm.json
{ "group": "frontend" }
```

> 分组是**协作边界，不是安全边界**。它防止的是会话之间的意外串扰，同一台机器的同一个用户仍然可以直接读写 `~/.ctm/`。

---

## 讨论频道：一组人聊同一个话题

频道属于一个组，组外看不见也发不进来。

```bash
ctm room create api 认证接口怎么改 --group frontend   # 建频道
ctm room start api 第一轮：字段命名                  # 把议题投递给同组每个人
ctm room say api 先加版本号                          # 发言
ctm room show api                                    # 看发言
ctm room summary api                                 # 按轮次汇总成 summary.md
```

**不会自动多轮**：每轮都要显式 `start`，避免会话互相触发、token 失控。

---

## 已知限制

- 已开着的普通 `claude` 会话无法被接管，只能新开托管会话。
- 需要用户确认的操作（比如 `Write` 写文件、加载项目的 MCP server）ctm **不会替你点同意**。会话会显示为 `needs-input` 并暂停投递，你得去那个窗口按一下键。
- 你输入框里打了字又没发出去、超过 2 秒没变化时，投递仍可能和残留内容混在一起。
- 无桌面环境下按需启动只能用 `CTM_LAUNCH_MODE=background`，此时没有可视窗口。
- 从发消息到送达有几十秒延迟（要重新走一遍启动流程），期间消息安全地留在收件箱。
- `ctm install-wrap` 只生成脚本，**不修改 PATH**，需要你手动加一次。
- 讨论频道与分组一样，是协作边界而非安全边界。

---

## 环境要求

- Windows 10 1809+（ConPTY）
- Node.js 18+
- Claude Code 已安装并在 PATH 中（或用 `CTM_CLAUDE_BIN` 指定）

> macOS 目前只能跑，但按需启动会退化为后台模式（不会开新窗口）。Windows 是主要开发和验证平台。

### 环境变量

| 变量 | 作用 |
|---|---|
| `CTM_CLAUDE_BIN` | 指定 claude 可执行文件的绝对路径 |
| `CTM_HOME` | ctm 的数据目录，默认 `~/.ctm` |
| `CTM_GROUP` | 默认分组，等价于 `--group` |
| `CTM_LAUNCH_MODE` | 按需启动方式：`window`（默认）\| `background` |
| `CTM_NO_PLUGIN` | 设为 `1` 时不自动加载 ctm 插件，排查启动问题用 |

---

## 更多

- 动画版指南：[`docs/guide.html`](docs/guide.html)
- 改代码、打包、发布、Claude Code 版本解析： [`docs/DEVELOPERS.md`](docs/DEVELOPERS.md)
- 源码：https://github.com/renhao-wan/ctm

## License

MIT
