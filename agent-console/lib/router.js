'use strict';

// 总控命令解析器（中转路由的"解析"环节）
// 用户在总控台输入自然语言命令 → 这里解析出 agent 与 prompt → 内核派发
// 解析不了的命令转 delegate（待指挥），由阿Q 处理

const PREFIX_RE = /^\s*(?:阿Q|阿q|AQ|aq)\s*[:：,，]\s*/;

function cut(text) {
  return String(text || '').trim();
}

// 返回 { agentId, prompt, title, note } 或 { agentId: 'delegate', prompt: 原文, note }
function parseCommand(raw) {
  let text = cut(raw);
  if (!text) return { agentId: 'delegate', prompt: '', title: '空命令', note: '命令为空，转交阿Q' };
  text = text.replace(PREFIX_RE, '');

  // @agent 直指：@analyst 推演一下...（@codex 统一给执行版，只读版走「问」入口）
  const at = text.match(/^@([a-zA-Z0-9_-]+)\s*[:：]?\s*([\s\S]+)$/);
  if (at) {
    const id = (at[1] === 'codex' || at[1] === 'codex-run') ? 'codex-http' : at[1];
    return { agentId: id, prompt: cut(at[2]), title: cut(at[2]).slice(0, 24), note: '直指 agent：@' + at[1] };
  }

  // 点名 agent：让/用/叫/派/给 + agent 词开头 → 归被点名的 agent，它的能力优先
  // 例：codex 生图 xxx（走 codex 自己的生图能力，不走朽木）；用朽木画 xxx（才走朽木）
  const AGENT_WORDS = {
    'codex-http': /^(codex(?:-run|-http)?|codex执行版|codex问答|codex-qa)$/i,
    'dsh': /^(dsh|本地ds|本地dsh)$/i,
    'deepseek': /^(deepseek)$/i,
    'doubao': /^(豆包|豆包工作|doubao)$/i,
    'imagegen': /^(朽木生图|朽木|朽木通道)$/,
    'analyst': /^(analyst|推演agent)$/i,
    'claude-code': /^(claude(?:-code)?|claudecode)$/i,
    'gemini-cli': /^(gemini(?:-cli)?)$/i,
    'opencode': /^opencode$/i,
    'shell': /^(shell|本地命令)$/,
    'python': /^(python|py)$/,
    'node': /^node$/
  };
  const IMAGE_VERB = /^(?:生图|画张?|画一幅|来一张|draw|image|生成一张)/i;
  const prefixed = text.match(/^(?:让|用|叫|派|给)\s*[:：]?\s*([\s\S]+)$/);
  const head = prefixed ? prefixed[1] : text;
  // 首词：英文字母串（含连字符）或特定中文 agent 词
  const wordMatch = head.match(/^([a-zA-Z][a-zA-Z0-9_-]*|朽木生图|朽木|本地命令|推演agent|codex执行版|豆包工作|豆包|deepseek|DSH)\s*(?:[:：,，]\s*|(?=\S))([\s\S]*)$/);
  if (wordMatch) {
    const word = wordMatch[1];
    const rest = cut(wordMatch[2]);
    for (const [agentId, re] of Object.entries(AGENT_WORDS)) {
      if (re.test(word)) {
        if (agentId === 'imagegen' || IMAGE_VERB.test(rest)) {
          return { agentId, prompt: rest || word, title: (word + ' ' + rest).slice(0, 24),
            note: agentId === 'imagegen'
              ? '点名朽木 → 朽木直连（零积分）'
              : '点名 ' + agentId + ' 生图 → 用该 agent 自己的生图能力，不走朽木' };
        }
        return { agentId, prompt: rest, title: rest.slice(0, 24), note: '点名 agent：' + agentId };
      }
    }
  }

  // 生图（未点名 agent）→ 朽木直连
  let m = text.match(/^(?:生图|画张?|画一幅|来一张|draw|image)\s*[:：]?\s*([\s\S]+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'imagegen', prompt: p, title: '生图：' + p.slice(0, 20), note: '识别为生图 → 朽木通道（零积分）' };
  }

  // 写代码 / 推理 / codex → codex 本地通道（HTTP responses）
  m = text.match(/^(?:codex|写代码|编码|推理|分析)\s*[:：]?\s*([\s\S]+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'codex-http', prompt: p, title: 'Codex：' + p.slice(0, 20), note: '识别为推理/编码 → codex 本地通道（gpt-6.1-sol）' };
  }

  // 快问快答 → codex 只读
  m = text.match(/^(?:问|问答|chat|ask)\s*[:：]?\s*([\s\S]+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'codex-http', prompt: p, title: '问答：' + p.slice(0, 20), note: '识别为问答 → codex 本地通道' };
  }

  // 本地命令：跑 / 执行 / run / > / $
  m = text.match(/^(?:跑|执行|run|shell|>|\\$)\s*[:：]?\s*(.+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'shell', prompt: p, title: '命令：' + p.slice(0, 24), note: '识别为本地命令 → shell（零积分）' };
  }

  // python / node 脚本
  m = text.match(/^(?:py|python)\s*[:：]\s*([\s\S]+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'python', prompt: p, title: 'Python：' + p.slice(0, 20), note: '识别为 Python 脚本 → python（零积分）' };
  }
  m = text.match(/^(?:js|node)\s*[:：]\s*([\s\S]+)$/i);
  if (m) {
    const p = cut(m[1]);
    return { agentId: 'node', prompt: p, title: 'Node：' + p.slice(0, 20), note: '识别为 Node 脚本 → node（零积分）' };
  }

  // 都不匹配 → 交给本地 codex 理解并执行（它比规则更懂人话）
  return { agentId: 'codex-http', prompt: text, title: text.slice(0, 24), note: '规则未识别 → 交给 codex 本地通道执行' };
}

module.exports = { parseCommand };
