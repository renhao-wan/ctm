# ctm — Claude Terminal Multiplexer

用 ConPTY 托管 Claude Code 交互式会话，让同一台机器上的多个会话可以互相发消息、感知状态、按组讨论，而不修改 Claude Code 本身。

> 当前状态：M1（宿主 + 单会话托管 + 状态机）冒烟通过。设计与验证文档在仓库外层的 `../cc-wrapped/`：`ctm-design.md`、`ctm-verified-findings.md`、`ctm-verification-plan.md`。

---

## 快速开始

```bash
npm install
node src/main.mjs doctor          # 环境自检
node src/main.mjs new web --cwd D:/projects/web
node src/main.mjs list
node src/main.mjs kill web
```

`ctm new` 会接管当前终端：输入输出透传给托管的 `claude`，Ctrl+C 结束。

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
- 工具权限确认会阻塞轮次：默认权限模式下 `Write` 等操作需要用户确认，`Stop` 不会到达。M1 由用户手动确认；M2 的自动投递需要先识别并暴露该状态。
- 信任提示的自动选择依赖当前布局（`❯` 紧邻选项文本）。布局变化时不猜按键，会话会停在启动阶段直到超时，需要用户手动处理。
- 首条消息：2.1.319 单会话冒烟 6/6 成功，但 5 会话并发启动时实测 4/5 失败。多会话场景（M2）需要重新验证，防御措施（settle + 提交确认）保留。

---

## 目录

```text
src/
  main.mjs              CLI
  session.mjs           PTY 宿主与状态机驱动
  tui.mjs               ANSI 清洗、就绪判定、启动状态机
  resolve-claude.mjs    claude 可执行文件解析
  hooks.mjs             临时 hook 配置生成
  hook-probe.cjs        hook 事件落盘
  registry.mjs          会话注册表
test/
  unit-tui.mjs          TUI 判定逻辑单元测试
  m1-smoke.mjs          M1 单会话冒烟测试
```

设计阶段的验证脚本（`v*.mjs`、`diag-*.mjs`）与原始记录在 `../cc-wrapped/verify/`，不属于本工程。
