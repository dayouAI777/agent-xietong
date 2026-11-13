'use strict';

const state = {
  tasks: [], agents: [], stats: {}, events: [], eventIds: new Set(),
  filter: 'all', feedMode: 'results', selected: null, connected: false,
  modalMode: 'create', artifactText: null, orders: []
};

const STATUS_LABEL = {
  queued: '排队中', running: '运行中', waiting: '待指挥',
  done: '已完成', failed: '失败', cancelled: '已取消'
};
const STATUS_ORDER = { running: 0, waiting: 1, queued: 2, failed: 3, done: 4, cancelled: 5 };
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'waiting', label: '待指挥' },
  { key: 'done', label: '已完成' },
  { key: 'problem', label: '异常' }
];

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function duration(task) {
  if (!task.startedAt) return '-';
  const end = task.finishedAt ? new Date(task.finishedAt) : new Date();
  return ((end - new Date(task.startedAt)) / 1000).toFixed(1) + 's';
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function post(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function setConnection(kind, text) {
  const el = $('conn');
  el.className = 'conn ' + (kind || '');
  el.querySelector('span').textContent = text;
}

function renderMetrics() {
  const s = state.stats;
  const items = [
    { label: '任务总数', value: s.total || 0, cls: '' },
    { label: '运行中', value: s.running || 0, cls: 'accent-purple' },
    { label: '排队中', value: s.queued || 0, cls: '' },
    { label: '待指挥', value: s.waiting || 0, cls: 'accent-amber' },
    { label: '已完成', value: s.done || 0, cls: 'accent-teal' },
    { label: '异常 / 取消', value: (s.failed || 0) + (s.cancelled || 0), cls: 'accent-red' }
  ];
  $('metrics').innerHTML = items.map((m) =>
    '<div class="metric ' + m.cls + '"><span class="value">' + m.value + '</span><span class="label">' + m.label + '</span></div>'
  ).join('');
  $('globalPause').textContent = s.paused ? '继续队列' : '暂停队列';
}

function renderAgents() {
  const counters = {};
  for (const task of state.tasks) {
    const c = counters[task.agentId] || (counters[task.agentId] = { total: 0, running: 0, done: 0 });
    c.total++;
    if (task.status === 'running') c.running++;
    if (task.status === 'done') c.done++;
  }
  const avail = state.agents.filter((a) => a.available).length;
  $('agentCount').textContent = avail + ' / ' + state.agents.length + ' 可用';
  $('poolCount').textContent = avail + '/' + state.agents.length;
  const card = (a) => {
    const c = counters[a.id] || { total: 0, running: 0, done: 0 };
    return '<div class="agent-card">' +
      '<div class="ac-top"><span class="agent-dot" style="background:' + esc(a.color || '#888') + '"></span>' +
      '<span class="ac-name">' + esc(a.name) + '</span>' +
      '<span class="ac-kind">' + (a.builtin ? 'builtin' : 'external') + '</span></div>' +
      '<div class="ac-desc">' + esc(a.description || '') + '</div>' +
      '<div class="ac-stat"><span>任务 <b>' + c.total + '</b></span><span>运行 <b>' + c.running + '</b></span>' +
      '<span>完成 <b>' + c.done + '</b></span><span style="margin-left:auto;color:var(--teal)">可用</span></div>' +
      '</div>';
  };
  const online = state.agents.filter((a) => a.available);
  const offline = state.agents.filter((a) => !a.available);
  $('agentList').innerHTML = online.map(card).join('') +
    (offline.length
      ? '<div class="agent-offline"><div class="ao-title">未就绪 ' + offline.length + ' 个（缺依赖或需配置）</div>' +
        offline.map((a) => '<div class="ao-row"><span class="ao-name">' + esc(a.name) + '</span>' +
          '<span class="ao-why">' + esc((a.description || '未就绪').slice(0, 60)) + '</span></div>').join('') +
        '</div>'
      : '');
}

// 任务指令区快捷键：点名 agent。插入行首 @alias（router 只认行首 @）
const QUICK_AGENTS = [
  { id: 'shell', tag: 'shell', alias: 'shell', tip: '本地命令，零积分' },
  { id: 'codex-http', tag: 'codex', alias: 'codex', tip: '本地 codex 通道：写代码 / 推理' },
  { id: 'dsh', tag: 'dsh', alias: 'dsh', tip: 'DSH 本地端点，免 key，能跑工具' },
  { id: 'imagegen', tag: '生图', alias: 'imagegen', tip: '朽木生图，零积分' },
  { id: 'analyst', tag: '推演', alias: 'analyst', tip: '风险 / 方案推演' },
  { id: 'node', tag: 'node', alias: 'node', tip: '直接跑 Node 源码' },
  { id: 'python', tag: 'py', alias: 'python', tip: '直接跑 Python 源码' }
];

function renderChips() {
  const box = $('cmdChips');
  if (!box) return;
  const byId = {};
  for (const a of state.agents) byId[a.id] = a;
  box.innerHTML = '<span class="chips-label">直指</span>' + QUICK_AGENTS.map((q) => {
    const a = byId[q.id];
    const ok = !!(a && a.available);
    return '<button class="chip' + (ok ? '' : ' off') + '" data-agent="' + esc(q.id) + '"' +
      ' title="' + esc(q.tip) + (ok ? '' : '（当前不可用）') + '">' +
      '<span class="chip-dot"></span>' + esc(q.tag) + '</button>';
  }).join('');
  syncChipState();
}

function syncChipState() {
  const box = $('cmdChips');
  const input = $('cmdInput');
  if (!box || !input) return;
  const m = String(input.value || '').match(/^\s*@([a-zA-Z0-9_-]+)/);
  const active = m ? m[1] : '';
  box.querySelectorAll('.chip').forEach((el) => {
    const q = QUICK_AGENTS.find((x) => x.id === el.dataset.agent);
    el.classList.toggle('on', !!q && (active === q.alias || active === q.id));
  });
}

function applyQuickAgent(agentId) {
  const q = QUICK_AGENTS.find((x) => x.id === agentId);
  const input = $('cmdInput');
  if (!q || !input) return;
  const m = input.value.match(/^\s*@([a-zA-Z0-9_-]+)\s*/);
  const current = m ? m[1] : '';
  const rest = m ? input.value.slice(m[0].length) : input.value.replace(/^\s+/, '');
  // 再点一次同一个 → 取消点名
  input.value = (current === q.alias || current === q.id)
    ? rest
    : '@' + q.alias + (rest ? ' ' + rest : ' ');
  input.focus();
  const n = input.value.length;
  input.setSelectionRange(n, n);
  syncChipState();
  const box = $('cmdResult');
  if (box) box.hidden = true;
}

function renderFilters() {
  $('filters').innerHTML = FILTERS.map((f) =>
    '<button class="filter ' + (state.filter === f.key ? 'active' : '') + '" data-filter="' + f.key + '">' + f.label + '</button>'
  ).join('');
}

function matchesFilter(task) {
  switch (state.filter) {
    case 'active': return ['queued', 'running', 'waiting'].includes(task.status);
    case 'waiting': return task.status === 'waiting';
    case 'done': return task.status === 'done';
    case 'problem': return task.status === 'failed' || task.status === 'cancelled';
    default: return true;
  }
}

function actionButtons(task) {
  const id = task.id;
  const btn = (action, label, disabled) =>
    '<button class="btn mini" data-action="' + action + '" data-id="' + esc(id) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  const out = [];
  if (task.status === 'running') out.push(btn('cancel', '取消'));
  if (task.status === 'queued') {
    out.push(btn(task.paused ? 'resume' : 'pause', task.paused ? '继续' : '暂停'));
    out.push(btn('edit', '改指令'));
    out.push(btn('cancel', '取消'));
  }
  if (task.status === 'waiting') {
    out.push(btn('complete', '回写结果'));
    out.push(btn('cancel', '取消'));
  }
  if (['done', 'failed', 'cancelled'].includes(task.status)) {
    out.push(btn('retry', '重跑'));
    out.push(btn('delete', '删除'));
  }
  out.push(btn('logs', '看日志'));
  return out.join('');
}

function renderTasks() {
  const tasks = state.tasks.filter(matchesFilter).sort((a, b) => {
    const order = (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9);
    if (order !== 0) return order;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  if (!tasks.length) {
    $('taskList').innerHTML = '<div class="empty">当前筛选下没有任务。<br>在上方「任务指令」框直接下命令即可。</div>';
    return;
  }
  $('taskList').innerHTML = tasks.map((task) => {
    const agent = state.agents.find((a) => a.id === task.agentId);
    const color = agent ? agent.color : '#888780';
    const badge = '<span class="badge ' + esc(task.status) + '">' + (STATUS_LABEL[task.status] || task.status) +
      (task.paused ? ' · 暂停' : '') + '</span>';
    return '<div class="task-card ' + (state.selected === task.id ? 'selected' : '') + '" data-id="' + esc(task.id) + '" style="border-left-color:' + esc(color) + '">' +
      '<div class="tc-top"><span class="tc-title">#' + (task.seq || '?') + ' ' + esc(task.title) + '</span>' + badge + '</div>' +
      '<div class="tc-meta"><span class="agent-tag">' + esc(task.agentId) + '</span><span>' + esc(task.id) + '</span>' +
      '<span>' + duration(task) + '</span>' + (task.dependsOn && task.dependsOn.length ? '<span>依赖 ' + task.dependsOn.length + '</span>' : '') + '</div>' +
      (task.error ? '<div class="tc-error">' + esc(task.error) + '</div>' : '') +
      (task.status === 'running' ? '<div class="progress"><i style="width:' + (task.progress || 0) + '%"></i></div>' : '') +
      '<div class="tc-actions">' + actionButtons(task) + '</div>' +
      '</div>';
  }).join('');
}

/* ===== 中央事件区：结果优先，下面附流程细节 ===== */

function isImageArtifact(name) { return /\.(png|jpe?g|gif|webp)$/i.test(name); }

function artifactHtml(a) {
  const src = '/api/artifact?path=' + encodeURIComponent(a.path);
  if (isImageArtifact(a.name)) {
    return '<div class="art-block">' +
      '<img class="art-img" src="' + src + '" alt="' + esc(a.name) + '" data-zoom="' + src + '" data-name="' + esc(a.name) + '" title="点击查看大图">' +
      '<div class="art-bar"><span class="art-name">' + esc(a.name) + '</span>' +
      '<span class="art-size">' + fmtSize(a.size) + '</span>' +
      '<button class="btn mini" data-download="' + esc(a.path) + '" data-name="' + esc(a.name) + '">下载</button></div>' +
      '</div>';
  }
  return '<div class="art-block">' +
    '<button class="art-link" data-artifact="' + esc(a.path) + '">' + esc(a.name) + '</button>' +
    '<span class="art-size">' + fmtSize(a.size) + '</span>' +
    '</div>';
}

function fmtSize(n) {
  n = Number(n || 0);
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function copyBtn(text) {
  return '<button class="btn mini" data-copy="' + esc(text) + '">复制</button>';
}

// 结果卡：一个任务一张卡（有事件足迹的任务才出现）
function renderResultsFeed() {
  const feed = $('feed');
  // 每个任务的最后活动时间
  const lastAct = new Map();
  const logsByTask = new Map();
  for (const e of state.events) {
    const tid = e.taskId || '_';
    lastAct.set(tid, Math.max(lastAct.get(tid) || 0, new Date(e.ts || 0).getTime() || 0));
    if (!logsByTask.has(tid)) logsByTask.set(tid, []);
    logsByTask.get(tid).push(e);
  }
  const taskIds = [...lastAct.keys()].sort((a, b) => (lastAct.get(b) || 0) - (lastAct.get(a) || 0));
  if (!taskIds.length) {
    feed.innerHTML = '<div class="empty">暂无事件。在上方「任务指令」框下一条命令试试。</div>';
    return;
  }
  feed.innerHTML = taskIds.map((tid) => {
    const task = state.tasks.find((t) => t.id === tid);
    const logs = (logsByTask.get(tid) || []).filter((e) => ['log', 'progress', 'started', 'created'].includes(e.type || 'log'));
    const agent = task ? state.agents.find((a) => a.id === task.agentId) : null;
    const color = agent ? agent.color : '#888780';
    const title = task ? '#' + (task.seq || '?') + ' ' + esc(task.title) : (tid === '_' ? '系统' : esc(tid));
    const badge = task ? '<span class="badge ' + esc(task.status) + '">' + (STATUS_LABEL[task.status] || task.status) + '</span>' : '';
    const lastTs = task ? (task.finishedAt || task.startedAt || (lastAct.get(tid) || 0)) : lastAct.get(tid);

    let html = '<div class="result-card ' + (state.selected === tid ? 'selected' : '') + '" data-task="' + esc(tid) + '" style="border-left-color:' + esc(color) + '">' +
      '<div class="rc-head"><span class="rc-title">' + title + '</span>' + badge +
      '<span class="rc-time">' + fmtTime(lastTs) + '</span></div>';

    if (task && task.result) {
      html += '<div class="rc-section"><div class="rc-label">结果 ' + copyBtn(task.result) + '</div>' +
        '<div class="result-box">' + esc(task.result) + '</div></div>';
    }
    if (task && task.error) {
      html += '<div class="rc-section"><div class="rc-label rc-err-label">错误</div>' +
        '<div class="result-box err">' + esc(task.error) + '</div></div>';
    }
    if (task && task.artifacts && task.artifacts.length) {
      html += '<div class="rc-section"><div class="rc-label">产物</div>' +
        task.artifacts.map(artifactHtml).join('') + '</div>';
    }
    if (!task || (!task.result && !task.error && !(task.artifacts && task.artifacts.length))) {
      const st = task ? (STATUS_LABEL[task.status] || task.status) : '系统事件';
      html += '<div class="rc-section"><div class="rc-hint">' + esc(st) + (task ? ' · ' + esc(duration(task)) : '') + '</div></div>';
    }
    if (logs.length) {
      html += '<details class="rc-logs"><summary>流程细节（' + logs.length + '）</summary>' +
        logs.map((e) => '<div class="feed-row"><span class="t">' + fmtTime(e.ts) + '</span>' +
          '<span class="k ' + esc(e.type || 'log') + '">' + esc(e.type || 'log') + '</span>' +
          '<span class="m">' + esc(e.message || '') + '</span></div>').join('') +
        '</details>';
    }
    html += '</div>';
    return html;
  }).join('');
}

function feedRow(event) {
  return '<div class="feed-row"><span class="t">' + fmtTime(event.ts) + '</span>' +
    '<span class="k ' + esc(event.type || 'log') + '">' + esc(event.type || 'log') + '</span>' +
    '<span class="m">' + esc(event.message || '') + '</span></div>';
}

function renderRawFeed() {
  const feed = $('feed');
  const rows = state.events;
  feed.innerHTML = rows.length ? rows.map(feedRow).join('') : '<div class="empty">暂无事件</div>';
  feed.scrollTop = feed.scrollHeight;
}

function renderFeed() {
  if (state.feedMode === 'raw') renderRawFeed();
  else renderResultsFeed();
}

let feedRenderTimer = null;
function appendFeed(event) {
  // 事件密集时节流重绘，避免结果流闪烁
  if (feedRenderTimer) return;
  feedRenderTimer = setTimeout(() => { feedRenderTimer = null; renderFeed(); }, 300);
}

function pushEvent(event) {
  if (!event || !event.id || state.eventIds.has(event.id)) return false;
  state.eventIds.add(event.id);
  state.events.push(event);
  if (state.events.length > 600) {
    const removed = state.events.shift();
    state.eventIds.delete(removed.id);
  }
  appendFeed(event);
  return true;
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 140);
}

async function refresh() {
  try {
    const data = await api('/api/state');
    state.tasks = data.tasks;
    state.agents = data.agents;
    state.stats = data.stats;
    renderMetrics();
    renderAgents();
    renderChips();
    renderTasks();
    renderFeed();
    renderOrders();
    setConnection(state.connected ? 'ok' : '', state.connected ? '实时连接' : '连接中');
  } catch (error) {
    setConnection('bad', '连接断开');
  }
}

// ===== 指挥指令台（小面板） =====
function orderHint(text, kind) {
  const el = $('ordHint');
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'ord-hint ' + (kind || '');
  el.textContent = text;
}

async function sendOrder() {
  const box = $('ordInput');
  const btn = $('ordSend');
  const text = box.value.trim();
  if (!text) { box.focus(); return; }
  if (btn) { btn.disabled = true; btn.textContent = '下达中'; }
  try {
    const res = await post('/api/commanding', { text });
    const item = res.item || {};
    box.value = '';
    state.orders = [item].concat((state.orders || []).filter((o) => o.id !== item.id));
    renderOrders();
    if (item.taskId) {
      orderHint('已派给 ' + (item.agentId || 'agent') + '，结果会自动回到这条指令下', 'ok');
      await refresh();
    } else {
      orderHint('已记录，需总指挥接手（这条不会自动执行）', 'warn');
    }
  } catch (error) {
    box.value = text;
    orderHint('下达失败：' + error.message, 'bad');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '下达'; }
  }
}

async function loadOrders() {
  try {
    const data = await api('/api/commanding');
    state.orders = (data.items || []).filter((o) => o.status !== 'deleted');
    renderOrders();
  } catch (_) {}
}

const ORD_STATUS = { pending: '待总指挥', processing: '执行中', done: '已完成', failed: '失败', deleted: '已作废' };

// 把指令和它派出去的任务合到一条视图上：任务才是真状态
function orderView(o) {
  const task = o.taskId ? (state.tasks || []).find((t) => t.id === o.taskId) : null;
  let status = o.status || 'pending';
  let result = o.result || '';
  let agent = o.agentId || '';
  if (task) {
    agent = task.agentId || agent;
    if (task.status === 'queued' || task.status === 'running') status = 'processing';
    else if (task.status === 'done') status = 'done';
    else if (task.status === 'failed' || task.status === 'cancelled') status = 'failed';
    const text = task.status === 'done' ? task.result : (task.status === 'failed' ? task.error : '');
    if (text) result = String(text).trim().slice(0, 400);
  }
  return { task, status, result, agent };
}

function renderOrders() {
  const box = $('ordList');
  if (!box) return;
  const items = (state.orders || []).filter((o) => o.status !== 'deleted');
  if (!items.length) {
    box.innerHTML = '<div class="ord-empty">暂无指挥指令</div>';
    return;
  }
  box.innerHTML = items.slice(0, 8).map((o) => {
    const v = orderView(o);
    const meta = [v.agent, v.task ? (STATUS_LABEL[v.task.status] || v.task.status) : '']
      .filter(Boolean).join(' · ');
    return '<div class="ord-item ' + esc(v.status) + '"' +
        (v.task ? ' data-task="' + esc(v.task.id) + '" title="点击查看结果卡"' : '') + '>' +
      '<div class="ord-line"><span class="ord-seq">#' + (o.seq || '-') + '</span>' +
      '<span class="ord-text">' + esc(o.text) + '</span>' +
      '<span class="ord-status st-' + esc(v.status) + '">' + (ORD_STATUS[v.status] || v.status) + '</span></div>' +
      (meta ? '<div class="ord-meta">' + esc(meta) + '</div>' : '') +
      (v.result ? '<div class="ord-result">' + esc(v.result) + '</div>' : '') +
      '</div>';
  }).join('');
}

async function loadHistory() {
  try {
    const data = await api('/api/history?limit=400');
    for (const event of data.events) {
      if (!event.id || state.eventIds.has(event.id)) continue;
      state.eventIds.add(event.id);
      state.events.push(event);
    }
    renderFeed();
  } catch (_) {}
}

function connectStream() {
  const source = new EventSource('/api/events');
  source.onopen = () => {
    state.connected = true;
    setConnection('ok', '实时连接');
  };
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (pushEvent(event)) scheduleRefresh();
    } catch (_) {}
  };
  source.onerror = () => {
    state.connected = false;
    setConnection('bad', '重连中');
  };
}

async function doAction(action, id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  try {
    if (action === 'complete') {
      const result = window.prompt('回写该任务的结果摘要（总指挥直领任务）：', '已确认，按计划执行');
      if (result === null) return;
      await post('/api/task/' + encodeURIComponent(id) + '/action', { action: 'complete', result });
    } else if (action === 'edit') {
      openModal('edit', task);
      return;
    } else if (action === 'delete') {
      if (!window.confirm('确定删除该任务并移出看板？此操作不可恢复。')) return;
      await post('/api/task/' + encodeURIComponent(id) + '/action', { action: 'delete' });
      if (state.selected === id) { state.selected = null; }
    } else if (action === 'logs') {
      state.selected = id;
      state.feedMode = 'raw';
      document.querySelectorAll('.stream-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === 'raw'));
      renderFeed();
      renderTasks();
      return;
    } else {
      await post('/api/task/' + encodeURIComponent(id) + '/action', { action });
    }
    await refresh();
  } catch (error) {
    window.alert('操作失败：' + error.message);
  }
}

function openModal(mode, task) {
  state.modalMode = mode;
  const select = $('fAgent');
  select.innerHTML = state.agents.filter((a) => a.available).map((a) =>
    '<option value="' + esc(a.id) + '">' + esc(a.name) + ' · ' + esc(a.id) + '</option>'
  ).join('');
  $('modalTitle').textContent = mode === 'edit' ? '修改任务指令' : '新建任务';
  $('fTitle').value = mode === 'edit' ? (task.title || '') : '';
  $('fPrompt').value = mode === 'edit' ? (task.prompt || '') : '';
  $('fDepends').value = '';
  $('fAgent').disabled = mode === 'edit';
  $('fDepends').parentElement.style.display = mode === 'edit' ? 'none' : '';
  $('fError').textContent = '';
  $('modal').dataset.taskId = mode === 'edit' ? task.id : '';
  $('fSubmit').textContent = mode === 'edit' ? '保存修改' : '提交派单';
  $('modal').hidden = false;
  setTimeout(() => (mode === 'edit' ? $('fPrompt') : $('fTitle')).focus(), 30);
}

function closeModal() { $('modal').hidden = true; }

async function submitModal() {
  const errorBox = $('fError');
  try {
    if (state.modalMode === 'edit') {
      const id = $('modal').dataset.taskId;
      await post('/api/task/' + encodeURIComponent(id) + '/action', {
        action: 'edit', title: $('fTitle').value.trim(), prompt: $('fPrompt').value
      });
    } else {
      const prompt = $('fPrompt').value.trim();
      const title = $('fTitle').value.trim();
      if (!prompt && !title) throw new Error('请至少填写标题或指令');
      await post('/api/task', {
        title, prompt, agentId: $('fAgent').value,
        dependsOn: $('fDepends').value.split(',').map((s) => s.trim()).filter(Boolean)
      });
    }
    closeModal();
    await refresh();
  } catch (error) {
    errorBox.textContent = error.message;
  }
}

async function sendCommand() {
  const input = $('cmdInput');
  const box = $('cmdResult');
  const text = input.value.trim();
  if (!text) return;
  box.hidden = false;
  box.textContent = '中转解析中…';
  try {
    const r = await post('/api/command', { text });
    box.innerHTML = '路由结果：' + esc(r.note) + ' → 任务 <b>' + esc(r.taskId) + '</b>（agent: ' + esc(r.agentId) + '），结果出来会出现在左侧「最近事件」。';
    input.value = '';
    syncChipState();
    await refresh();
  } catch (error) {
    box.innerHTML = '<span style="color:#B4231C">解析失败：' + esc(error.message) + '</span>';
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 900);
    }
  } catch (_) {
    window.alert('复制失败，请手动选择文本');
  }
}

async function downloadArtifact(path, name) {
  try {
    const res = await fetch('/api/artifact?path=' + encodeURIComponent(path));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'artifact';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    window.alert('下载失败：' + error.message);
  }
}

function openLightbox(src, name) {
  $('lightboxImg').src = src;
  $('lightboxCap').textContent = name || '';
  $('lightbox').hidden = false;
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightboxImg').src = '';
}

function bindEvents() {
  $('filters').addEventListener('click', (e) => {
    const button = e.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    renderFilters();
    renderTasks();
  });
  $('taskList').addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (button) { e.stopPropagation(); doAction(button.dataset.action, button.dataset.id); return; }
    const card = e.target.closest('.task-card');
    if (!card) return;
    state.selected = card.dataset.id;
    renderTasks();
    // 在中央结果流里定位该任务
    if (state.feedMode === 'results') {
      renderFeed();
      const target = document.querySelector('.result-card[data-task="' + card.dataset.id + '"]');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  // 点指挥指令 → 跳到对应结果卡
  $('ordList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-task]');
    if (!item) return;
    const id = item.dataset.task;
    state.selected = id;
    if (state.feedMode !== 'results') {
      state.feedMode = 'results';
      document.querySelectorAll('.stream-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === 'results'));
    }
    renderFeed();
    const target = document.querySelector('.result-card[data-task="' + id + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else orderHint('结果卡还没生成，稍等刷新', 'warn');
  });
  $('feed').addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { copyText(cp.dataset.copy, cp); return; }
    const dl = e.target.closest('[data-download]');
    if (dl) { downloadArtifact(dl.dataset.download, dl.dataset.name); return; }
    const art = e.target.closest('[data-artifact]');
    if (art) {
      api('/api/artifact?path=' + encodeURIComponent(art.dataset.artifact))
        .then((data) => openTextArtifact(data))
        .catch((error) => window.alert('读取产物失败：' + error.message));
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) { openLightbox(zoom.dataset.zoom, zoom.dataset.name); }
  });
  document.querySelectorAll('.stream-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.feedMode = tab.dataset.mode;
      document.querySelectorAll('.stream-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderFeed();
    });
  });
  $('clearFeed').addEventListener('click', () => {
    state.events = []; state.eventIds.clear(); renderFeed();
  });
  $('globalPause').addEventListener('click', async () => {
    try {
      await post('/api/global', { action: state.stats.paused ? 'resume' : 'pause' });
      await refresh();
    } catch (error) { window.alert('操作失败：' + error.message); }
  });
  $('newTask').addEventListener('click', () => openModal('create'));
  $('agentPoolBtn').addEventListener('click', () => { $('agentModal').hidden = false; });
  $('purgeDone').addEventListener('click', async () => {
    try {
      const r = await post('/api/global', { action: 'purge' });
      window.alert('已清理 ' + (r.purged || 0) + ' 条已结束任务');
      await refresh();
    } catch (error) { window.alert('清理失败：' + error.message); }
  });
  $('cmdSend').addEventListener('click', sendCommand);
  $('cmdChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.classList.contains('off')) return;
    applyQuickAgent(chip.dataset.agent);
  });
  $('cmdInput').addEventListener('input', syncChipState);
  $('ordSend').addEventListener('click', sendOrder);
  $('ordInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendOrder(); }
  });
  $('cmdInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendCommand();
  });
  $('lightbox').addEventListener('click', closeLightbox);
  $('fSubmit').addEventListener('click', submitModal);
  $('modal').addEventListener('click', (e) => { if (e.target.dataset.close) closeModal(); });
  $('agentModal').addEventListener('click', (e) => { if (e.target.dataset.close) $('agentModal').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); $('agentModal').hidden = true; closeLightbox(); }
  });
  document.querySelectorAll('.cli').forEach((el) => {
    el.addEventListener('click', () => copyText(el.dataset.cmd, el));
  });
}

function openTextArtifact(data) {
  // 文本产物用弹层展示
  const box = $('fPrompt');
  box.value = data.text || '';
  $('modalTitle').textContent = '产物预览 · ' + (data.name || '');
  $('modal').dataset.taskId = '';
  $('fAgent').parentElement.style.display = 'none';
  $('fTitle').parentElement.style.display = 'none';
  $('fDepends').parentElement.style.display = 'none';
  $('fError').textContent = '';
  $('fSubmit').style.display = 'none';
  $('modal').hidden = false;
  // 关闭时恢复 modal 用于新建任务：交给 openModal 重置
  const observer = new MutationObserver(() => {
    if ($('modal').hidden) {
      observer.disconnect();
      $('fAgent').parentElement.style.display = '';
      $('fTitle').parentElement.style.display = '';
      $('fDepends').parentElement.style.display = '';
      $('fSubmit').style.display = '';
    }
  });
  observer.observe($('modal'), { attributes: true, attributeFilter: ['hidden'] });
}

async function init() {
  bindEvents();
  renderFilters();
  await loadHistory();
  await loadOrders();
  await refresh();
  connectStream();
  setInterval(refresh, 5000);
  setInterval(loadOrders, 10000);
}

init();
