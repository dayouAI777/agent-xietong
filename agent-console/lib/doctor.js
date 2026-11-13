'use strict';

// 环境体检：把交接文档里的踩坑经验固化成一条命令
// 用法：node bin/agentctl.js doctor [--apply]
//   --apply  把探测到可用代理写进 config/agents.json 的 codex / codex-run env

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const adapters = require('./adapters');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'agents.json');

// 常见本地代理端口（国产客户端端口各不相同，必须实测而不是猜名字）
const CANDIDATE_PORTS = [7890, 7897, 7891, 10809, 10808, 1080, 10090, 10080, 2080, 2081, 8889, 8080, 3128, 4780, 6152, 6153, 12334];

const CLI_NEEDS = {
  'codex': ['chatgpt.com'],
  'codex-run': ['chatgpt.com'],
  'claude-code': ['api.anthropic.com'],
  'gemini-cli': ['generativelanguage.googleapis.com'],
  'opencode': ['api.openai.com']
};

function tcpProbe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, extra) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, extra: extra || '' });
    };
    sock.setTimeout(timeout, () => finish(false, 'timeout'));
    sock.on('connect', () => finish(true));
    sock.on('error', (e) => finish(false, e.code || e.message));
  });
}

// 通过 HTTP 代理发 CONNECT，判断代理是否真能出去
function proxyConnectProbe(proxyHost, proxyPort, targetHost, targetPort = 443, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: targetHost + ':' + targetPort, timeout
    });
    let done = false;
    const finish = (ok, extra) => {
      if (done) return;
      done = true;
      try { req.destroy(); } catch (_) {}
      resolve({ ok, ms: Date.now() - started, extra: extra || '' });
    };
    req.on('connect', (res) => finish(res.statusCode === 200, 'CONNECT ' + res.statusCode));
    req.on('timeout', () => finish(false, 'timeout'));
    req.on('error', (e) => finish(false, e.code || e.message));
    req.end();
  });
}

function parseProxy(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 80) };
  } catch (_) {
    return null;
  }
}

function listeningPorts() {
  if (process.platform !== 'win32') return [];
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  if (!r.stdout) return [];
  const set = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+LISTENING/i);
    if (m) set.add(Number(m[1]));
  }
  return [...set];
}

function shortTarget(hosts) {
  return hosts[0];
}

async function checkProxyEnv(hosts) {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!envProxy) return null;
  const p = parseProxy(envProxy);
  if (!p) return { url: envProxy, ok: false, note: '无法解析' };
  const res = await proxyConnectProbe(p.host, p.port, shortTarget(hosts));
  return { url: envProxy, ok: res.ok, note: res.ok ? res.ms + 'ms' : res.extra, port: p.port };
}

async function scanProxies(hosts) {
  const target = shortTarget(hosts);
  // 环境里塞了一堆本机监听端口（编辑器、沙箱等），先限流并发，避免体检拖成几分钟
  const candidates = new Set([...CANDIDATE_PORTS, ...listeningPorts()]);
  const ports = [...candidates];
  const live = [];
  const CONCURRENCY = 8;

  async function probe(port) {
    const open = await tcpProbe('127.0.0.1', port, 400);
    if (!open.ok) return;
    const res = await proxyConnectProbe('127.0.0.1', port, target, 443, 3000);
    if (res.ok) live.push({ port, ok: true, note: res.ms + 'ms' });
  }

  for (let i = 0; i < ports.length; i += CONCURRENCY) {
    await Promise.all(ports.slice(i, i + CONCURRENCY).map(probe));
  }
  return live.sort((a, b) => a.port - b.port);
}

async function checkWood(agent) {
  if (!agent || !agent.args) return null;
  const script = agent.args[0];
  const exists = fs.existsSync(script);
  let endpoint = '';
  let keyOk = false;
  if (exists) {
    try {
      const src = fs.readFileSync(script, 'utf8');
      const base = src.match(/DEFAULT_BASE\s*=\s*"([^"]+)"/);
      endpoint = (process.env.UMAPIS_BASE || (base && base[1]) || '').trim();
      const keyFile = src.match(/密匙\.txt|key.*\.txt/i);
      const home = process.env.USERPROFILE || '';
      const candidateKeys = [
        path.join(home, 'Desktop', '生图API', '密匙.txt'),
        path.join(home, 'Desktop', '生图API', '密钥.txt')
      ];
      keyOk = candidateKeys.some((f) => fs.existsSync(f));
      if (!keyOk && keyFile) keyOk = true;
    } catch (_) {}
  }
  let reach = { ok: false, extra: 'skipped' };
  if (endpoint) {
    const u = new URL(endpoint);
    reach = await tcpProbe(u.hostname, Number(u.port || 80), 5000);
  }
  return { script, exists, endpoint, keyOk, reach };
}

async function run({ apply = false } = {}) {
  const lines = [];
  const ok = (s) => '\x1b[32m✔\x1b[0m ' + s;
  const bad = (s) => '\x1b[31m✘\x1b[0m ' + s;
  const warn = (s) => '\x1b[33m!\x1b[0m ' + s;

  lines.push('');
  lines.push('agent-console 环境体检');
  lines.push('='.repeat(62));

  // 1. 运行时与目录
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  lines.push(nodeMajor >= 18 ? ok('Node ' + process.version) : bad('Node ' + process.version + '（需 ≥18）'));
  for (const d of ['data', 'data/tasks', 'runs', 'inbox']) {
    const p = path.join(ROOT, d);
    lines.push(fs.existsSync(p) ? ok('目录 ' + d) : warn('目录 ' + d + ' 不存在（运行 init 创建）'));
  }
  for (const cmd of ['python', 'node']) {
    lines.push(adapters.hasCommand(cmd) ? ok('命令 ' + cmd) : warn('命令 ' + cmd + ' 未找到'));
  }

  // 2. agent 注册表
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const externals = cfg.external || [];
  lines.push('');
  lines.push('外部 agent');
  lines.push('-'.repeat(62));
  for (const a of externals) {
    const resolved = adapters.resolveCommand(a.command);
    const available = fs.existsSync(resolved) || adapters.hasCommand(a.command);
    lines.push((available ? ok('') : warn('')) + a.id.padEnd(12) + (available ? '可执行: ' + resolved : '未安装（' + a.command + '）'));
  }

  // 3. 网络出口
  lines.push('');
  lines.push('网络出口（外部 CLI 依赖）');
  lines.push('-'.repeat(62));
  const results = {};
  for (const [id, hosts] of Object.entries(CLI_NEEDS)) {
    if (!externals.some((a) => a.id === id)) continue;
    const host = shortTarget(hosts);
    const direct = await tcpProbe(host, 443, 5000);
    const env = await checkProxyEnv(hosts);
    const found = direct.ok ? [] : await scanProxies(hosts);
    results[id] = { host, direct, env, found };
    let line = (direct.ok ? ok('') : bad('')) + id.padEnd(12) + host + ' 直连' + (direct.ok ? '通' : '不通(' + direct.extra + ')');
    if (!direct.ok) {
      if (env && env.ok) line += ' | 环境变量代理可用 ' + env.url;
      else if (env) line += ' | 环境变量代理 ' + env.url + ' 失败(' + env.note + ')';
      line += found.length ? ' | 探测到可用本地代理: ' + found.map((f) => f.port).join(',') : ' | 未发现可用本地代理';
    }
    lines.push(line);
  }

  // 3.5 CLI 自身的本地中转/凭证（claude 常挂 cc-studio 中转，进程没起就会静默挂死）
  lines.push('');
  lines.push('CLI 本地中转与凭证');
  lines.push('-'.repeat(62));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(claudeSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
      const base = (s.env && s.env.ANTHROPIC_BASE_URL) || '';
      if (base) {
        const u = new URL(base);
        const local = /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
        if (local) {
          const hit = await tcpProbe(u.hostname, Number(u.port || 80), 1200);
          lines.push(hit.ok
            ? ok('claude 中转 ' + base + ' 在跑')
            : bad('claude 中转 ' + base + ' 未启动（cc-studio 之类的中转没开，claude 会一直挂着不出结果）'));
        } else {
          lines.push(warn('claude 走远端 ' + base));
        }
      } else {
        lines.push(warn('claude settings 未配 ANTHROPIC_BASE_URL（走官方端点，需有效登录）'));
      }
    } catch (e) {
      lines.push(warn('claude settings.json 解析失败：' + e.message));
    }
  } else {
    lines.push(warn('未找到 ~/.claude/settings.json'));
  }
  const codexAuth = path.join(home, '.codex', 'auth.json');
  lines.push(fs.existsSync(codexAuth) ? ok('codex 登录凭证 auth.json 存在') : bad('codex auth.json 不存在，需先 codex login'));

  // 4. 朽木生图通道  lines.push('');
  lines.push('朽木生图通道（零积分主通道）');
  lines.push('-'.repeat(62));
  const imgAgent = externals.find((a) => a.id === 'imagegen');
  const wood = await checkWood(imgAgent);
  if (!wood) {
    lines.push(warn('config 里没有 imagegen 条目'));
  } else {
    lines.push(wood.exists ? ok('脚本 ' + wood.script) : bad('脚本不存在 ' + wood.script));
    lines.push(wood.reach.ok ? ok('端点 ' + wood.endpoint + '（' + wood.reach.ms + 'ms）') : bad('端点不可达 ' + wood.endpoint + '（' + wood.reach.extra + '）'));
    lines.push(wood.keyOk ? ok('API 密匙文件存在') : warn('未找到 密匙.txt（若脚本内置 key 可忽略）'));
  }

  // 5. Web 服务
  const port = Number(process.env.PORT || 7788);
  const web = await tcpProbe('127.0.0.1', port, 800);
  lines.push('');
  lines.push((web.ok ? ok('') : warn('')) + '看板 ' + port + (web.ok ? ' 运行中 → http://127.0.0.1:' + port : ' 未运行'));

  // 6. 结论 / 修复
  const broken = Object.entries(results).filter(([, r]) => !r.direct.ok && !(r.env && r.env.ok));
  lines.push('');
  lines.push('='.repeat(62));
  if (broken.length === 0) {
    lines.push('\x1b[32m全部外部通道可达。\x1b[0m');
  } else {
    for (const [id, r] of broken) {
      const best = r.found[0];
      if (best) {
        lines.push(warn(id + ' 需要代理：可用 127.0.0.1:' + best.port));
        if (apply) {
          const entry = externals.find((a) => a.id === id);
          entry.env = entry.env || {};
          entry.env.HTTPS_PROXY = 'http://127.0.0.1:' + best.port;
          entry.env.HTTP_PROXY = 'http://127.0.0.1:' + best.port;
        }
      } else {
        lines.push(bad(id + ' 无出口：本机没有可用代理，先开代理客户端再跑 doctor'));
      }
    }
    if (apply) {
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
      lines.push(ok('已写入 config/agents.json（重启服务生效）'));
    } else {
      lines.push('修复：node bin/agentctl.js doctor --apply 自动写入探测到的代理');
    }
  }
  lines.push('');
  console.log(lines.join('\n'));

  const allOk = broken.length === 0;
  return allOk;
}

module.exports = { run };

if (require.main === module) {
  run({ apply: process.argv.includes('--apply') })
    .then((allOk) => { process.exitCode = allOk ? 0 : 1; })
    .catch((e) => { console.error('体检失败：' + e.message); process.exitCode = 2; });
}
