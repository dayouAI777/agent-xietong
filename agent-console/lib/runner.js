'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const bus = require('./bus');
const adapters = require('./adapters');

class Runner {
  constructor(options) {
    const opts = options || {};
    this.concurrency = Number(opts.concurrency || store.getMeta().concurrency || 3);
    this.active = new Map();
    this.timer = null;
    this.busy = false;
    this.unsubscribe = null;
  }

  start() {
    if (this.timer) return;
    this.recover();
    bus.startTailer(200);
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type === 'control' && event.action === 'cancel' && event.taskId) {
        this.abort(event.taskId, 'cancel');
      }
    });
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        bus.emit({ type: 'error', level: 'error', message: '调度器异常：' + error.message });
      });
    }, 250);
    this.tick();
    bus.emit({ type: 'system', level: 'info', message: '调度器已启动，并发上限 ' + this.concurrency });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  recover() {
    const tasks = store.listTasks();
    for (const task of tasks) {
      if (task.status === 'running' && !this.active.has(task.id)) {
        task.status = 'queued';
        task.runId = null;
        task.progress = 0;
        store.saveTask(task);
        bus.emit({ type: 'warn', taskId: task.id, agentId: task.agentId, level: 'warn',
          message: '发现中断的运行中任务，已重新入队：' + task.title });
      }
    }
  }

  abort(taskId, reason) {
    const entry = this.active.get(taskId);
    if (!entry) return false;
    entry.reason = reason;
    try { entry.controller.abort(new Error(reason)); } catch (_) {}
    return true;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const meta = store.getMeta();
      if (meta.paused) return;
      const tasks = store.listTasks();
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const running = tasks.filter((t) => t.status === 'running').length;
      let slots = Math.max(0, this.concurrency - running);
      if (slots <= 0) return;

      for (const task of tasks) {
        if (slots <= 0) break;
        if (task.status !== 'queued' || task.paused || this.active.has(task.id)) continue;
        const deps = (task.dependsOn || []).map((id) => byId.get(id));
        if (deps.some((d) => !d)) continue;
        const failedDep = deps.find((d) => d.status === 'failed' || d.status === 'cancelled');
        if (failedDep) {
          task.status = 'failed';
          task.error = '依赖任务 ' + failedDep.id + ' 状态为 ' + failedDep.status;
          task.finishedAt = store.now();
          store.saveTask(task);
          bus.emit({ type: 'error', taskId: task.id, agentId: task.agentId, level: 'error',
            message: '依赖失败，任务终止：' + task.title, data: { error: task.error } });
          continue;
        }
        if (!deps.every((d) => d.status === 'done')) continue;
        slots--;
        this.execute(task).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
  }

  async execute(task) {
    const agent = adapters.get(task.agentId);
    if (!agent || !agent.available) {
      this.retryOrFail(task, 'agent 不可用：' + task.agentId);
      return;
    }

    const runId = store.uid('r');
    task.status = 'running';
    task.runId = runId;
    task.startedAt = store.now();
    task.finishedAt = null;
    task.error = null;
    task.progress = 0;
    task.artifacts = [];
    store.saveTask(task);

    const dir = store.runDir(task);
    const controller = new AbortController();
    const entry = { controller, reason: null, timeout: null };
    this.active.set(task.id, entry);
    entry.timeout = setTimeout(() => this.abort(task.id, 'timeout'), Math.max(1000, task.timeoutMs || 120000));

    bus.emit({
      type: 'started', taskId: task.id, runId, agentId: agent.id, level: 'info',
      message: '任务启动 → ' + agent.name + ' · ' + task.title,
      data: { title: task.title, timeoutMs: task.timeoutMs }
    });

    const artifacts = [];
    const api = {
      task, agent, dir, signal: controller.signal,
      log: (message, level) => bus.emit({
        type: 'log', taskId: task.id, runId, agentId: agent.id,
        level: level || 'info', message: String(message)
      }),
      progress: (value) => {
        const current = store.getTask(task.id);
        if (!current) return;
        current.progress = Math.max(0, Math.min(100, Number(value) || 0));
        store.saveTask(current);
        bus.emit({ type: 'progress', taskId: task.id, runId, agentId: agent.id,
          level: 'info', message: '进度 ' + current.progress + '%', data: { progress: current.progress } });
      },
      artifact: (name, content) => {
        const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const target = path.join(dir, safe);
        fs.writeFileSync(target, String(content), 'utf8');
        const rel = path.relative(store.ROOT, target).replace(/\\/g, '/');
        const item = { name: safe, path: rel, size: Buffer.byteLength(String(content)) };
        artifacts.push(item);
        const current = store.getTask(task.id);
        if (current) { current.artifacts = artifacts.slice(); store.saveTask(current); }
        bus.emit({ type: 'artifact', taskId: task.id, runId, agentId: agent.id,
          level: 'info', message: '产出 ' + safe, data: item });
      },
      // 登记运行目录中已存在的文件（如二进制图片），不重写内容
      file: (name) => {
        const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const target = path.join(dir, safe);
        const item = { name: safe, path: path.relative(store.ROOT, target).replace(/\\/g, '/'), size: 0 };
        try { item.size = fs.statSync(target).size; } catch (_) {}
        artifacts.push(item);
        const current = store.getTask(task.id);
        if (current) { current.artifacts = artifacts.slice(); store.saveTask(current); }
        bus.emit({ type: 'artifact', taskId: task.id, runId, agentId: agent.id,
          level: 'info', message: '产出 ' + safe, data: item });
      }
    };

    let outcome;
    let failure = null;
    try {
      outcome = await Promise.race([
        Promise.resolve(agent.run({ task, dir, agent }, api)),
        new Promise((_, reject) => {
          if (controller.signal.aborted) return reject(new Error('__cancelled__'));
          controller.signal.addEventListener('abort', () => reject(new Error('__cancelled__')), { once: true });
        })
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(entry.timeout);
      this.active.delete(task.id);
    }

    const current = store.getTask(task.id) || task;
    if (current.status === 'cancelled') return;

    if (failure || controller.signal.aborted) {
      const reason = entry.reason || (controller.signal.reason && controller.signal.reason.message) || '';
      if (reason === 'cancel' || current.status === 'cancelled') {
        current.status = 'cancelled';
        current.finishedAt = store.now();
        current.error = '由总指挥取消';
        store.saveTask(current);
        bus.emit({ type: 'cancelled', taskId: task.id, runId, agentId: agent.id, level: 'warn',
          message: '任务已取消：' + task.title });
        return;
      }
      if (reason === 'timeout') {
        bus.emit({ type: 'warn', taskId: task.id, runId, agentId: agent.id, level: 'warn',
          message: '执行超时（' + task.timeoutMs + 'ms），已终止子进程' });
        this.retryOrFail(current, '执行超时 ' + task.timeoutMs + 'ms');
        return;
      }
      if (String(failure && failure.message) === '__cancelled__') return;
      this.retryOrFail(current, String(failure && failure.message ? failure.message : failure));
      return;
    }

    if (!outcome || outcome.status === 'cancelled') {
      current.status = 'cancelled';
      current.finishedAt = store.now();
      store.saveTask(current);
      return;
    }

    if (outcome.status === 'waiting') {
      current.status = 'waiting';
      current.result = outcome.result || '等待总指挥回写';
      store.saveTask(current);
      bus.emit({ type: 'waiting', taskId: task.id, runId, agentId: agent.id, level: 'warn',
        message: '任务已委托总指挥，等待回写：' + task.title });
      return;
    }

    current.status = 'done';
    current.result = outcome.result || '完成';
    current.progress = 100;
    current.finishedAt = store.now();
    current.artifacts = artifacts.slice();
    store.saveTask(current);
    bus.emit({ type: 'done', taskId: task.id, runId, agentId: agent.id, level: 'success',
      message: '任务完成：' + task.title,
      data: { result: String(current.result).slice(0, 500), artifacts: current.artifacts.length } });
  }

  retryOrFail(task, error) {
    const current = store.getTask(task.id) || task;
    const message = String(error || '未知错误');
    if (current.retries < current.maxRetries) {
      current.retries += 1;
      current.status = 'queued';
      current.error = message;
      current.runId = null;
      current.progress = 0;
      store.saveTask(current);
      bus.emit({ type: 'warn', taskId: task.id, agentId: task.agentId, level: 'warn',
        message: '第 ' + current.retries + ' 次重试排队：' + message });
    } else {
      current.status = 'failed';
      current.error = message;
      current.finishedAt = store.now();
      current.progress = 0;
      store.saveTask(current);
      bus.emit({ type: 'error', taskId: task.id, runId: current.runId, agentId: task.agentId, level: 'error',
        message: '任务失败：' + task.title + ' · ' + message, data: { error: message } });
    }
  }
}

module.exports = { Runner };
