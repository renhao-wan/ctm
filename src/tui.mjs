// TUI 文本处理与就绪判定。
//
// 所有标记都是实测得到的，不要凭直觉改：
//   2.1.234：❯ + "? for shortcuts" + "← for agents"
//   2.1.319：❯ + "⏵⏵ auto mode" + "← for agents"
// 用「输入提示符 + 任一状态栏标记」组合，两个版本都成立。
// 只匹配状态栏会在启动画面阶段误判，只匹配提示符会漏掉语法高亮等场景。

export const INPUT_PROMPT = '❯';

export const READY_MARKERS = [
  '⏵⏵automode', // 2.1.319
  '←foragents', // 2.1.234 / 2.1.319
  '?forshortcuts', // 2.1.234
];

export const BUSY_MARKERS = ['esctointerrupt'];

// 信任提示的两个变体都包含 "trust this folder"：
//   "Yes, I trust this folder"
//   "I don't trust this folder"
// 归一化去空格后用 trustthisfolder 可以同时命中。
const TRUST_MARKERS = ['trustthisfolder'];
const FULLSCREEN_MARKERS = ['fullscreenrenderer'];
// 项目里存在 .mcp.json 时，claude 启动会要求确认是否加载其中的 MCP server。
// 这等于授权执行第三方代码，不能由 ctm 代替用户按回车。
const MCP_MARKERS = ['mcpserverfoundinthisproject'];

export const TRUST_SELECTION = { NO: 'no', YES: 'yes', UNKNOWN: 'unknown' };

/**
 * 判断信任提示当前选中哪一项。
 *
 * 2.1.319 实测：默认选中 "No, exit"，直接写 \r 会让 claude 以 code=1 退出。
 * 归一化后的屏幕是 "…❯no,exityes,itrustthisfolderentertoconfirm·esctocancel"，
 * 选中项紧跟在 ❯ 之后，因此按 ❯ 之后的文本判断。
 */
export function trustSelection(t) {
  const i = t.lastIndexOf(INPUT_PROMPT);
  if (i < 0) return TRUST_SELECTION.UNKNOWN;
  const tail = t.slice(i + INPUT_PROMPT.length);
  if (tail.startsWith('no,exit')) return TRUST_SELECTION.NO;
  if (tail.startsWith('yes,')) return TRUST_SELECTION.YES;
  return TRUST_SELECTION.UNKNOWN;
}

/** 去掉 ANSI 转义序列与光标定位，保留可见文本 */
export function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '\n');
}

/** 匹配用的归一化：去 ANSI、转小写、去空格 */
export function normalize(s) {
  return stripAnsi(s).toLowerCase().replace(/ /g, '');
}

export function isReadyText(t) {
  return t.includes(INPUT_PROMPT) && READY_MARKERS.some((m) => t.includes(m));
}

export function isBusyText(t) {
  return BUSY_MARKERS.some((m) => t.includes(m));
}

export function isTrustPrompt(t) {
  return TRUST_MARKERS.some((m) => t.includes(m));
}

export function isFullscreenPrompt(t) {
  return FULLSCREEN_MARKERS.some((m) => t.includes(m));
}

export function isMcpPrompt(t) {
  // 只看屏幕末尾：raw 是累积缓冲，提示关闭后历史文本仍会留在前面
  const tail = t.slice(-2000);
  return MCP_MARKERS.some((m) => tail.includes(m));
}

/**
 * 保留最近 N 字节的屏幕缓冲。
 * 必须限额：PTY 会话可能连续输出数小时，不截断会无限增长。
 */
export class ScreenBuffer {
  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes;
    this.raw = '';
  }

  append(chunk) {
    this.raw += chunk;
    if (this.raw.length > this.maxBytes) {
      this.raw = this.raw.slice(-this.maxBytes);
    }
  }

  text() {
    return normalize(this.raw);
  }
}

/**
 * 启动阶段状态机。
 * 每一步返回需要写入的按键序列，null 表示继续等待。
 *
 * 阶段：starting → ready → settled
 * 信任提示与 fullscreen 提示可各出现一次。
 */
export class Bootstrap {
  constructor({ settleMs = 3000, timeoutMs = 90000 } = {}) {
    this.phase = 'starting';
    this.startedAt = Date.now();
    this.readyAt = null;
    this.settleMs = settleMs;
    this.timeoutMs = timeoutMs;
    this.trustAnswered = false;
    this.trustDowns = 0;
    this.lastTrustKeyAt = 0;
    this.fullscreenAnswered = false;
    this.unknownSince = null;
  }

  /**
   * @param {string} t 归一化后的屏幕文本
   * @returns {'enter'|'trust-down'|'trust-unknown'|'not-now'|'needs-input'|'ready'|'settled'|'waiting'|'timeout'|'done'}
   *   'settled' 只返回一次；之后返回 'done'，由调用方停止接管状态，
   *   否则启动状态机会每轮 tick 把 hook 设置的 busy 覆盖成 idle。
   */
  step(t) {
    if (this.phase === 'done') return 'done';

    if (this.phase === 'ready') {
      if (Date.now() - this.readyAt >= this.settleMs) {
        this.phase = 'done';
        return 'settled';
      }
      return 'waiting';
    }

    if (!this.trustAnswered && isTrustPrompt(t)) {
      const sel = trustSelection(t);
      const now = Date.now();

      if (sel === TRUST_SELECTION.YES) {
        // 刚按过方向键时等重绘稳定，避免 Enter 落在旧焦点上
        if (now - this.lastTrustKeyAt < 500) return 'waiting';
        this.trustAnswered = true;
        return 'enter';
      }

      if (sel === TRUST_SELECTION.NO) {
        // 信任提示的默认项是否定项，直接回车会让 claude 退出。
        // 按键可能被尚未就绪的 TUI 吞掉，因此按节流反复下移到 Yes。
        if (now - this.lastTrustKeyAt < 800) return 'waiting';
        this.lastTrustKeyAt = now;
        this.trustDowns++;
        if (this.trustDowns > 5) return 'trust-unknown';
        return 'trust-down';
      }

      // 布局不认识：不动，等用户手动处理或超时
      return 'trust-unknown';
    }

    if (!this.fullscreenAnswered && isFullscreenPrompt(t)) {
      this.fullscreenAnswered = true;
      return 'not-now';
    }

    if (isMcpPrompt(t)) {
      // MCP server 可以执行任意代码，授权必须由用户做出，宿主不代按
      this.startedAt = Date.now();
      return 'needs-input';
    }

    if (isReadyText(t)) {
      this.phase = 'ready';
      this.readyAt = Date.now();
      return 'ready';
    }

    if (Date.now() - this.startedAt > this.timeoutMs) {
      this.phase = 'timeout';
      return 'timeout';
    }

    return 'waiting';
  }
}
