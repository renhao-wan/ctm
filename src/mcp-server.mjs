#!/usr/bin/env node
// ctm 插件的 MCP server。
//
// 插件通过 .mcp.json 启动本进程（stdio），对外提供：
//   ctm_list / ctm_status   查看托管会话
//   ctm_tell / ctm_ask      向托管会话投递消息
//
// 投递只是往目标会话的收件箱追加；真正的写入由目标会话的 ctm 宿主完成，
// 因此这里不需要常驻 PTY，也不会因为宿主忙碌而阻塞。
import { createInterface } from 'node:readline';
import { listSessions, readMeta, isAlive } from './registry.mjs';
import { enqueue, pendingMessages, readDelivered } from './inbox.mjs';

const SENDER = process.env.CTM_SESSION_NAME || 'claude';
const SENDER_CWD = process.cwd();

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
    description: '列出所有由 ctm 托管的 Claude Code 会话，包括状态、工作目录和未读消息数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ctm_status',
    description: '查看单个托管会话的详细状态。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '会话名' } },
      required: ['name'],
    },
  },
  {
    name: 'ctm_tell',
    description: '向另一个托管会话发送单向通知。消息会在对方空闲时作为一条用户输入送达。',
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
    description: '向另一个托管会话提问，语义与 ctm_tell 相同，但标记为提问。',
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
  const status = alive ? m.status || 'unknown' : 'dead';
  const unread = alive ? pendingMessages(m.name, readDelivered(m.name)).length : 0;
  return {
    名称: m.name,
    状态: status,
    未读: unread,
    目录: m.cwd,
    版本: m.version || '',
  };
}

function handleCall(id, name, args) {
  try {
    if (name === 'ctm_list') {
      const list = listSessions().map(describe);
      return toolResult(id, JSON.stringify(list, null, 2));
    }

    if (name === 'ctm_status') {
      const meta = readMeta(args.name);
      if (!meta) return toolResult(id, `会话不存在：${args.name}`, true);
      return toolResult(id, JSON.stringify(describe(meta), null, 2));
    }

    if (name === 'ctm_tell' || name === 'ctm_ask') {
      const msg = enqueue({
        to: args.to,
        from: SENDER,
        fromCwd: SENDER_CWD,
        text: args.text,
        kind: name === 'ctm_ask' ? 'ask' : 'tell',
      });
      return toolResult(
        id,
        JSON.stringify({ ok: true, id: msg.id, to: msg.to, note: '已写入收件箱，目标空闲时送达' }, null, 2),
      );
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
