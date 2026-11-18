#!/usr/bin/env node
// ctm 插件的 MCP server。
//
// 插件通过 .mcp.json 启动本进程（stdio），对外提供：
//   ctm_list / ctm_status   查看托管会话
//   ctm_start               拉起离线会话
//   ctm_tell / ctm_ask      向托管会话投递消息
//
// 投递只是往目标会话的收件箱追加；真正的写入由目标会话的 ctm 宿主完成，
// 因此这里不需要常驻 PTY，也不会因为宿主忙碌而阻塞。
// 目标离线时，本进程会按 meta.json 记录重新拉起目标宿主（新终端窗口），
// 宿主启动后自行从收件箱补投。
import { createInterface } from 'node:readline';
import { listSessions, readMeta, isAlive } from './registry.mjs';
import { enqueue, pendingMessages, readDelivered } from './inbox.mjs';
import { launchSession } from './launch.mjs';
import { visibleTo, describeGroups } from './groups.mjs';

const SENDER = process.env.CTM_SESSION_NAME || 'claude';
const SENDER_CWD = process.cwd();

/** 当前会话的身份。没有 CTM_SESSION_NAME 表示操作者是人（普通 claude 或 CLI）。 */
function meMeta() {
  const name = process.env.CTM_SESSION_NAME || '';
  if (!name) return { name: '', groups: [] };
  return readMeta(name) || { name, groups: [] };
}

/** 目标是否存在且对当前会话可见。不可见时统一按“不存在”处理，不泄露存在性。 */
function reachable(name) {
  const meta = readMeta(name);
  if (!meta) return { ok: false, meta: null };
  if (!visibleTo(meMeta(), meta)) return { ok: false, meta: null };
  return { ok: true, meta };
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(id, text, isError = false) {
  ok(id, { content: [{ type: 'text', text }], isError });
}

const TOOLS = [
  {
    name: 'ctm_list',
    description: '列出当前分组可见的托管 Claude Code 会话，包括状态、组、工作目录和未读消息数。',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '显示全部会话，忽略分组可见性（仅用于排查）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ctm_status',
    description: '查看单个同组托管会话的详细状态。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '会话名' } },
      required: ['name'],
    },
  },
  {
    name: 'ctm_start',
    description: '启动一个已配置但当前未运行的同组托管会话。会在新的终端窗口中打开。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '会话名' } },
      required: ['name'],
    },
  },
  {
    name: 'ctm_tell',
    description: '向同组的另一个托管会话发送单向通知。消息会在对方空闲时作为一条用户输入送达；对方离线时保存在收件箱并尝试启动会话。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标会话名' },
        text: { type: 'string', description: '消息内容' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'ctm_ask',
    description: '向同组的另一个托管会话提问，语义与 ctm_tell 相同，但标记为提问。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标会话名' },
        text: { type: 'string', description: '问题内容' },
      },
      required: ['to', 'text'],
    },
  },
];

function describe(m) {
  const alive = isAlive(m.pid);
  const status = alive ? m.status || 'unknown' : 'offline';
  const unread = pendingMessages(m.name, readDelivered(m.name)).length;
  return {
    名称: m.name,
    状态: status,
    组: describeGroups(m),
    未读: unread,
    目录: m.cwd,
    版本: m.version || '',
  };
}

function ensureRunning(name) {
  const meta = readMeta(name);
  if (!meta) return { running: false, launched: false, reason: 'unknown-session' };
  if (isAlive(meta.pid)) return { running: true };
  const r = launchSession(name);
  return { running: false, launched: r.started, reason: r.reason };
}

/** 尝试把离线目标拉起来；拉起是尽力而为，失败不影响消息已入队这一事实。 */
function startNote(r) {
  if (r.running) return '目标在线，消息将在其空闲时送达';
  if (r.launched) return '目标离线，消息已保存，正在启动目标会话';
  if (r.reason === 'unknown-session') return '会话不存在';
  if (r.reason === 'launching') return '目标离线，消息已保存，启动进行中';
  return `目标离线，消息已保存，自动启动失败（${r.reason}）`;
}

function handleCall(id, name, args) {
  try {
    if (name === 'ctm_list') {
      const me = meMeta();
      const all = args.all === true;
      const list = listSessions()
        .filter((m) => all || visibleTo(me, m))
        .map(describe);
      const content = [{ type: 'text', text: JSON.stringify(list, null, 2) }];
      if (!all && list.length === 0 && me.name) {
        content.push({
          type: 'text',
          text: `当前会话 ${me.name} 没有可见的托管会话（组：${describeGroups(me)}）。同组会话需要用 ctm new <名字> --group <组> 启动。`,
        });
      }
      return ok(id, { content });
    }

    if (name === 'ctm_status') {
      const r = reachable(args.name);
      if (!r.ok) return toolResult(id, `会话不存在或不在当前可见组内：${args.name}`, true);
      return toolResult(id, JSON.stringify(describe(r.meta), null, 2));
    }

    if (name === 'ctm_tell' || name === 'ctm_ask') {
      const target = reachable(args.to);
      if (!target.ok) return toolResult(id, `会话不存在或不在当前可见组内：${args.to}`, true);
      const msg = enqueue({
        to: args.to,
        from: SENDER,
        fromCwd: SENDER_CWD,
        text: args.text,
        kind: name === 'ctm_ask' ? 'ask' : 'tell',
      });
      // 目标没开窗口时，由发送方负责把它拉起来
      const started = ensureRunning(args.to);
      return toolResult(
        id,
        JSON.stringify(
          { ok: true, id: msg.id, to: msg.to, target: started, note: startNote(started) },
          null,
          2,
        ),
      );
    }

    if (name === 'ctm_start') {
      const r = reachable(args.name);
      if (!r.ok) return toolResult(id, `会话不存在或不在当前可见组内：${args.name}`, true);
      const started = launchSession(args.name);
      if (started.started) {
        return toolResult(
          id,
          JSON.stringify({ ok: true, name: args.name, mode: started.mode, note: '正在启动' }, null, 2),
        );
      }
      if (started.reason === 'already-running') {
        return toolResult(id, JSON.stringify({ ok: true, name: args.name, note: '会话已在运行' }, null, 2));
      }
      return toolResult(id, `启动失败：${started.reason}`, true);
    }

    return toolResult(id, `未知工具：${name}`, true);
  } catch (e) {
    return toolResult(id, `失败：${e.message}`, true);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ctm', version: '0.2.0' },
    });
  }

  if (method === 'notifications/initialized') return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') return handleCall(id, params?.name, params?.arguments || {});

  fail(id, -32601, `未实现的方法：${method}`);
});

rl.on('close', () => process.exit(0));
