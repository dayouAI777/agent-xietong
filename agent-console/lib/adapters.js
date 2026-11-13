'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const store = require('./store');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// 配置里的路径占位符：跨机器同步时不要写死绝对路径
// 支持 ${PROJECT} ${USERPROFILE} ${APPDATA} ${HOME} 与 %VAR%
function expandPath(value) {
  if (value == null) return value;
  return String(value)
    .replace(/\$\{PROJECT\}/g, PROJECT_ROOT)
    .replace(/\$\{USERPROFILE\}/g, process.env.USERPROFILE || '')
    .replace(/\$\{APPDATA\}/g, process.env.APPDATA || '')
    .replace(/\$\{HOME\}/g, process.env.USERPROFILE || '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] || m);
}

const DANGEROUS = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/[sq]|format\s+[a-z]:|mkfs|shutdown|diskpart|reg\s+delete)\b/i;

function normDir(dir) {
  if (process.platform === 'win32' && /^\/[A-Za-z]\//.test(dir)) {
    return dir[1].toUpperCase() + ':\\' + dir.slice(3).replace(/\//g, '\\');
  }
  return dir;
}

function findExe(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const raw of dirs) {
    const dir = normDir(raw);
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    }
  }
  return null;
}

function resolveCommand(name) {
  const raw = String(name || '').trim();
  try {
    if (raw && fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw;
  } catch (_) {}
  return findExe(raw) || raw;
}

function hasCommand(name) {
  return !!findExe(name);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('__cancelled__'));
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('__cancelled__'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function runProcess(spec, api) {
  return new Promise((resolve, reject) => {
    if (api.signal && api.signal.aborted) return resolve({ cancelled: true, stdout: '' });

    let child;
    try {
      child = spawn(spec.command, spec.args || [], {
        cwd: spec.cwd || store.ROOT,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, spec.env || {}),
        shell: !!spec.shell,
        windowsHide: true,
        signal: api.signal,
        stdio: [spec.stdioIn === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      return reject(error);
    }

    const stdout = [];
    const stderr = [];

    const attach = (stream, sink, level) => {
      if (!stream) return;
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      stream.on('data', (chunk) => {
        try {
          buffer += decoder.write(chunk);
        } catch (_) {
          buffer += chunk.toString('utf8');
        }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.trim()) {
            let handled = false;
            if (spec.onLine) {
              try { handled = spec.onLine(line, level) === false; } catch (_) { handled = false; }
            }
            if (!handled) {
              sink.push(line);
              api.log(line, level);
            }
          }
        }
      });
      stream.on('end', () => {
        buffer += decoder.end();
        if (buffer.trim()) {
          sink.push(buffer.trim());
          api.log(buffer.trim(), level);
        }
      });
    };

    attach(child.stdout, stdout, 'info');
    attach(child.stderr, stderr, 'warn');

    if (spec.stdin !== undefined && spec.stdin !== null && child.stdin) {
      child.stdin.write(String(spec.stdin));
      child.stdin.end();
    }

    child.on('error', (error) => {
      if ((api.signal && api.signal.aborted) || error.name === 'AbortError') {
        resolve({ cancelled: true, stdout: stdout.join('\n') });
      } else {
        reject(new Error('无法启动进程 ' + spec.command + '：' + error.message));
      }
    });

    child.on('close', (code) => {
      if (api.signal && api.signal.aborted) return resolve({ cancelled: true, stdout: stdout.join('\n') });
      if (code === 0) return resolve({ cancelled: false, stdout: stdout.join('\n') });
      const tail = stderr.join('\n').slice(-400);
      reject(new Error('进程退出码 ' + code + (tail ? '：' + tail : '')));
    });
  });
}

function truncate(text, limit = 20000) {
  const value = String(text == null ? '' : text);
  return value.length > limit ? value.slice(0, limit) + '\n…（输出已截断）' : value;
}

async function runShell(ctx, api) {
  const command = String(ctx.task.prompt || '').trim();
  if (!command) throw new Error('prompt 为空：shell agent 需要一条命令');
  if (DANGEROUS.test(command)) throw new Error('已拦截高风险命令：' + command);
  api.log('$ ' + command, 'info');
  const out = await runProcess({ command, args: [], shell: true, cwd: ctx.dir }, api);
  if (out.cancelled) return { status: 'cancelled' };
  const result = truncate(out.stdout || '（命令执行完成，无标准输出）');
  api.artifact('stdout.txt', result);
  return { status: 'done', result };
}

async function runNode(ctx, api) {
  const source = String(ctx.task.prompt || '').trim();
  if (!source) throw new Error('prompt 为空：node agent 需要 JS 源码或脚本路径');
  let script = source;
  if (!source.includes('\n') && /\.m?js$/i.test(source) && fs.existsSync(source)) {
    script = source;
  } else {
    script = path.join(ctx.dir, 'main.js');
    fs.writeFileSync(script, source, 'utf8');
  }
  api.log('执行 node 脚本：' + path.basename(script), 'info');
  const out = await runProcess({
    command: process.execPath,
    args: [script],
    cwd: ctx.dir,
    env: { AGENT_RUN_DIR: ctx.dir, AGENT_TASK_ID: ctx.task.id }
  }, api);
  if (out.cancelled) return { status: 'cancelled' };
  const result = truncate(out.stdout || '（脚本执行完成，无标准输出）');
  api.artifact('stdout.txt', result);
  return { status: 'done', result };
}

async function runPython(ctx, api) {
  const source = String(ctx.task.prompt || '').trim();
  if (!source) throw new Error('prompt 为空：python agent 需要 Python 源码或脚本路径');
  let script;
  if (!source.includes('\n') && /\.py$/i.test(source) && fs.existsSync(source)) {
    script = source;
  } else {
    script = path.join(ctx.dir, 'main.py');
    fs.writeFileSync(script, source, 'utf8');
  }
  const python = resolveCommand('python');
  api.log('执行 python 脚本：' + path.basename(script), 'info');
  const out = await runProcess({
    command: python,
    args: [script],
    cwd: ctx.dir,
    env: { AGENT_RUN_DIR: ctx.dir, AGENT_TASK_ID: ctx.task.id }
  }, api);
  if (out.cancelled) return { status: 'cancelled' };
  const result = truncate(out.stdout || '（脚本执行完成，无标准输出）');
  api.artifact('stdout.txt', result);
  return { status: 'done', result };
}

async function runAnalyst(ctx, api) {
  const prompt = String(ctx.task.prompt || '').trim() || '（未填写任务描述）';
  const steps = [
    ['接收指令', '解析任务描述，确认交付物形态与边界'],
    ['拆解子目标', '把主目标拆为可独立验收的阶段'],
    ['列出检查项', '标注依赖、风险与需要人工确认的节点'],
    ['生成执行草案', '输出结构化报告，供总指挥复核'],
    ['归档产物', '写入 runs 目录并回传事件']
  ];
  api.log('内置推演 agent 启动（本地规则生成，不调用外部模型）', 'info');
  for (let i = 0; i < steps.length; i++) {
    await sleep(420 + (i * 130), api.signal);
    api.log('[' + (i + 1) + '/' + steps.length + '] ' + steps[i][0] + '：' + steps[i][1], 'info');
    api.progress(Math.round(((i + 1) / steps.length) * 100));
  }
  const lines = prompt.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const bullets = (lines.length ? lines : [prompt]).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const report = [
    '# 任务推演草案',
    '',
    '- 任务 ID：' + ctx.task.id,
    '- 指派 agent：' + ctx.agent.id,
    '- 生成时间：' + store.now(),
    '- 生成方式：本地规则推演（非模型输出，仅用于跑通闭环与占位）',
    '',
    '## 原始指令',
    '',
    bullets,
    '',
    '## 建议拆解',
    '',
    ...steps.map((s, i) => `${i + 1}. **${s[0]}** — ${s[1]}`),
    '',
    '## 复核检查项',
    '',
    '- 交付物是否有明确的验收标准',
    '- 是否存在需要总指挥人工确认的节点',
    '- 失败时是否可安全重试（幂等性）',
    '- 依赖任务是否全部完成',
    '',
    '## 结论',
    '',
    '本草案由内置推演 agent 生成，供总指挥分派给真实 agent 前复核。'
  ].join('\n');
  api.artifact('report.md', report);
  return { status: 'done', result: '已生成推演草案 report.md（' + steps.length + ' 个阶段）' };
}

// ===== 本地 codex（HTTP responses 通道，绕开 CLI 的 websocket） =====
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_API = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_REFRESH = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function readCodexAuth() {
  const raw = fs.readFileSync(CODEX_AUTH_FILE, 'utf8');
  const auth = JSON.parse(raw);
  if (!auth.tokens || !auth.tokens.access_token) throw new Error('codex auth.json 里没有 access_token，需先 codex login');
  return auth;
}

async function refreshCodexToken(auth) {
  const rt = auth.tokens && auth.tokens.refresh_token;
  if (!rt) throw new Error('auth.json 无 refresh_token，需重新 codex login');
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: rt,
    scope: 'openid profile email'
  });
  const res = await fetch(CODEX_REFRESH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('刷新 codex token 失败 HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
  const j = await res.json();
  auth.tokens.access_token = j.access_token;
  if (j.refresh_token) auth.tokens.refresh_token = j.refresh_token;
  if (j.id_token) auth.tokens.id_token = j.id_token;
  auth.last_refresh = new Date().toISOString();
  fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
  return auth;
}

async function codexRespond(prompt, api, model, retried) {
  const auth = readCodexAuth();
  const payload = {
    model: model || 'gpt-6.1-sol',
    store: false,
    stream: true,
    instructions: '你是多agent工作台里的 codex 执行体。直接给出可用的结果，中文回答，不要寒暄、不要复述问题。',
    input: [{ role: 'user', content: [{ type: 'input_text', text: String(prompt || '') }] }]
  };
  const res = await fetch(CODEX_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + auth.tokens.access_token,
      'Content-Type': 'application/json',
      'originator': 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  });
  if (res.status === 401 && !retried) {
    api.log('access_token 过期，正在刷新', 'warn');
    await refreshCodexToken(auth);
    return codexRespond(prompt, api, model, true);
  }
  if (!res.ok) throw new Error('codex HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));

  const reader = res.body.getReader ? res.body.getReader() : null;
  if (!reader) return '';
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  let lastLog = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(6)); } catch (_) { continue; }
      if (evt.type === 'response.output_text.delta') out += evt.delta || '';
      if (evt.type === 'response.failed' || evt.type === 'error') {
        const msg = (evt.response && evt.response.error && evt.response.error.message) || evt.message || '未知错误';
        throw new Error('codex 返回错误：' + msg);
      }
      const now = Date.now();
      if (out && now - lastLog > 800) {
        lastLog = now;
        api.log('生成中… ' + out.length + ' 字', 'info');
        api.progress(Math.min(95, 20 + Math.floor(out.length / 40)));
      }
    }
  }
  if (!out.trim()) throw new Error('codex 返回空内容');
  return out.trim();
}

function netErrMsg(error) {
  const cause = error && error.cause;
  const c = cause ? (cause.code || cause.message || String(cause)) : '';
  return String(error.message || error) + (c ? '（' + c + '）' : '');
}

// undici 的网络层错误：值得退避重试的那种
function isNetError(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.cause && (error.cause.code || error.cause.message)) || '');
  if (/fetch failed|terminated|socket hang up/i.test(msg)) return true;
  return /UND_ERR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/.test(code);
}

async function runCodexHttp(ctx, api) {
  const prompt = String(ctx.task.prompt || ctx.task.title || '').trim();
  api.log('本地 codex（HTTP responses，模型 gpt-6.1-sol）已接收任务', 'info');
  // 网络瞬断退避重试：0/2s/5s/10s，只对网络层错误重试，4xx 业务错误直接抛
  const delays = [0, 2000, 5000, 10000];
  let text = '';
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) {
      api.log('codex 网络瞬断（' + i + '/' + (delays.length - 1) + '），' + (delays[i] / 1000) + ' 秒后重试', 'warn');
      await new Promise((r) => setTimeout(r, delays[i]));
    }
    try {
      text = await codexRespond(prompt, api, ctx.task.codexModel, false);
      break;
    } catch (error) {
      if (!isNetError(error) || i === delays.length - 1) {
        throw new Error('codex 请求失败：' + netErrMsg(error));
      }
    }
  }
  api.artifact('codex回复.md', text);
  api.progress(100);
  return { status: 'done', result: text.slice(0, 4000) };
}

// ===== 豆包 / DeepSeek 官方 API（OpenAI 兼容，需要 key） =====
const DEEPSEEK_KEY_FILE = path.join(os.homedir(), '.dsh', '.api-key');
const ARK_KEY_FILE = path.join(os.homedir(), '.doubao', '.api-key');

function readKeyFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n')[0].trim(); }
  catch (_) { return ''; }
}

function deepseekKey() { return String(process.env.DEEPSEEK_API_KEY || '').trim() || readKeyFile(DEEPSEEK_KEY_FILE); }
function arkKey() { return String(process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim() || readKeyFile(ARK_KEY_FILE); }

async function openAiChat(prompt, api, opts) {
  const res = await fetch(opts.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + opts.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: '你是多agent工作台里的执行体，直接给结果，中文回答，不寒暄。' },
        { role: 'user', content: String(prompt || '') }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(opts.name + ' HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  if (!text) throw new Error(opts.name + ' 返回空内容');
  return text;
}

// ===== DSH 本地端点（DSH 桌面运行时自己起的 HTTP 服务，无需 key） =====
// 契约：GET /v1/health、POST /v1/run → {ok,text,steps,error}、GET /v1/version
const DSH_ENDPOINT_FILE = path.join(os.homedir(), '.dsh', 'endpoint.json');
const DSH_START_CMD = path.join(os.homedir(), '.dsh', 'endpoint', 'start.cmd');
const dshState = { ok: false, at: 0, port: 0, version: '', models: [], lastErr: '', started: false };

function dshPort() {
  if (process.env.DSH_PORT) return Number(process.env.DSH_PORT) || 7789;
  try {
    const j = JSON.parse(fs.readFileSync(DSH_ENDPOINT_FILE, 'utf8'));
    if (j && j.port) return Number(j.port);
  } catch (_) { /* 端点没起过就没有这个文件 */ }
  return 7789;
}

function dshBase() { return 'http://127.0.0.1:' + dshPort(); }

async function probeDsh(force) {
  const now = Date.now();
  if (!force && now - dshState.at < 15000) return dshState.ok;
  dshState.at = now;
  try {
    const res = await fetch(dshBase() + '/v1/health', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error('health 返回 ok=false');
    dshState.ok = true;
    dshState.port = Number(j.port) || dshPort();
    dshState.version = String(j.version || '');
    dshState.models = Array.isArray(j.models) ? j.models : [];
    dshState.lastErr = '';
  } catch (error) {
    dshState.ok = false;
    dshState.lastErr = error.message;
  }
  return dshState.ok;
}

// 端点没起时拉一次启动脚本（幂等：已在跑会打印 DSH_ENDPOINT 后退出）
async function ensureDsh(api) {
  if (await probeDsh(true)) return true;
  if (dshState.started || !fs.existsSync(DSH_START_CMD)) return false;
  dshState.started = true;
  api.log('DSH 端点未运行，正在拉起 ' + DSH_START_CMD, 'warn');
  try {
    const child = spawn('cmd', ['/c', DSH_START_CMD], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    api.log('拉起 DSH 失败：' + error.message, 'error');
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (await probeDsh(true)) { api.log('DSH 端点已就绪 ' + dshBase(), 'info'); return true; }
  }
  return false;
}

async function runDsh(ctx, api) {
  const base = dshBase();
  const prompt = String(ctx.task.prompt || ctx.task.title || '');
  const timeoutMs = Math.max(5000, Number(process.env.DSH_TIMEOUT_MS || 600000));
  if (!(await ensureDsh(api))) {
    throw new Error('DSH 端点未运行（' + base + '）。启动：cmd /c "%USERPROFILE%\\.dsh\\endpoint\\start.cmd"');
  }
  api.log('DSH 本地端点（' + base + '，' + (dshState.version || '未知版本') + '）已接收任务', 'info');

  const res = await fetch(base + '/v1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, timeout_ms: timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 30000)
  });
  const raw = await res.text();
  let j;
  try { j = JSON.parse(raw); }
  catch (_) { throw new Error('DSH 返回非 JSON（HTTP ' + res.status + '）：' + raw.slice(0, 200)); }

  for (const step of (j.steps || [])) {
    api.log('DSH 步骤 ' + (step.tool || '?') + '：' + String(step.brief || '').slice(0, 160), 'info');
  }
  if (!j.ok) {
    if (res.status === 429) throw new Error('DSH 正忙（429）：' + (j.error || 'another run is in progress'));
    if (res.status === 504) throw new Error('DSH 超时（504）：' + (j.error || 'timeout'));
    throw new Error('DSH 执行失败（HTTP ' + res.status + '）：' + (j.error || '未知错误'));
  }
  const text = String(j.text || '').trim();
  if (!text) throw new Error('DSH 返回空内容');
  api.artifact('dsh回复.md', text);
  return { status: 'done', result: text.slice(0, 4000), steps: j.steps || [] };
}

// 预热 + 定期复查（unref 不阻塞进程退出）
const dshTimer = setInterval(() => { probeDsh(true).catch(() => {}); }, 15000);
if (dshTimer.unref) dshTimer.unref();
probeDsh(true).catch(() => {});

async function runDeepseek(ctx, api) {
  const key = deepseekKey();
  if (!key) throw new Error('未配置 DeepSeek API key（环境变量 DEEPSEEK_API_KEY 或 ' + DEEPSEEK_KEY_FILE + '）');
  api.log('DeepSeek API（' + (process.env.DEEPSEEK_MODEL || 'deepseek-chat') + '）已接收任务', 'info');
  const text = await openAiChat(ctx.task.prompt || ctx.task.title, api, {
    base: process.env.DEEPSEEK_BASE || 'https://api.deepseek.com',
    key,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    name: 'DeepSeek'
  });
  api.artifact('deepseek回复.md', text);
  return { status: 'done', result: text.slice(0, 4000) };
}

async function runDoubao(ctx, api) {
  const key = arkKey();
  if (!key) throw new Error('未配置豆包（火山方舟）API key（环境变量 ARK_API_KEY 或 ' + ARK_KEY_FILE + '）');
  const model = process.env.DOUBAO_MODEL || '';
  if (!model) throw new Error('未配置 DOUBAO_MODEL（火山方舟的接入点 ID，如 ep-2024xxxx）');
  api.log('豆包方舟（' + model + '）已接收任务', 'info');
  const text = await openAiChat(ctx.task.prompt || ctx.task.title, api, {
    base: process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3',
    key,
    model,
    name: '豆包'
  });
  api.artifact('豆包回复.md', text);
  return { status: 'done', result: text.slice(0, 4000) };
}

async function runDelegate(ctx, api) {
  const file = path.join(store.INBOX, ctx.task.id + '.md');
  const body = [
    '# 待总指挥处理的任务',
    '',
    '- 任务 ID：' + ctx.task.id,
    '- 标题：' + ctx.task.title,
    '- 创建时间：' + ctx.task.createdAt,
    '',
    '## 指令',
    '',
    String(ctx.task.prompt || ''),
    '',
    '## 回写方式',
    '',
    '```bash',
    'node bin/agentctl.js complete ' + ctx.task.id + ' --result "处理结果摘要"',
    '```',
    '',
    '如需附带产物，加 `--file <产物绝对路径>`。'
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  api.artifact('委托单.md', body);
  api.log('已写入 inbox/' + ctx.task.id + '.md，等待总指挥阿Q认领', 'info');
  api.progress(50);
  return { status: 'waiting', result: '已委托总指挥，等待回写' };
}

function makeJsonlParser(api) {
  return (line) => {
    const text = String(line || '').trim();
    if (!text.startsWith('{')) return undefined;
    let ev;
    try { ev = JSON.parse(text); } catch (_) { return undefined; }
    const type = ev.type || '';
    const item = ev.item || {};
    let message = null;
    let level = 'info';
    if (type === 'thread.started') {
      message = '会话已建立 thread=' + String(ev.thread_id || '').slice(0, 8);
    } else if (type === 'turn.started') {
      message = '开始处理回合';
    } else if (type === 'item.started') {
      message = item.type ? '执行中：' + item.type : null;
    } else if (type === 'item.completed') {
      if (item.type === 'reasoning') {
        message = '思考：' + String(item.text || '').replace(/\s+/g, ' ').slice(0, 140);
      } else if (item.type === 'command_execution') {
        message = '命令：' + String(item.command || '').replace(/\s+/g, ' ').slice(0, 140);
      } else if (item.type === 'file_change') {
        message = '文件变更：' + String(Array.isArray(item.paths) ? item.paths.join(', ') : item.path || '').slice(0, 140);
      } else if (item.type === 'agent_message') {
        message = '回复：' + String(item.text || '').replace(/\s+/g, ' ').slice(0, 240);
      } else if (item.type) {
        message = '完成：' + item.type;
      }
    } else if (type === 'turn.completed') {
      const usage = ev.usage || {};
      message = '回合完成（tokens ' + (usage.input_tokens != null ? usage.input_tokens : '?') + ' 入 / ' +
        (usage.output_tokens != null ? usage.output_tokens : '?') + ' 出）';
    } else if (type === 'turn.failed' || type === 'error' || type === 'stream.error') {
      message = '错误：' + String(ev.message || item.text || JSON.stringify(ev)).slice(0, 240);
      level = 'error';
    }
    if (message) api.log(message, level);
    return false;
  };
}

// 递归收集某目录下 mtime 晚于 sinceMs 的文件（用于扫描 agent 自带输出目录）
function collectRecentFiles(root, sinceMs) {
  const realRoot = String(root).startsWith('~/')
    ? path.join(process.env.USERPROFILE || process.env.HOME || '', String(root).slice(2))
    : String(root);
  const results = [];
  walk(fs.existsSync(realRoot) ? realRoot : String(root));
  return results;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs && st.size > 100) {
          results.push({ path: p, name: e.name, base: e.name.replace(/\.[^.]+$/, ''), ext: (e.name.match(/\.[^.]+$/) || [''])[0] });
        }
      } catch (_) {}
    }
  }
}

async function runExternal(ctx, api, agent) {
  const promptFile = path.join(ctx.dir, 'prompt.txt');
  fs.writeFileSync(promptFile, String(ctx.task.prompt || ''), 'utf8');
  const outputFile = path.join(ctx.dir, 'final.md');
  const substitute = (value) => String(value)
    .replace(/\{\{promptFile\}\}/g, promptFile)
    .replace(/\{\{outputFile\}\}/g, outputFile)
    .replace(/\{\{taskDir\}\}/g, ctx.dir)
    .replace(/\{\{prompt\}\}/g, String(ctx.task.prompt || ''));
  const args = (agent.args || []).map(substitute).map(expandPath);
  const command = expandPath(resolveCommand(agent.command));
  const needsShell = /\.(cmd|bat)$/i.test(command);
  const finalArgs = needsShell
    ? args.map((a) => (/\s/.test(a) ? '"' + String(a).replace(/"/g, '') + '"' : a))
    : args;
  api.log('$ ' + command + ' ' + finalArgs.map((a) => (/\s/.test(a) ? '"' + a.slice(0, 60) + '…"' : a)).join(' '), 'info');

  const useStdin = agent.inputMode === 'stdin';
  const runStart = Date.now();
  // 记录运行前已有文件，跑完后自动发现新增产物
  let before;
  try { before = new Set(fs.readdirSync(ctx.dir)); } catch (_) { before = new Set(); }
  const out = await runProcess({
    command,
    args: finalArgs,
    shell: needsShell,
    cwd: expandPath(agent.cwd) || ctx.dir,
    env: Object.assign({ AGENT_RUN_DIR: ctx.dir }, agent.env || {}),
    stdin: useStdin ? String(ctx.task.prompt || '') : undefined,
    stdioIn: useStdin ? 'pipe' : 'ignore',
    onLine: agent.outputMode === 'jsonl' ? makeJsonlParser(api) : null
  }, api);
  if (out.cancelled) return { status: 'cancelled' };

  if ((out.stdout || '').trim()) api.artifact('cli-events.log', out.stdout);

  // 自动登记运行期间新增的文件：文本类走 artifact，二进制类走 file
  const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|zip|gz|mp4|mp3|wav|pdf|woff2?|ttf)$/i;
  const IGNORED = new Set(['prompt.txt', 'final.md', 'cli-events.log', 'stdout.txt']);
  let added = [];
  try {
    added = fs.readdirSync(ctx.dir)
      .filter((f) => !before.has(f) && !IGNORED.has(f))
      .sort();
  } catch (_) {}
  for (const f of added) {
    const full = path.join(ctx.dir, f);
    try {
      if (BINARY_EXT.test(f)) {
        api.file(f);
        api.log('产物文件：' + full, 'success');
      } else {
        api.artifact(f, fs.readFileSync(full, 'utf8'));
      }
    } catch (_) {}
  }

  // agent.artifactScan：扫描 agent 自带输出目录（如 codex 的 ~/.codex/generated_images），
  // 把运行期间新生成的文件拷进任务目录并登记为产物
  if (Array.isArray(agent.artifactScan) && agent.artifactScan.length) {
    for (const root of agent.artifactScan) {
      for (const found of collectRecentFiles(root, runStart - 3000)) {
        try {
          let dest = path.join(ctx.dir, found.name);
          let n = 1;
          while (fs.existsSync(dest)) {
            dest = path.join(ctx.dir, found.base + '_' + n + found.ext);
            n += 1;
          }
          fs.copyFileSync(found.path, dest);
          api.file(path.basename(dest));
          api.log('发现 agent 产物：' + found.path + ' → ' + path.basename(dest), 'success');
          added.push(path.basename(dest));
        } catch (_) {}
      }
    }
  }

  let finalText = '';
  try {
    finalText = fs.readFileSync(outputFile, 'utf8').trim();
  } catch (_) {}

  if (added.length) {
    const summary = added.join(', ');
    return { status: 'done', result: truncate('新增产物：' + summary + '\n' + (out.stdout || '')) };
  }

  if (finalText) {
    api.artifact('final.md', finalText);
    return { status: 'done', result: truncate(finalText, 8000) };
  }

  const fallback = truncate(out.stdout || '（外部 CLI 执行完成，无标准输出）');
  api.artifact('stdout.txt', fallback);
  return { status: 'done', result: fallback };
}

const BUILTINS = [
  { id: 'analyst', name: '推演 agent', kind: 'builtin', color: '#534AB7', description: '本地规则推演，流式日志 + Markdown 草案，用于跑通闭环', run: runAnalyst },
  { id: 'codex-http', name: 'codex 本地通道', kind: 'builtin', color: '#0F6E56', description: '本机 codex 凭证 + HTTP responses（gpt-6.1-sol），绕开 CLI 的 websocket 故障', run: runCodexHttp },
  { id: 'delegate', name: '总指挥直领', kind: 'builtin', color: '#993C1D', description: '把任务写进 inbox 交给阿Q，等待 complete 回写', run: runDelegate },
  { id: 'shell', name: '本地命令', kind: 'builtin', color: '#5F5E5A', description: '执行一条 shell 命令，输出即产物（含危险命令拦截）', run: runShell },
  { id: 'node', name: 'Node 脚本', kind: 'builtin', color: '#3B6D11', description: '执行 JS 源码或 .js 文件，可用 AGENT_RUN_DIR 写产物', run: runNode },
  { id: 'python', name: 'Python 脚本', kind: 'builtin', color: '#185FA5', description: '执行 Python 源码或 .py 文件，UTF-8 输出', run: runPython },
  { id: 'dsh', name: 'DSH 本地', kind: 'builtin', color: '#1F5FBF', availableWhen: () => dshState.ok, description: 'DSH 桌面运行时的本地 HTTP 端点（127.0.0.1:7789），免 key', run: runDsh },
  { id: 'deepseek', name: 'DeepSeek API', kind: 'builtin', color: '#1F5FBF', availableWhen: () => !!deepseekKey(), description: 'DeepSeek 官方 API（deepseek-chat），需要 key；没 key 时用上面的 DSH 本地端点', run: runDeepseek },
  { id: 'doubao', name: '豆包方舟', kind: 'builtin', color: '#B45309', availableWhen: () => !!(arkKey() && process.env.DOUBAO_MODEL), description: '火山方舟豆包模型，需要 ARK_API_KEY + 接入点 ID', run: runDoubao }
];

function list() {
  store.ensure();
  const cfg = store.readJson(path.join(store.CONFIG, 'agents.json'), {}) || {};
  const agents = BUILTINS.map((a) => {
    const base = Object.assign({ available: true, builtin: true }, a);
    if (typeof a.availableWhen === 'function') {
      try { base.available = !!a.availableWhen(); } catch (_) { base.available = false; }
    }
    delete base.availableWhen;
    return base;
  });

  for (const raw of (cfg.external || []).concat(cfg.custom || [])) {
    if (!raw || !raw.id || !raw.command) continue;
    const detect = raw.detect || raw.command;
    const present = hasCommand(detect);
    const enabled = raw.enabled === true || raw.enabled === 'force' || (raw.enabled === 'auto' && present);
    const agent = Object.assign({}, raw, {
      kind: 'external',
      color: raw.color || '#0F6E56',
      available: !!enabled,
      builtin: false,
      installed: present,
      description: raw.description || (present ? '外部 CLI：' + raw.command : '未检测到 ' + raw.command + '，装上后自动可用'),
      run: (ctx, api) => runExternal(ctx, api, raw)
    });
    agents.push(agent);
  }
  return agents;
}

function get(id) {
  return list().find((a) => a.id === id) || null;
}

module.exports = { list, get, runProcess, sleep, hasCommand, resolveCommand, truncate, BUILTINS };
