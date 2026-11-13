#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const bus = require('../lib/bus');
const adapters = require('../lib/adapters');
const control = require('../lib/control');
const doctor = require('../lib/doctor');
const { Runner } = require('../lib/runner');
const server = require('../lib/server');

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flags = {};
const positional = [];
const BOOLEAN_FLAGS = new Set(['json', 'follow', 'no-worker', 'help', 'reset']);

for (let i = 1; i < argv.length; i++) {
  const token = argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else {
    positional.push(token);
  }
}

function line(char = '-', width = 66) { return char.repeat(width); }

function pad(value, width) {
  const text = String(value == null ? '' : value);
  let size = 0;
  for (const ch of text) size += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - size));
}

function duration(task) {
  if (!task.startedAt) return '-';
  const end = task.finishedAt ? new Date(task.finishedAt) : new Date();
  return ((end - new Date(task.startedAt)) / 1000).toFixed(1) + 's';
}

const STATUS_LABEL = {
  queued: '排队中', running: '运行中', waiting: '待指挥',
  done: '已完成', failed: '失败', cancelled: '已取消'
};

function cmdInit() {
  store.ensure();
  console.log('工作台已初始化：' + store.ROOT);
  console.log('  data/tasks/     任务分片状态');
  console.log('  data/events.jsonl  统一事件流');
  console.log('  config/agents.json adapter 注册表');
  console.log('  runs/           每次执行的日志与产物');
  console.log('  inbox/          总指挥直领任务');
  console.log('  web/            可视化壳静态文件');
  console.log('\n下一步：node bin/agentctl.js demo');
}

function cmdAgents() {
  store.ensure();
  const agents = adapters.list();
  if (flags.json) return console.log(JSON.stringify(agents.map((a) => ({
    id: a.id, name: a.name, kind: a.kind, available: a.available, installed: a.installed !== false, description: a.description
  })), null, 2));
  console.log(line('='));
  console.log(pad('ID', 16) + pad('名称', 16) + pad('可用', 8) + '说明');
  console.log(line());
  for (const a of agents) {
    const state = a.available ? '是' : (a.installed === false ? '未安装' : '否');
    console.log(pad(a.id, 16) + pad(a.name, 16) + pad(state, 8) + a.description);
  }
  console.log(line('='));
  console.log('提示：外部 CLI 装上后会自动出现在列表并变为可用，无需改代码。');
}

function cmdDispatch() {
  store.ensure();
  const prompt = flags.prompt || positional.join(' ');
  if (!prompt) throw new Error('缺少指令。用法：agentctl dispatch --agent analyst --prompt "任务内容"');
  // 类型路由：不指定 agent 时按任务类型自动分配执行者
  const TYPE_MAP = {
    image: 'imagegen', img: 'imagegen', 生图: 'imagegen',
    code: 'codex-run', reasoning: 'codex', text: 'codex',
    shell: 'shell', python: 'python', node: 'node',
    analyst: 'analyst', delegate: 'delegate'
  };
  const agentId = flags.type && TYPE_MAP[flags.type]
    ? TYPE_MAP[flags.type]
    : (flags.agent || 'analyst');
  const agent = adapters.get(agentId);
  if (!agent) throw new Error('未知 agent：' + flags.agent);
  if (!agent.available) throw new Error('agent 当前不可用：' + agent.id + '（' + agent.description + '）');
  const task = store.createTask({
    title: flags.title,
    agentId: agent.id,
    prompt,
    dependsOn: String(flags.depends || '').split(',').map((s) => s.trim()).filter(Boolean),
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    maxRetries: flags.retries !== undefined ? Number(flags.retries) : undefined
  });
  bus.emit({ type: 'created', taskId: task.id, agentId: task.agentId, level: 'info',
    message: '总指挥派单：' + task.title, data: { title: task.title, agent: agent.name } });
  console.log('已派单 ' + task.id + ' → ' + agent.name);
  console.log('  ' + task.title);
  console.log('  状态：排队中（启动 serve 或 run 后开始执行）');
}

function cmdPlan(file) {
  if (!file) throw new Error('用法：agentctl plan <plan.json>');
  const abs = path.resolve(file);
  const items = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(items)) throw new Error('plan 文件必须是数组');
  store.ensure();
  const keyMap = {};
  const created = [];
  for (const item of items) {
    const deps = (item.dependsOn || []).map((key) => keyMap[key] || key);
    const task = store.createTask({
      title: item.title, agentId: item.agent || item.agentId || 'analyst',
      prompt: item.prompt || '', dependsOn: deps,
      timeoutMs: item.timeoutMs, maxRetries: item.maxRetries
    });
    if (item.key) keyMap[item.key] = task.id;
    keyMap[task.id] = task.id;
    created.push(task);
    bus.emit({ type: 'created', taskId: task.id, agentId: task.agentId, level: 'info',
      message: '批量派单：' + task.title, data: { dependsOn: deps } });
  }
  console.log('已派发 ' + created.length + ' 个任务：');
  for (const task of created) {
    console.log('  ' + pad(task.id, 16) + pad(STATUS_LABEL[task.status], 10) + task.title);
  }
}

function cmdStatus() {
  store.ensure();
  const tasks = store.listTasks();
  const meta = store.getMeta();
  if (flags.json) {
    return console.log(JSON.stringify({ tasks, meta, stats: server.buildState().stats }, null, 2));
  }
  const counts = server.buildState().stats;
  console.log(line('='));
  console.log('任务总数 ' + counts.total + '  |  运行中 ' + counts.running + '  |  排队 ' + counts.queued +
    '  |  待指挥 ' + counts.waiting + '  |  完成 ' + counts.done + '  |  失败 ' + counts.failed);
  console.log('全局队列：' + (meta.paused ? '已暂停' : '运行中') + '  |  并发上限：' + meta.concurrency);
  console.log(line());
  console.log(pad('ID', 16) + pad('状态', 10) + pad('AGENT', 14) + pad('耗时', 9) + '标题');
  console.log(line());
  for (const task of tasks) {
    console.log(pad(task.id, 16) + pad((STATUS_LABEL[task.status] || task.status) + (task.paused ? '(暂停)' : ''), 10) +
      pad(task.agentId, 14) + pad(duration(task), 9) + task.title);
  }
  if (!tasks.length) console.log('（暂无任务，试试 demo 或 dispatch）');
  console.log(line('='));
}

function cmdLogs() {
  store.ensure();
  const taskId = positional[0];
  const limit = Number(flags.limit || 40);
  const render = (e) => {
    const time = String(e.ts || '').slice(11, 19);
    const tag = e.taskId ? ' ' + e.taskId.slice(0, 10) : '';
    console.log(time + ' [' + (e.type || 'log') + ']' + tag + ' ' + (e.message || ''));
  };
  const events = taskId ? bus.forTask(taskId, limit) : bus.recent(limit);
  events.forEach(render);
  if (!flags.follow) return;
  bus.startTailer(200);
  console.log(line() + '\n实时跟随中（Ctrl+C 退出）…');
  bus.subscribe((e) => { if (!taskId || e.taskId === taskId) render(e); });
}

function cmdControl(action) {
  const id = positional[0];
  if (!id) throw new Error('缺少任务 ID。用法：agentctl ' + action + ' <taskId>');
  const task = control.apply(action, id, flags);
  console.log('已执行 ' + action + ' → ' + task.id + ' 当前状态：' + (STATUS_LABEL[task.status] || task.status));
}

function cmdComplete() {
  const id = positional[0];
  if (!id) throw new Error('用法：agentctl complete <taskId> --result "结果摘要" [--file 产物路径]');
  const task = control.apply('complete', id, { result: flags.result || '总指挥已完成', file: flags.file });
  console.log('已回写 ' + task.id + '：' + task.result);
}

async function startServices(options) {
  const opts = options || {};
  store.ensure();
  const port = Number(flags.port || opts.port || 7788);
  let runner = null;
  if (!flags['no-worker']) {
    runner = new Runner({ concurrency: Number(flags.concurrency || store.getMeta().concurrency || 3) });
    runner.start();
  }
  const httpServer = await server.listen(port);
  const url = 'http://127.0.0.1:' + port;
  console.log(line('='));
  console.log('Agent 指挥台已启动');
  console.log('  可视化壳：' + url);
  console.log('  CLI 内核：' + store.ROOT);
  console.log('  调度器：' + (runner ? '已启动（并发 ' + runner.concurrency + '）' : '未启动（--no-worker）'));
  console.log('  事件流：data/events.jsonl（SSE 实时推送）');
  console.log(line('='));
  console.log('另开一个终端可以继续派单：node bin/agentctl.js dispatch --agent analyst --prompt "..."');
  console.log('按 Ctrl+C 停止\n');
  const shutdown = () => {
    if (runner) runner.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { runner, httpServer, url };
}

function seedDemo() {
  const marker = path.join(store.DATA, '.demo-seeded');
  if (fs.existsSync(marker) && !flags.reset) return false;
  const longScript = [
    "const fs = require('fs');",
    "const steps = ['连接 CLI 内核', '读取任务上下文', '生成中间数据', '校验输出完整性', '写入产物', '收尾'];",
    '(async () => {',
    '  for (let i = 0; i < steps.length; i++) {',
    '    console.log("[step " + (i + 1) + "/" + steps.length + "] " + steps[i]);',
    '    await new Promise((r) => setTimeout(r, 1100));',
    '  }',
    '  const dir = process.env.AGENT_RUN_DIR;',
    "  fs.writeFileSync(dir + '/pipeline.json', JSON.stringify({ steps: steps.length, ok: true, at: new Date().toISOString() }, null, 2));",
    "  console.log('DONE pipeline.json');",
    '})();'
  ].join('\n');
  const pythonScript = [
    'import os, json, datetime',
    'print("python agent 就绪，依赖任务已完成")',
    'd = os.environ.get("AGENT_RUN_DIR", ".")',
    'data = {"checked_at": datetime.datetime.now().isoformat(), "note": "依赖检查通过"}',
    'with open(os.path.join(d, "check.json"), "w", encoding="utf-8") as f:',
    '    json.dump(data, f, ensure_ascii=False, indent=2)',
    'print("DONE check.json")'
  ].join('\n');
  const plan = [
    { key: 'a', title: '梳理工作台上线检查清单', agent: 'analyst', prompt: '梳理多 agent 工作台交付前的上线检查清单：事件协议、失败重试、依赖 DAG、人工接管入口。' },
    { key: 'b', title: '跑一段流式管道脚本', agent: 'node', prompt: longScript },
    { key: 'c', title: '确认第一批要接入的真实 agent', agent: 'delegate', prompt: '请总指挥确认：第一批要接入的真实 agent 名单与优先级，确认后用 complete 命令回写。' },
    { key: 'd', title: '校验 Python 通道与产物写入', agent: 'python', prompt: pythonScript, dependsOn: ['a'] },
    { key: 'e', title: '检查本机运行时版本', agent: 'shell', prompt: 'echo agent-console ready && node -v' },
    { key: 'f', title: '汇总各通道结果', agent: 'analyst', prompt: '汇总各通道执行结果，给出一份交付前复核清单。', dependsOn: ['a', 'b', 'e'] }
  ];
  const keyMap = {};
  for (const item of plan) {
    const task = store.createTask({
      title: item.title, agentId: item.agent, prompt: item.prompt,
      dependsOn: (item.dependsOn || []).map((k) => keyMap[k])
    });
    keyMap[item.key] = task.id;
    bus.emit({ type: 'created', taskId: task.id, agentId: task.agentId, level: 'info',
      message: '演示任务入队：' + task.title, data: { dependsOn: task.dependsOn } });
  }
  fs.writeFileSync(marker, store.now(), 'utf8');
  return true;
}

function cmdHelp() {
  console.log([
    '',
    'agentctl — 多 agent 工作台 CLI 内核（Web 只是它的一个视图）',
    line('='),
    '  init                              初始化目录与状态文件',
    '  agents [--json]                   列出全部 agent 与可用状态',
    '  doctor [--apply]                  环境体检：运行时/agent/网络出口/代理端口/生图通道',
    '                                    --apply 把探测到的可用代理写进 config',
    '  dispatch --agent <id> --prompt "…" 派单',
    '           [--title "…"] [--depends id,id] [--timeout ms] [--retries n]',
    '  plan <plan.json>                  批量派单，支持 dependsOn 按 key 引用',
    '  status [--json]                   任务总览',
    '  logs [taskId] [--limit N] [--follow]  查看事件流',
    '  run [--concurrency N]             只跑调度器，不启 Web',
    '  serve [--port N] [--concurrency N] [--no-worker]  启动 Web + 调度器',
    '  demo [--port N] [--reset]         灌演示任务并启动',
    '  pause / resume                    全局暂停 / 继续队列',
    '  retry <id> / cancel <id>          重跑 / 取消',
    '  pause-task <id> / resume-task <id>  单任务暂停 / 继续',
    '  edit <id> --prompt "…"            改指令（仅未运行任务）',
    '  complete <id> --result "…" [--file 路径]  回写总指挥直领任务',
    '  help                              本帮助',
    line('='),
    '内置 agent：analyst 推演 / delegate 总指挥直领 / shell / node / python',
    '外部 CLI：在 config/agents.json 配置，检测到命令即自动可用',
    ''
  ].join('\n'));
}

async function main() {
  switch (command) {
    case 'init': return cmdInit();
    case 'agents': return cmdAgents();
    case 'doctor': return await doctor.run({ apply: !!flags.apply });
    case 'dispatch': return cmdDispatch();
    case 'plan': return cmdPlan(positional[0]);
    case 'status': return cmdStatus();
    case 'logs': return cmdLogs();
    case 'pause': return console.log('全局队列已暂停：' + JSON.stringify(control.setPaused(true)));
    case 'resume': return console.log('全局队列已继续：' + JSON.stringify(control.setPaused(false)));
    case 'retry': return cmdControl('retry');
    case 'cancel': return cmdControl('cancel');
    case 'pause-task': return cmdControl('pause');
    case 'resume-task': return cmdControl('resume');
    case 'edit': return cmdControl('edit');
    case 'complete': return cmdComplete();
    case 'run': {
      store.ensure();
      bus.startTailer(200);
      const runner = new Runner({ concurrency: Number(flags.concurrency || store.getMeta().concurrency || 3) });
      runner.start();
      console.log('调度器运行中（并发 ' + runner.concurrency + '），Ctrl+C 停止');
      process.on('SIGINT', () => { runner.stop(); process.exit(0); });
      return;
    }
    case 'serve': return await startServices();
    case 'demo': {
      store.ensure();
      const seeded = seedDemo();
      console.log(seeded ? '已灌入 6 个演示任务（含依赖 DAG 与待指挥任务）' : '已存在演示任务，直接启动服务（--reset 可重灌）');
      return await startServices();
    }
    case 'help':
    case '--help':
    case '-h': return cmdHelp();
    default:
      throw new Error('未知命令：' + command + '。运行 agentctl help 查看用法');
  }
}

main().catch((error) => {
  console.error('错误：' + error.message);
  process.exitCode = 1;
});
