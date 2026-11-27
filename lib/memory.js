// 分身的记忆层。零依赖，只用 Node 标准库。
// 三份数据：users/<uid>.json 档案与事实、users/<uid>.log.jsonl 对话流水、users/<uid>.meta.json 计数
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const MAX_FACTS = 30;        // 一个人最多记 30 条事实，超出按新旧和置信度淘汰
const MAX_TURNS_KEEP = 60;   // 流水每人保留最近 60 条（30 轮），更早的丢弃
const CTX_TURNS = 12;        // 拼进上下文最近 12 条
const EXTRACT_EVERY = 5;     // 每 5 轮用户发言提炼一次事实

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} return dir; }
function uidOk(u) { return /^[a-f0-9]{24,48}$/.test(String(u || '')); }
function newUid() { return crypto.randomBytes(18).toString('hex'); }

function paths(USERS, uid) {
  return {
    profile: path.join(USERS, uid + '.json'),
    log: path.join(USERS, uid + '.log.jsonl'),
    meta: path.join(USERS, uid + '.meta.json'),
  };
}

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return fallback; }
}
// 原子写：先写 .tmp 再 rename，避免半截文件
function writeJson(f, obj) {
  try {
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(f + '.tmp', f);
  } catch (e) {}
}

function loadProfile(USERS, uid) {
  const p = paths(USERS, uid);
  let d = readJson(p.profile, null);
  if (!d || typeof d !== 'object') {
    d = {
      uid, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      visits: 0, turns: 0, facts: [], threads: [], tone: '',
    };
  }
  if (!Array.isArray(d.facts)) d.facts = [];
  if (!Array.isArray(d.threads)) d.threads = [];
  return d;
}

function saveProfile(USERS, uid, d) {
  const p = paths(USERS, uid);
  writeJson(p.profile, d);
}

// 记一次到访：首次见 或 距上次超过 30 分钟算新一次会话
function touch(USERS, uid) {
  const d = loadProfile(USERS, uid);
  const now = Date.now();
  const last = Date.parse(d.lastSeen || 0) || 0;
  if (!last || now - last > 30 * 60 * 1000) d.visits = (d.visits || 0) + 1;
  d.lastSeen = new Date(now).toISOString();
  saveProfile(USERS, uid, d);
  return d;
}

function appendTurn(USERS, uid, role, content) {
  const p = paths(USERS, uid);
  const line = JSON.stringify({ t: new Date().toISOString(), role, c: String(content).slice(0, 4000) }) + '\n';
  try { fs.appendFileSync(p.log, line); } catch (e) {}
  return p.log;
}

// 读最近的对话（倒着读尾部，不整文件读，避免大文件拖死）
function recentTurns(USERS, uid, n) {
  const p = paths(USERS, uid);
  let raw = '';
  try {
    const st = fs.statSync(p.log);
    const size = st.size;
    const take = Math.min(size, 200 * 1024); // 只读尾部 200KB
    const fd = fs.openSync(p.log, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, size - take);
    fs.closeSync(fd);
    raw = buf.toString('utf-8');
  } catch (e) { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && (o.role === 'user' || o.role === 'assistant') && typeof o.c === 'string') {
        out.unshift({ role: o.role, content: o.c });
      }
    } catch (e) {} // 尾部可能是半行，跳过
  }
  return out;
}

// 修剪流水，只保留最近 MAX_TURNS_KEEP 条
function trimLog(USERS, uid) {
  const p = paths(USERS, uid);
  let raw = '';
  try { raw = fs.readFileSync(p.log, 'utf-8'); } catch (e) { return; }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= MAX_TURNS_KEEP) return;
  try {
    fs.writeFileSync(p.log + '.tmp', lines.slice(-MAX_TURNS_KEEP).join('\n') + '\n');
    fs.renameSync(p.log + '.tmp', p.log);
  } catch (e) {}
}

// 合并新事实：同 k 同义去重，超出上限按 conf 优先、旧的先淘汰
function mergeFacts(oldFacts, incoming) {
  const list = Array.isArray(oldFacts) ? oldFacts.slice() : [];
  const norm = s => String(s || '').replace(/\s+/g, '').replace(/[，。、,.]/g, '');
  for (const it of Array.isArray(incoming) ? incoming : []) {
    if (!it || !it.k || !it.v) continue;
    const v = String(it.v).trim().slice(0, 80);
    if (!v) continue;
    const k = String(it.k).trim().slice(0, 8);
    const conf = Math.max(0, Math.min(1, Number(it.conf) || 0.6));
    const dup = list.find(x => norm(x.v) === norm(v) || (x.k === k && norm(x.v).includes(norm(v))));
    if (dup) { // 已有相似事实：刷新时间与置信度，不重复添加
      dup.t = new Date().toISOString().slice(0, 10);
      dup.conf = Math.max(dup.conf || 0, conf);
      continue;
    }
    list.push({ k, v, t: new Date().toISOString().slice(0, 10), conf });
  }
  if (list.length <= MAX_FACTS) return list;
  // 超限淘汰：先按 conf 升序（低的先走），同 conf 按时间升序（旧的先走）
  return list.sort((a, b) => (b.conf || 0) - (a.conf || 0) || String(b.t).localeCompare(String(a.t)))
    .slice(0, MAX_FACTS);
}

// 事实 → 给人（模型）看的文字块
function factsBlock(d) {
  const fx = (d.facts || []).filter(f => f && f.v);
  if (!fx.length) return '';
  const byK = {};
  for (const f of fx) {
    const k = f.k || '其他';
    (byK[k] = byK[k] || []).push(f);
  }
  const order = ['身份', '处境', '关注', '态度', '其他'];
  const keys = Object.keys(byK).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const lines = [];
  for (const k of keys) {
    for (const f of byK[k].slice(0, 8)) lines.push('- ' + (k === '其他' ? '' : k + '：') + f.v);
  }
  const th = (d.threads || []).filter(x => x && x.open).slice(-3);
  if (th.length) {
    lines.push('');
    lines.push('【上次没聊完的】');
    for (const x of th) lines.push('- ' + x.open);
  }
  return lines.join('\n');
}

// 距离上次多久：用来让分身说话像熟人
function gapText(lastSeen) {
  const t = Date.parse(lastSeen || 0);
  if (!t) return '';
  const h = (Date.now() - t) / 3600000;
  if (h < 0.5) return '刚聊过';
  if (h < 24) return '今天早些时候聊过';
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天聊过';
  if (d < 7) return d + ' 天前聊过';
  if (d < 30) return Math.floor(d / 7) + ' 周前聊过';
  return Math.floor(d / 30) + ' 个月前聊过';
}

module.exports = {
  MAX_FACTS, CTX_TURNS, EXTRACT_EVERY, MAX_TURNS_KEEP,
  ensureDir, uidOk, newUid, paths, loadProfile, saveProfile, touch,
  appendTurn, recentTurns, trimLog, mergeFacts, factsBlock, gapText, readJson, writeJson,
};
