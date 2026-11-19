// 组内讨论频道。
//
// 设计取舍：
//   - 一个频道一个目录：~/.ctm/rooms/<room>/，meta.json + messages.jsonl + summary.md
//   - 发言只追加，不改写历史
//   - 不做自动多轮：每轮由 startRound 显式发起，避免消息在会话之间失控扩散
//   - 频道归属一个组；组外会话既看不到也发不进来
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ctmHome } from './registry.mjs';
import { enqueue } from './inbox.mjs';

const RESERVED = /[^\p{L}\p{N}._-]+/gu;
// 与 registry 一致：这些名字在 Windows 上无法作为目录名
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 频道名只保留安全字符，避免路径穿越与跨平台文件名问题。 */
export function normalizeRoomName(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('频道名不能为空');
  const clean = s.replace(RESERVED, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (!clean || clean === '.' || clean === '..') throw new Error(`频道名不合法：${s}`);
  if (WINDOWS_RESERVED.test(clean)) throw new Error(`频道名不合法（Windows 保留名）：${s}`);
  if (clean.length > 64) throw new Error(`频道名过长（最多 64 个字符）：${s}`);
  return clean;
}

export function roomDir(name) {
  return path.join(ctmHome(), 'rooms', normalizeRoomName(name));
}

export function readRoom(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(roomDir(name), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeRoom(name, meta) {
  const dir = roomDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `meta.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, 'meta.json'));
  return meta;
}

export function createRoom({ name, topic = '', group = '', createdBy = '' }) {
  const safe = normalizeRoomName(name);
  const existing = readRoom(safe);
  if (existing) {
    if (topic && existing.topic !== topic) {
      const meta = { ...existing, topic, updatedAt: new Date().toISOString() };
      return writeRoom(safe, meta);
    }
    return existing;
  }
  const now = new Date().toISOString();
  return writeRoom(safe, {
    name: safe,
    topic: String(topic || '').trim(),
    group: String(group || '').trim(),
    createdBy: createdBy || '',
    createdAt: now,
    updatedAt: now,
    round: 0,
  });
}

/** 没有会话身份的是人：不受组限制。 */
export function roomVisible(me, room) {
  if (!room) return false;
  if (!me || !me.name) return true;
  const mine = Array.isArray(me.groups) ? me.groups : [];
  if (!room.group) return mine.length === 0;
  return mine.includes(room.group);
}

/**
 * 会话是否属于频道受众。
 * 无组频道只面向无组会话，不能因为 room.group === '' 就投给所有人。
 */
export function inRoomAudience(meta, room) {
  const groups = Array.isArray(meta?.groups) ? meta.groups : [];
  if (!room || !room.group) return groups.length === 0;
  return groups.includes(room.group);
}

export function listRooms(me) {
  const root = path.join(ctmHome(), 'rooms');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readRoom(e.name))
    .filter(Boolean)
    .filter((r) => roomVisible(me, r))
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
}

export function messagesPath(name) {
  return path.join(roomDir(name), 'messages.jsonl');
}

export function appendSay({ room, from = '用户', fromCwd = '', text, round }) {
  const meta = readRoom(room);
  if (!meta) throw new Error(`频道不存在：${room}`);
  if (!text || !String(text).trim()) throw new Error('发言内容为空');
  const msg = {
    id: crypto.randomUUID(),
    room: meta.name,
    from: from || '用户',
    fromCwd: fromCwd || '',
    round: Number(round ?? meta.round ?? 0),
    text: String(text),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(roomDir(room), { recursive: true });
  fs.appendFileSync(messagesPath(room), JSON.stringify(msg) + '\n');
  writeRoom(room, { ...meta, updatedAt: msg.createdAt });
  return msg;
}

export function readMessages(room, limit = 200) {
  let raw;
  try {
    raw = fs.readFileSync(messagesPath(room), 'utf8');
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
  return limit > 0 ? out.slice(-limit) : out;
}

/**
 * 发起一轮讨论：把议题投递到目标会话的收件箱，并把轮次加一。
 * 目标是否离线不影响入队；宿主启动后会补投。
 */
export function startRound({ room, issue = '', from = '用户', fromCwd = '', targets = [] }) {
  const meta = readRoom(room);
  if (!meta) throw new Error(`频道不存在：${room}`);
  const round = (meta.round || 0) + 1;
  const topic = String(issue || meta.topic || '').trim();
  if (!topic) throw new Error('频道没有议题，请先设置 topic 或传入本轮议题');

  writeRoom(room, { ...meta, round, updatedAt: new Date().toISOString() });
  // 议题本身也记入频道，summary 才看得出每轮在讨论什么
  appendSay({ room: meta.name, from: '议题', text: topic, round });
  const text = `[讨论 ${meta.name} · 第 ${round} 轮] ${topic}\n用 /ctm:room say ${meta.name} <你的看法> 发言。`;
  const sent = [];
  for (const to of targets) {
    try {
      enqueue({ to, from, fromCwd, text, kind: 'room' });
      sent.push(to);
    } catch {
      // 目标 meta 已不存在：跳过，不影响其他成员
    }
  }
  return { round, sent };
}

/** 把频道发言整理成 summary.md，返回文件路径。 */
export function writeSummary(room) {
  const meta = readRoom(room);
  if (!meta) throw new Error(`频道不存在：${room}`);
  const messages = readMessages(room, 0);
  const lines = [`# ${meta.topic || meta.name}`, '', `频道：${meta.name}　组：${meta.group || '(独立)'}`, ''];
  const rounds = [...new Set(messages.map((m) => m.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    lines.push(`## 第 ${r} 轮`);
    for (const m of messages.filter((x) => x.round === r)) {
      lines.push(`- **${m.from}**：${String(m.text ?? '').replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  if (!messages.length) lines.push('（还没有发言）');
  const file = path.join(roomDir(room), 'summary.md');
  fs.mkdirSync(roomDir(room), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}
