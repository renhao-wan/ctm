// 会话收件箱：跨进程投递的落盘队列。
//
// 设计取舍：
//   - 只追加（append-only），宿主不重写 inbox，避免与发送方并发追加冲突
//   - 已投递记录单独写入 delivered.log，同样是追加
//   - 发送方是任意进程（插件 MCP server、CLI），宿主是唯一消费者
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionDir, readMeta } from './registry.mjs';

export function inboxPath(name) {
  return path.join(sessionDir(name), 'inbox.jsonl');
}

export function deliveredPath(name) {
  return path.join(sessionDir(name), 'delivered.log');
}

export class UnknownSessionError extends Error {
  constructor(name) {
    super(`会话不存在或未在运行：${name}`);
    this.name = 'UnknownSessionError';
  }
}

/** 投递一条消息。目标离线也允许：消息留在收件箱，等会话重新启动后补投。 */
export function enqueue({ to, from, fromCwd, text, kind = 'tell' }) {
  const meta = readMeta(to);
  if (!meta) throw new UnknownSessionError(to);
  if (!text || !text.trim()) throw new Error('消息内容为空');

  const msg = {
    id: crypto.randomUUID(),
    from: from || 'unknown',
    fromCwd: fromCwd || '',
    to,
    kind,
    text,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(sessionDir(to), { recursive: true });
  fs.appendFileSync(inboxPath(to), JSON.stringify(msg) + '\n');
  return msg;
}

/** 读取收件箱；写到一半的行会被跳过。 */
export function readInbox(name) {
  let raw;
  try {
    raw = fs.readFileSync(inboxPath(name), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 半行：忽略
    }
  }
  return out;
}

export function readDelivered(name) {
  try {
    return new Set(
      fs
        .readFileSync(deliveredPath(name), 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function markDelivered(name, id) {
  fs.appendFileSync(deliveredPath(name), id + '\n');
}

/** 注入到目标会话的文本。前缀必须足够长，短前缀无法让模型识别来源。 */
export function formatMessage(msg) {
  const where = msg.fromCwd ? `，工作区 ${msg.fromCwd}` : '';
  const who = msg.from === '用户' ? '用户' : `会话 ${msg.from}`;
  // 短 id 让模型能引用某条消息（/ctm:reply <id> <text>）
  const ref = msg.id ? ` · #${String(msg.id).slice(0, 8)}` : '';
  return `[来自${who}${where}${ref}] ${msg.text}`;
}

/** 按完整 id 或短 id 前缀在当前会话的收件箱里找消息。 */
export function findMessage(name, idPrefix) {
  const key = String(idPrefix || '').trim();
  if (!key) return null;
  return (
    readInbox(name).find((m) => m.id === key || String(m.id).startsWith(key)) || null
  );
}

/** 未投递的消息，按写入顺序。 */
export function pendingMessages(name, delivered = readDelivered(name)) {
  return readInbox(name).filter((m) => !delivered.has(m.id));
}
