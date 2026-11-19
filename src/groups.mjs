// 分组可见性与 claude 包装的纯逻辑。
//
// 规则（用户确认）：
//   - 会话在启动时用 --group 归组，可以属于多个组
//   - 有组的会话：只看得见组内有交集的会话，跨组连发消息也拒绝
//   - 没有组的会话：视为“独立单组”，只看得见自己
//   - 没有会话身份的操作者（普通 claude 里没包装的插件、CLI）：视为用户本人，不限制
//
// “没有身份”和“有身份但没有组”是两件事，不要混：前者是人在用，后者是 AI 会话。
import fs from 'node:fs';
import path from 'node:path';
import { isValidSessionName } from './registry.mjs';

export function normalizeGroups(input) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    for (const part of String(v).split(',')) {
      const g = part.trim();
      if (g && !out.includes(g)) out.push(g);
    }
  };
  if (Array.isArray(input)) for (const v of input) push(v);
  else push(input);
  return out;
}

export function groupsOf(meta) {
  return new Set(Array.isArray(meta?.groups) ? meta.groups.map(String).filter(Boolean) : []);
}

/** 是否代表某个具体会话。空名字表示“人”，不做分组隔离。 */
export function isIdentified(me) {
  return !!(me && me.name);
}

/**
 * me 能否看见 other（列表可见 + 允许发消息）。
 * 两个无组会话之间不可见：各自是独立单组。
 */
export function visibleTo(me, other) {
  if (!other) return false;
  if (!isIdentified(me)) return true;
  if (me.name === other.name) return true;

  const a = groupsOf(me);
  const b = groupsOf(other);
  if (a.size === 0 || b.size === 0) return false;
  for (const g of a) if (b.has(g)) return true;
  return false;
}

export function describeGroups(meta) {
  const g = [...groupsOf(meta)];
  return g.length ? g.join(',') : '(独立)';
}

/** 项目级默认组：<cwd>/.ctm.json 里的 group 或 groups。 */
export function readProjectGroups(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.ctm.json'), 'utf8'));
    return normalizeGroups(j.groups ?? j.group);
  } catch {
    return [];
  }
}

/** 组来源优先级：命令行 --group > 环境变量 CTM_GROUP > 项目 .ctm.json。 */
export function resolveGroups({ cliGroups, cwd, env = process.env } = {}) {
  const cli = normalizeGroups(cliGroups);
  if (cli.length) return cli;
  const fromEnv = normalizeGroups(env.CTM_GROUP);
  if (fromEnv.length) return fromEnv;
  return cwd ? readProjectGroups(cwd) : [];
}

const RESERVED_CHARS = /[^\p{L}\p{N}._-]+/gu;

/** 把任意字符串清洗成合法会话名：非法字符换成 -，去掉首尾的点与横线。 */
export function cleanSessionName(input) {
  const clean = String(input ?? '')
    .replace(RESERVED_CHARS, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  // 与 registry 的 64 字符上限保持一致；截断后可能又露出首尾的点/横线
  const capped = clean.slice(0, 64).replace(/^[.\-]+|[.\-]+$/g, '');
  return isValidSessionName(capped) ? capped : 'session';
}

/** 用目录名作为默认会话名，非法字符替换为 -。 */
export function sessionNameFor(cwd) {
  const base = path.basename(path.resolve(cwd || '.')) || 'session';
  return cleanSessionName(base);
}

// 这些参数或子命令属于“非交互用法”，必须原样透传，不能套宿主。
const PASSTHROUGH_FLAGS = new Set([
  '-p',
  '--print',
  '--version',
  '-v',
  '-h',
  '--help',
  '--settings',
]);
const PASSTHROUGH_COMMANDS = new Set([
  'mcp',
  'config',
  'doctor',
  'update',
  'install',
  'migrate-installer',
  'setup-token',
  'agents',
  'plugin',
]);

/**
 * 判断 claude 的参数是否应该绕过 ctm 直接执行。
 * 无参数 = 交互式启动，交给我们托管。
 */
export function shouldPassthrough(argv) {
  for (const a of argv || []) {
    if (a === '--') break;
    if (PASSTHROUGH_FLAGS.has(a)) return true;
    if (!a.startsWith('-') && PASSTHROUGH_COMMANDS.has(a)) return true;
  }
  return false;
}
