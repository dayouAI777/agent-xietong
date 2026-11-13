'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const bus = require('./bus');

function apply(action, taskId, payload) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('找不到任务 ' + taskId);
  const extra = payload || {};

  switch (action) {
    case 'pause':
      task.paused = true;
      break;
    case 'resume':
      task.paused = false;
      break;
    case 'cancel':
      if (task.status !== 'running') {
        task.status = 'cancelled';
        task.finishedAt = store.now();
        task.error = task.error || '由总指挥取消';
      }
      break;
    case 'delete': {
      if (task.status === 'running') throw new Error('运行中的任务不能删除，请先取消');
      const removed = store.deleteTask(taskId);
      if (!removed) throw new Error('任务文件不存在，可能已删除');
      // 同步清理该任务待指挥的 inbox 委托单
      try { fs.unlinkSync(path.join(store.INBOX, taskId + '.md')); } catch (_) {}
      bus.emit({ type: 'control', taskId, action, level: 'info',
        message: '任务已删除并移出看板：' + task.title, data: { deleted: true } });
      return task;
    }
    case 'retry':
      task.status = 'queued';
      task.paused = false;
      task.retries = 0;
      task.error = null;
      task.result = null;
      task.progress = 0;
      task.finishedAt = null;
      task.runId = null;
      break;
    case 'edit':
      if (task.status === 'running') throw new Error('运行中的任务不能改指令，请先取消或等待完成');
      if (extra.title !== undefined) task.title = String(extra.title);
      if (extra.prompt !== undefined) task.prompt = String(extra.prompt);
      break;
    case 'complete': {
      if (task.status !== 'waiting' && task.status !== 'running' && task.status !== 'queued') {
        throw new Error('任务当前状态为 ' + task.status + '，无法回写结果');
      }
      if (extra.file) {
        const source = path.resolve(String(extra.file));
        if (!fs.existsSync(source)) throw new Error('产物文件不存在：' + source);
        const dir = store.runDir(task);
        const target = path.join(dir, path.basename(source));
        fs.copyFileSync(source, target);
        const rel = path.relative(store.ROOT, target).replace(/\\/g, '/');
        task.artifacts = (task.artifacts || []).concat([{
          name: path.basename(source), path: rel, size: fs.statSync(target).size
        }]);
        bus.emit({ type: 'artifact', taskId, runId: task.runId, agentId: task.agentId, level: 'info',
          message: '总指挥回传产物 ' + path.basename(source), data: { name: path.basename(source), path: rel } });
      }
      task.status = 'done';
      task.result = String(extra.result || '总指挥已回写结果');
      task.progress = 100;
      task.finishedAt = store.now();
      store.saveTask(task);
      bus.emit({ type: 'done', taskId, runId: task.runId, agentId: task.agentId, level: 'success',
        message: '任务完成（总指挥回写）：' + task.title, data: { result: task.result } });
      bus.emit({ type: 'control', taskId, action, level: 'info', message: '总指挥回写结果' });
      return task;
    }
    default:
      throw new Error('未知操作：' + action);
  }

  store.saveTask(task);
  bus.emit({
    type: 'control', taskId, action,
    level: 'info',
    message: '总指挥操作：' + action + ' · ' + task.title,
    data: { status: task.status, paused: task.paused }
  });
  return task;
}

function setPaused(paused) {
  const meta = store.setMeta({ paused: !!paused });
  bus.emit({ type: 'control', level: 'info', message: paused ? '全局队列已暂停' : '全局队列已继续', data: { global: true, paused } });
  return meta;
}

module.exports = { apply, setPaused };
