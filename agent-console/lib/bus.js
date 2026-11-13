'use strict';

const fs = require('fs');
const store = require('./store');

const listeners = new Set();
let offset = 0;
let pending = '';
let timer = null;

function emit(fields) {
  const event = Object.assign({ ts: store.now(), id: store.uid('e') }, fields);
  try {
    store.ensure();
    store.appendEvent(event);
  } catch (error) {
    try { console.error('[bus] 事件写入失败：' + error.message); } catch (_) {}
  }
  return event;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast(event) {
  for (const fn of Array.from(listeners)) {
    try { fn(event); } catch (_) {}
  }
}

function tailOnce() {
  let size;
  try { size = fs.statSync(store.EVENTS).size; } catch (_) { return; }
  if (size === offset) return;
  if (size < offset) { offset = 0; pending = ''; }
  const length = size - offset;
  const buf = Buffer.alloc(length);
  let fd;
  try {
    fd = fs.openSync(store.EVENTS, 'r');
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
  } catch (_) {
    return;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
  offset = size;
  pending += buf.toString('utf8');
  const lines = pending.split('\n');
  pending = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { broadcast(JSON.parse(line)); } catch (_) {}
  }
}

function startTailer(ms = 200) {
  if (timer) return;
  store.ensure();
  try { offset = fs.statSync(store.EVENTS).size; } catch (_) { offset = 0; }
  timer = setInterval(tailOnce, ms);
}

function stopTailer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function recent(limit = 300) {
  return store.readEvents().slice(-limit);
}

function forTask(taskId, limit = 500) {
  return store.readEvents().filter((e) => e.taskId === taskId).slice(-limit);
}

module.exports = { emit, subscribe, broadcast, tailOnce, startTailer, stopTailer, recent, forTask };
