'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const bus = require('./bus');
const adapters = require('./adapters');
const control = require('./control');
const router = require('./router');

// 启动时给存量任务补任务编号
store.migrateSeq();

// ===== 指挥指令队列（优先级高于普通任务，专供阿Q 解析执行） =====
const COMMANDING_FILE = path.join(store.DATA, 'commanding.jsonl');

function readCommanding() {
  try {
    return fs.readFileSync(COMMANDING_FILE, 'utf8').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (_) { return []; }
}

function writeCommanding(items) {
  fs.writeFileSync(COMMANDING_FILE, items.slice().reverse().map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
}

function handleCommanding(req, res, urlPathname) {
  if (req.method === 'GET') {
    // 指令状态以它派出去的任务为准，避免队列里永远显示"执行中"
    const byId = new Map(store.listTasks().map((t) => [t.id, t]));
    const items = readCommanding().slice(0, 50).map((o) => {
      const t = o.taskId ? byId.get(o.taskId) : null;
      if (!t) return o;
      let status = o.status;
      if (t.status === 'queued' || t.status === 'running') status = 'processing';
      else if (t.status === 'done') status = 'done';
      else if (t.status === 'failed' || t.status === 'cancelled') status = 'failed';
      const text = t.status === 'done' ? t.result : (t.status === 'failed' ? t.error : null);
      return Object.assign({}, o, { status, result: text || o.result, taskStatus: t.status });
    });
    return sendJson(res, 200, { items });
  }
  if (req.method === 'POST' && urlPathname === '/api/commanding') {
    return readBody(req).then((body) => {
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: '指挥指令不能为空' });
      const prev = readCommanding();
      const item = {
        id: store.uid('o'),
        seq: ((prev[0] && prev[0].seq) || 0) + 1,
        ts: store.now(),
        text,
        status: 'pending',
        result: null
      };

      // 关键：指挥指令不是留言板，能派就当场派出去
      let plan = null;
      try { plan = router.parseCommand(text); } catch (_) { plan = null; }
      const agent = plan && plan.agentId !== 'delegate' ? adapters.get(plan.agentId) : null;
      const executable = !!(plan && plan.agentId !== 'delegate' && agent && agent.available);

      if (executable) {
        try {
          const task = store.createTask({
            title: plan.title || '指挥指令 #' + item.seq,
            agentId: plan.agentId,
            prompt: plan.prompt,
            timeoutMs: plan.agentId === 'imagegen' ? 300000 : undefined
          });
          item.taskId = task.id;
          item.agentId = plan.agentId;
          item.status = 'processing';
          item.note = plan.note || '';
          item.result = '已派给 ' + plan.agentId + '（任务 ' + task.id + '）';
          bus.emit({
            type: 'commanding', taskId: task.id, agentId: task.agentId, level: 'info',
            message: '指挥指令 #' + item.seq + ' 已派单 → ' + plan.agentId,
            data: { title: task.title, note: plan.note, raw: text.slice(0, 200) }
          });
        } catch (e) {
          item.result = '派单失败：' + e.message;
        }
      } else {
        // 需要总指挥（阿Q）判断的，明确挂起，不再装作已执行
        item.status = 'pending';
        item.note = (plan && plan.note) || '需总指挥解析';
        item.result = '待总指挥接手';
        bus.emit({
          type: 'commanding', level: 'warn',
          message: '指挥指令 #' + item.seq + ' 待总指挥接手：' + text.slice(0, 60), data: item
        });
      }

      fs.appendFileSync(COMMANDING_FILE, JSON.stringify(item) + '\n', 'utf8');
      sendJson(res, 200, { item });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  if (req.method === 'POST' && urlPathname === '/api/commanding/action') {
    return readBody(req).then((body) => {
      const items = readCommanding().reverse();
      const target = items.find((i) => i.id === body.id);
      if (!target) return sendJson(res, 404, { error: '指挥指令不存在' });
      if (body.action === 'ack') target.status = 'processing';
      if (body.action === 'result') { target.status = 'done'; target.result = String(body.result || ''); }
      if (body.action === 'delete') target.status = 'deleted';
      writeCommanding(items);
      sendJson(res, 200, { item: target });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  return sendJson(res, 404, { error: 'Not Found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function publicAgents() {
  return adapters.list().map((a) => ({
    id: a.id, name: a.name, kind: a.kind, color: a.color,
    description: a.description, available: !!a.available,
    builtin: !!a.builtin, installed: a.installed !== false,
    command: a.command || null
  }));
}

function buildState() {
  const tasks = store.listTasks();
  const meta = store.getMeta();
  const counts = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) {
    if (counts[task.status] !== undefined) counts[task.status] += 1;
  }
  return {
    tasks,
    agents: publicAgents(),
    stats: Object.assign({ total: tasks.length, paused: !!meta.paused, concurrency: meta.concurrency }, counts),
    serverTime: store.now()
  };
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(store.WEB, rel);
  const webRoot = path.resolve(store.WEB) + path.sep;
  if (!target.startsWith(webRoot)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(target).pipe(res);
}

function serveArtifact(res, searchParams) {
  const rel = searchParams.get('path') || '';
  const target = path.resolve(store.ROOT, rel);
  const runsRoot = path.resolve(store.RUNS) + path.sep;
  if (!target.startsWith(runsRoot)) {
    return sendJson(res, 403, { error: '只能访问 runs/ 下的产物' });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return sendJson(res, 404, { error: '产物不存在' });
  }
  const ext = path.extname(target).toLowerCase();
  if (/\.(md|txt|json|log|js|py|html|css|csv)$/.test(ext)) {
    const text = fs.readFileSync(target, 'utf8');
    return sendJson(res, 200, { name: path.basename(target), text: text.slice(0, 200000) });
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  const send = (event) => {
    try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch (_) {}
  };
  const unsubscribe = bus.subscribe(send);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, buildState());
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    return sendJson(res, 200, { agents: publicAgents() });
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const limit = Number(url.searchParams.get('limit') || 300);
    return sendJson(res, 200, { events: bus.recent(limit) });
  }
  if (req.method === 'GET' && url.pathname === '/api/artifact') {
    return serveArtifact(res, url.searchParams);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    return handleSse(req, res);
  }
  if (req.method === 'GET' && parts[1] === 'task' && parts[3] === 'logs') {
    return sendJson(res, 200, { events: bus.forTask(parts[2]) });
  }

  if (url.pathname === '/api/commanding' || url.pathname === '/api/commanding/action') {
    return handleCommanding(req, res, url.pathname);
  }

  if (req.method === 'POST' && url.pathname === '/api/command') {
    // 总控台命令入口：解析 → 路由派发；解析不了的转 delegate 待阿Q
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: '命令不能为空' });
    const plan = router.parseCommand(text);
    const agentId = plan.agentId;
    const agent = agentId === 'delegate' ? null : adapters.get(agentId);
    if (agentId !== 'delegate' && (!agent || !agent.available)) {
      return sendJson(res, 400, { error: '解析为 ' + agentId + ' 但该 agent 不可用', note: plan.note });
    }
    const task = store.createTask({
      title: plan.title || '总控命令',
      agentId,
      prompt: plan.prompt,
      timeoutMs: agentId === 'imagegen' ? 300000 : undefined
    });
    bus.emit({ type: 'created', taskId: task.id, agentId: task.agentId, level: 'info',
      message: '总控台命令：' + (plan.note || ''), data: { title: task.title, agent: agentId, raw: text.slice(0, 200) } });
    return sendJson(res, 200, { taskId: task.id, agentId, note: plan.note });
  }

  if (req.method === 'POST' && url.pathname === '/api/task') {
    const body = await readBody(req);
    if (!body.prompt && !body.title) return sendJson(res, 400, { error: '需要 title 或 prompt' });
    const task = store.createTask({
      title: body.title, agentId: body.agentId, prompt: body.prompt,
      dependsOn: body.dependsOn, timeoutMs: body.timeoutMs, maxRetries: body.maxRetries
    });
    bus.emit({ type: 'created', taskId: task.id, agentId: task.agentId, level: 'info',
      message: '工作台派单：' + task.title, data: { title: task.title } });
    return sendJson(res, 200, { task });
  }

  if (req.method === 'POST' && parts[1] === 'task' && parts[3] === 'action') {
    const body = await readBody(req);
    try {
      const task = control.apply(body.action, parts[2], body);
      return sendJson(res, 200, { task });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/global') {
    const body = await readBody(req);
    if (body.action === 'pause') return sendJson(res, 200, { meta: control.setPaused(true) });
    if (body.action === 'resume') return sendJson(res, 200, { meta: control.setPaused(false) });
    if (body.action === 'purge') {
      // 一键清理已结束任务（已完成/失败/已取消），移出看板
      const finished = store.listTasks().filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
      for (const t of finished) {
        try { store.deleteTask(t.id); } catch (_) {}
        try { fs.unlinkSync(path.join(store.INBOX, t.id + '.md')); } catch (_) {}
      }
      bus.emit({ type: 'control', level: 'info',
        message: '总指挥清理已结束任务：' + finished.length + ' 条', data: { purged: finished.length } });
      return sendJson(res, 200, { purged: finished.length });
    }
    return sendJson(res, 400, { error: '未知全局操作' });
  }

  return sendJson(res, 404, { error: '未知接口 ' + url.pathname });
}

function createServer() {
  bus.startTailer(200);
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) {
      res.writeHead(400); return res.end('Bad Request');
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((error) => {
        sendJson(res, 500, { error: error.message });
      });
      return;
    }
    serveStatic(res, url.pathname);
  });
}

function listen(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, listen, buildState };
