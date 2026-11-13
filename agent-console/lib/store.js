'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TASKS = path.join(DATA, 'tasks');
const RUNS = path.join(ROOT, 'runs');
const INBOX = path.join(ROOT, 'inbox');
const WEB = path.join(ROOT, 'web');
const CONFIG = path.join(ROOT, 'config');
const EVENTS = path.join(DATA, 'events.jsonl');
const META = path.join(DATA, 'meta.json');

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ensure() {
  for (const d of [DATA, TASKS, RUNS, INBOX, CONFIG, WEB]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(EVENTS)) fs.writeFileSync(EVENTS, '', 'utf8');
  if (!fs.existsSync(META)) {
    writeJson(META, { paused: false, concurrency: 3, createdAt: now() });
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(p, value) {
  const text = JSON.stringify(value, null, 2);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (_) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      fs.renameSync(tmp, p);
    } catch (__) {
      fs.writeFileSync(p, text, 'utf8');
      try { fs.unlinkSync(tmp); } catch (___) {}
    }
  }
}

function listTasks() {
  ensure();
  return fs.readdirSync(TASKS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(TASKS, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function getTask(id) {
  ensure();
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) return null;
  return readJson(path.join(TASKS, id + '.json'), null);
}

function saveTask(task) {
  ensure();
  writeJson(path.join(TASKS, task.id + '.json'), task);
  return task;
}

function createTask(opts) {
  ensure();
  const cfg = readJson(path.join(CONFIG, 'agents.json'), {}) || {};
  const defaults = cfg.defaults || {};
  const task = {
    id: uid('t'),
    seq: nextSeq(),
    title: opts.title || String(opts.prompt || '').slice(0, 42) || '未命名任务',
    agentId: opts.agentId || 'analyst',
    prompt: opts.prompt || '',
    dependsOn: Array.isArray(opts.dependsOn) ? opts.dependsOn : [],
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    retries: 0,
    maxRetries: Number(opts.maxRetries ?? defaults.maxRetries ?? 1),
    timeoutMs: Number(opts.timeoutMs ?? defaults.timeoutMs ?? 120000),
    runId: null,
    result: null,
    error: null,
    progress: 0,
    paused: false,
    artifacts: []
  };
  saveTask(task);
  return task;
}

function runDir(task) {
  const dir = path.join(RUNS, task.id, task.runId || 'run');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendEvent(event) {
  ensure();
  fs.appendFileSync(EVENTS, JSON.stringify(event) + '\n', 'utf8');
}

function readEvents() {
  ensure();
  try {
    const text = fs.readFileSync(EVENTS, 'utf8');
    if (!text.trim()) return [];
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

function getMeta() {
  ensure();
  return readJson(META, { paused: false, concurrency: 3 });
}

function setMeta(patch) {
  ensure();
  const meta = Object.assign(getMeta(), patch);
  writeJson(META, meta);
  return meta;
}

// 任务编号：自增序号，永不复用；存量任务启动时按创建时间补号
function nextSeq() {
  const meta = getMeta();
  const n = (meta.taskSeq || 0) + 1;
  meta.taskSeq = n;
  writeJson(META, meta);
  return n;
}

function migrateSeq() {
  ensure();
  const meta = readJson(META, {}) || {};
  if (meta.seqMigrated) return;
  const tasks = listTasks().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let max = meta.taskSeq || 0;
  for (const t of tasks) {
    if (!t.seq) { max += 1; t.seq = max; saveTask(t); }
    else if (t.seq > max) max = t.seq;
  }
  meta.taskSeq = max;
  meta.seqMigrated = true;
  writeJson(META, meta);
}

function deleteTask(taskId) {
  ensure();
  const target = path.join(TASKS, taskId + '.json');
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

module.exports = {
  ROOT, DATA, TASKS, RUNS, INBOX, WEB, CONFIG, EVENTS, META,
  now, uid, ensure, readJson, writeJson,
  listTasks, getTask, saveTask, createTask, runDir, deleteTask, nextSeq, migrateSeq,
  appendEvent, readEvents, getMeta, setMeta
};
