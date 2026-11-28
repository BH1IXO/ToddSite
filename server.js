const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const MEM = require('./lib/memory');
const EXT = require('./lib/extract');
const AUTH_LIB = require('./lib/auth');
const KB = require('./lib/kb').open(process.env.KB_DIR || path.join(__dirname, 'data', 'kb'));
const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD; // 后台密码只从环境变量读，代码里不放任何默认值
if (!PASS) { console.error('请先设置环境变量 ADMIN_PASSWORD'); process.exit(1); }
if (PASS.length < 12) console.warn('[auth] 警告：ADMIN_PASSWORD 少于 12 位，建议换成更长的随机密码');
const ROOT = __dirname, PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data', 'site.json');
const USERS = MEM.ensureDir(path.join(ROOT, 'data', 'users'));
const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const AUTH = AUTH_LIB.create({
  password: PASS,
  maxFails: envNum('LOGIN_MAX_FAILS', 5),
  windowMs: envNum('LOGIN_WINDOW_MINUTES', 15) * 60e3,
  lockMs: envNum('LOGIN_LOCK_MINUTES', 15) * 60e3,
  sessionTtlMs: envNum('SESSION_TTL_HOURS', 12) * 3600e3,
  logFile: process.env.LOGIN_LOG_FILE || path.join(ROOT, 'data', 'logs', 'admin-login.log'),
});
setInterval(AUTH.prune, 10 * 60e3).unref();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > limit) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => ok(b));
    req.on('error', no);
  });
}
function authed(req) { return AUTH.check(req.headers['x-token']); }


const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const chatHits = new Map(), commentHits = new Map();
let siteDay = { d: '', n: 0 };
// 反向代理后面：可信代理把来源 IP 追加在 x-forwarded-for 末尾，取倒数第 N 段（N=TRUST_PROXY 的数值，默认 1）。
// 不取第一段：那是客户端自己带的，可以随意伪造来绕过登录锁定和限流。
// TRUST_PROXY 不设、为 0 或 false 时不信任该头。
const TP = String(process.env.TRUST_PROXY || '').trim();
const PROXY_HOPS = !TP || TP === '0' || TP.toLowerCase() === 'false' ? 0 : (parseInt(TP, 10) > 0 ? parseInt(TP, 10) : 1);
const normIp = s => String(s || '').trim().replace(/^::ffff:/, '').slice(0, 64);
let warnedProxy = false;
function clientIp(req) {
  const sock = normIp(req.socket.remoteAddress);
  const xff = String(req.headers['x-forwarded-for'] || '');
  if (!PROXY_HOPS) {
    if (xff && !warnedProxy && /^(127\.|::1$)/.test(sock)) { // 本机 nginx 转发过来却没开 TRUST_PROXY：所有人都是 127.0.0.1，一个人输错就锁住所有人
      warnedProxy = true;
      console.warn('[auth] 请求经本机反代转发（带 X-Forwarded-For）但没设置 TRUST_PROXY，所有访客 IP 都会记成 ' + sock + '，登录锁定会波及所有人。请设置 TRUST_PROXY=1');
    }
    return sock;
  }
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length >= PROXY_HOPS ? normIp(parts[parts.length - PROXY_HOPS]) : sock;
}
function chatLimit(ip) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (siteDay.d !== day) siteDay = { d: day, n: 0 };
  if (siteDay.n >= 500) return '今天聊得有点多了，请通过下面的联系方式留言，或明天再来。';
  const h = (chatHits.get(ip) || []).filter(t => now - t < 86400000);
  if (h.length >= 40) return '你今天问得不少了，请明天再来，或直接联系我。';
  if (h.filter(t => now - t < 60000).length >= 6) return '问得有点快，稍等一分钟再试。';
  return '';
}
function chatCount(ip) {
  const now = Date.now(), h = (chatHits.get(ip) || []).filter(t => now - t < 86400000);
  h.push(now); chatHits.set(ip, h); siteDay.n++;
  if (chatHits.size > 5000) chatHits.clear();
}
function persona(ud, kbBlock) {
  let d = {}; try { d = JSON.parse(fs.readFileSync(DATA, 'utf-8')); } catch (e) {}
  const p = d.profile || {};
  const areas = (d.workAreas || []).map(a => '- ' + a.title + '：' + a.desc + ((a.items || []).length ? '（项目：' + a.items.map(i => i.name + ' ' + (i.desc || '')).join('；') + '）' : '')).join('\n');
  const cg = d.courses ? (Array.isArray(d.courses.groups) ? d.courses.groups : [d.courses]) : []; // 兼容旧的单课程结构
  const course = cg.length ? '\n' + cg.map(g => '- ' + g.title + (g.status === 'wip' ? '（筹备中，还没开课）' : '') + ((g.lessons || []).length ? '：' + g.lessons.map(l => '第' + l.no + '讲 ' + l.title).join('；') : '')).join('\n') : '';
  const offers = (d.offers || []).map(o => '- ' + o.title + '：' + o.desc + (o.price ? '（' + o.price + '）' : '')).join('\n');
  let posts = '';
  try {
    const dir = path.join(ROOT, 'data', 'posts');
    posts = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))).filter(x => x.published !== false).map(x => '- ' + x.title + '：' + (x.summary || '')).join('\n');
  } catch (e) {}
  // ---- 记忆层：把「关于对方」的东西拼进来，这是人味的来源 ----
  const facts = ud ? MEM.factsBlock(ud) : '';
  const gap = ud && ud.lastSeen ? MEM.gapText(ud.lastSeen) : '';
  const visits = ud ? (ud.visits || 0) : 0;
  const rel = [];
  if (visits > 1) rel.push('你们聊过 ' + visits + ' 次' + (gap ? '，' + gap : '') + '。');
  if (ud && ud.tone) rel.push('对方的说话风格：' + ud.tone);

  return '你是刘涛（Todd）本人，在他的个人主页上直接跟访客说话。用第一人称"我"，你就是刘涛，不是客服、不是助手。\n' +
    '说话像一个真实的、有点忙但愿意聊的人：短句子、说人话，不用"您好""很高兴为您服务"这类客套。\n' +
    '每次回答控制在 120 字以内，除非对方明确要详细展开。\n\n' +
    '【态度】\n' +
    '- 有自己的判断，可以直接说"这个我不这么看""这事我踩过坑"，不要一味迎合。\n' +
    '- 对方问的东西资料里没有，就直说"这个我还没写在网站上"，然后自然把话接下去，别生硬打发人走。\n' +
    '- 对方说得含糊时追问一句，别猜。想知道对方具体在做什么，就问。\n' +
    '- 不编造经历、数据、客户、价格。不透露私人信息（住址、证件、银行卡、家人）。不替自己做商务承诺或报价，有合作意向就引导对方留联系方式。\n' +
    '- 对方问你是不是 AI，如实说这是你的数字分身。\n' +
    '- 下面「资料」是从我的知识库里按对方这个问题检索出来的，可能不完整。优先据实回答，资料没提到的细节不要编。\n' +
    (facts ? '\n【关于对方，你记得的】\n' + facts + '\n' : '') +
    (rel.length ? '\n【你们的关系】\n' + rel.join('') + '别每次都重新自我介绍，就当熟人。\n' : '') +
    '\n【我的简介】' + (p.headline || '') + ' ' + (p.intro || '') + '\n' +
    '【工作方向与项目】\n' + areas + '\n' +
    (course ? '【课程】' + course + '\n' : '') +
    (offers ? '【合作方式】\n' + offers + '\n' : '') +
    (kbBlock ? '【资料】\n' + kbBlock + '\n' : (posts ? '【我写过的文章】\n' + posts + '\n' : ''));
}

// 以磁盘上的旧数据为底合并请求体：请求里没有的字段原样保留，有的以请求为准；workAreas / items / projects 的增删以请求为准
function mergeSite(old, cur) {
  old = old && typeof old === 'object' ? old : {};
  const obj = x => (x && typeof x === 'object' ? x : {});
  const find = (list, fn) => (Array.isArray(list) ? list : []).find(x => x && fn(x)) || null;
  const out = Object.assign({}, old, cur);
  if (Array.isArray(cur.workAreas)) out.workAreas = cur.workAreas.map(a0 => {
    const a = obj(a0), oa = find(old.workAreas, x => (a.key && x.key === a.key) || (a.title && x.title === a.title)) || {};
    const r = Object.assign({}, oa, a);
    if (Array.isArray(a.items)) r.items = a.items.map(i0 => {
      const it = obj(i0), oi = find(oa.items, x => (it.name && x.name === it.name) || (it.url && x.url === it.url)) || {};
      const m = Object.assign({}, oi, it);
      m.tags = Array.isArray(it.tags) ? it.tags : (Array.isArray(oi.tags) ? oi.tags : []);
      return m;
    });
    return r;
  });
  if (Array.isArray(cur.projects)) out.projects = cur.projects.map(p0 => {
    const p = obj(p0), op = find(old.projects, x => p.name && x.name === p.name) || {};
    return Object.assign({}, op, p);
  });
  return out;
}

async function api(req, res, url) {
  if (url === '/api/chat' && req.method === 'POST') {
    if (!DS_KEY) return send(res, 503, { error: '分身暂未开放，请通过下面的联系方式找我。' });
    const tip = chatLimit(clientIp(req));
    if (tip) return send(res, 429, { error: tip });
    let body;
    try { body = JSON.parse(await readBody(req, 20000)); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }

    // ---- 身份：优先用请求里带回来的 uid；没有就发一个新的（首次访问）----
    let uid = null;
    const claimed = String(body.uid || '');
    if (MEM.uidOk(claimed)) {
      const f = MEM.paths(USERS, claimed).profile;
      if (fs.existsSync(f)) uid = claimed;
    }
    let issued = false;
    if (!uid) { uid = MEM.newUid(); issued = true; }

    // 对方这次发的话（前端只发当前这句；老客户端发 messages 也兼容）
    let userText = '';
    if (typeof body.message === 'string' && body.message.trim()) userText = body.message.trim();
    else if (Array.isArray(body.messages)) {
      const lastUser = body.messages.filter(m => m && m.role === 'user' && typeof m.content === 'string').pop();
      if (lastUser) userText = lastUser.content.trim();
    }
    userText = userText.slice(0, 600);
    if (!userText) return send(res, 400, { error: '消息不能为空' });

    // ---- 知识库检索：只把相关的几段资料拼进提示词，不再整份倒给模型 ----
    let kbCtx = { block: '', hits: 0 };
    try { kbCtx = KB.context(userText, 6); } catch (e) { console.warn('[kb] 检索失败：' + e.message); }

    // ---- 记忆：读档、记到访、把这句话写进流水 ----
    let ud = {};
    try { ud = MEM.touch(USERS, uid); } catch (e) { ud = MEM.loadProfile(USERS, uid); }
    const past = MEM.recentTurns(USERS, uid, MEM.CTX_TURNS);
    try { MEM.appendTurn(USERS, uid, 'user', userText); } catch (e) {}
    ud.turns = (ud.turns || 0) + 1;

    // 上下文 = 历史 + 这一句（历史里已含更早的 user 消息，避免重复最后一句）
    const hist = past.filter(m => m.content !== userText).slice(-MEM.CTX_TURNS);
    const messages = [{ role: 'system', content: persona(ud, kbCtx.block) }]
      .concat(hist.length ? hist : [{ role: 'user', content: '你好' }].slice(0, 0))
      .concat([{ role: 'user', content: userText }]);

    let up;
    try {
      up = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DS_KEY },
        body: JSON.stringify({ model: DS_MODEL, stream: true, max_tokens: 500, temperature: 0.75, messages }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (e) { return send(res, 502, { error: '分身这会儿没响应，稍后再试。' }); }
    if (!up.ok || !up.body) return send(res, 502, { error: '分身这会儿没响应，稍后再试。' });
    chatCount(clientIp(req));
    // 首帧先把 uid 告诉前端，让它存下来（刷新后认得出同一个人）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-UID': uid,
      ...(issued ? { 'Set-Cookie': 'tid=' + uid + '; Path=/; Max-Age=31536000; SameSite=Lax' } : {}),
    });
    res.write('data: ' + JSON.stringify({ uid, ...(issued ? { first: true } : {}) }) + '\n\n');
    const dec = new TextDecoder(); let buf = '', reply = '', pending = '';
    // 流式输出留 160 字尾巴再发：电话、邮箱这类跨分片的片段不会被切开发出去，出口再过一遍脱敏
    const LAG = 160;
    const flush = final => {
      const cut = final ? pending.length : pending.length - LAG;
      if (cut <= 0) return;
      const out = KB.redact(pending.slice(0, cut));
      pending = pending.slice(cut);
      if (!out) return;
      reply += out;
      res.write('data: ' + JSON.stringify({ content: out }) + '\n\n');
    };
    try {
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const t = JSON.parse(data).choices[0].delta.content;
            if (t) { pending += t; flush(false); }
          } catch (e) {}
        }
      }
    } catch (e) {}
    flush(true);
    res.write('data: [DONE]\n\n'); res.end();

    // ---- 收尾：记回复、提炼事实（异步，不阻塞用户）----
    try {
      if (reply) MEM.appendTurn(USERS, uid, 'assistant', reply);
      MEM.trimLog(USERS, uid);
      // 重新读档再存，避免覆盖上一轮异步提炼刚写入的 facts
      const cur0 = MEM.loadProfile(USERS, uid);
      cur0.visits = ud.visits; cur0.turns = ud.turns; cur0.lastSeen = new Date().toISOString();
      MEM.saveProfile(USERS, uid, cur0);
    } catch (e) {}
    if (ud.turns % MEM.EXTRACT_EVERY === 0) {
      // 用最近 12 条流水做一次提炼，失败静默
      (async () => {
        try {
          const recent = MEM.recentTurns(USERS, uid, 12);
          if (recent.length < 4) return;
          const got = await EXT.extractFacts({ url: DS_URL, key: DS_KEY, model: DS_MODEL, turns: recent });
          if (!got.length) return;
          const cur = MEM.loadProfile(USERS, uid);
          cur.facts = MEM.mergeFacts(cur.facts, got);
          MEM.saveProfile(USERS, uid, cur);
        } catch (e) {}
      })();
    }
    return;
  }
  // 拉回这个人的对话历史（刷新页面后前端用它恢复）
  if (url === '/api/chat/history' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const uid = String(q.get('uid') || '');
    if (!MEM.uidOk(uid) || !fs.existsSync(MEM.paths(USERS, uid).profile)) {
      return send(res, 200, { uid: '', messages: [], visits: 0 });
    }
    const n = Math.max(1, Math.min(40, parseInt(q.get('n'), 10) || 20));
    const ud = MEM.loadProfile(USERS, uid);
    const msgs = MEM.recentTurns(USERS, uid, n).map(m => ({ role: m.role, content: m.content }));
    return send(res, 200, {
      uid, messages: msgs, visits: ud.visits || 0,
      lastSeen: ud.lastSeen || '', facts: (ud.facts || []).length,
    });
  }
  // 忘掉我：清掉这个 uid 的全部记忆（给访客的退出权利，也方便自己测）
  if (url === '/api/chat/reset' && req.method === 'POST') {
    let o = {};
    try { o = JSON.parse(await readBody(req, 2000)); } catch (e) {}
    const uid = String(o.uid || '');
    if (!MEM.uidOk(uid)) return send(res, 400, { error: 'uid 不对' });
    for (const k of ['profile', 'log', 'meta', 'chat']) {
      const f = MEM.paths(USERS, uid)[k];
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
    return send(res, 200, { ok: true }, 'application/json; charset=utf-8');
  }
  // ---- 后台：访客对话记录 ----
  if (url === '/api/admin/chats' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    const list = MEM.listUsers(USERS), today = new Date().toISOString().slice(0, 10);
    return send(res, 200, { visitors: list.length, messages: list.reduce((s, x) => s + x.turns, 0), activeToday: list.filter(x => String(x.lastSeen).slice(0, 10) === today).length, list });
  }
  const chatM = url.match(/^\/api\/admin\/chats\/([a-f0-9]{24,48})$/);
  if (chatM && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    const d = MEM.loadProfile(USERS, chatM[1]);
    return send(res, 200, { uid: chatM[1], firstSeen: d.firstSeen || '', lastSeen: d.lastSeen || '', visits: d.visits || 0, messages: MEM.readChat(USERS, chatM[1]) });
  }
  // ---- 知识库：后台只读查看 + 命令行写入 ----
  if (url === '/api/admin/kb' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    return send(res, 200, { stats: KB.stats(), docs: KB.list(), quarantine: KB.quarantined().length });
  }
  if (url === '/api/admin/kb/search' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    const q = new URL(req.url, 'http://x').searchParams;
    const query = String(q.get('q') || '').slice(0, 200);
    const k = Math.max(1, Math.min(20, parseInt(q.get('k'), 10) || 6));
    if (!query.trim()) return send(res, 400, { error: '请给出 q' });
    const t0 = Date.now();
    return send(res, 200, { query, ms: Date.now() - t0, hits: KB.search(query, k) });
  }
  if (url === '/api/admin/kb/quarantine' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    return send(res, 200, { list: KB.quarantined().slice(-100) });
  }
  if (url === '/api/kb/ingest' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    let o;
    try { o = JSON.parse(await readBody(req, 9 * 1024 * 1024)); } catch (e) { return send(res, 400, { error: '内容太大或不是合法 JSON' }); }
    const items = Array.isArray(o && o.items) ? o.items : [o];
    if (items.length > 2000) return send(res, 413, { error: '单次最多 2000 篇，请分批' });
    let results;
    try { results = KB.addMany(items); } catch (e) { return send(res, 500, { error: '入库失败：' + e.message }); }
    return send(res, results.some(x => x.ok) ? 200 : 422, { results });
  }
  const kbDel = url.match(/^\/api\/kb\/doc\/([a-z0-9一-龥-]{1,64})$/);
  if (kbDel && req.method === 'DELETE') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    return send(res, 200, KB.remove(kbDel[1]));
  }
  if (url === '/api/kb/compact' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    return send(res, 200, { ok: true, stats: KB.compact() });
  }
  // ---- 评论：访客提交先进待审，审核通过才对外显示 ----
  const CF = path.join(ROOT, 'data', 'comments.json');
  const loadC = () => { try { const a = JSON.parse(fs.readFileSync(CF, 'utf-8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const saveC = a => { fs.mkdirSync(path.dirname(CF), { recursive: true }); fs.writeFileSync(CF + '.tmp', JSON.stringify(a, null, 2)); fs.renameSync(CF + '.tmp', CF); };
  const cmP = url.match(/^\/api\/posts\/([a-z0-9][a-z0-9-]{0,63})\/comments$/);
  if (cmP) {
    const pid = cmP[1];
    let post = null; try { post = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'posts', pid + '.json'), 'utf-8')); } catch (e) {}
    if (!post || post.published === false) return send(res, 404, { error: '文章不存在' });
    if (req.method === 'GET') return send(res, 200, loadC().filter(c => c.postId === pid && c.status === 'approved').sort((a, b) => String(a.at).localeCompare(String(b.at))).map(c => ({ id: c.id, name: c.name, content: c.content, at: c.at })));
    if (req.method === 'POST') {
      const ip = clientIp(req), now = Date.now(), h = (commentHits.get(ip) || []).filter(t => now - t < 3600000);
      if (h.length >= 5) return send(res, 429, { error: '留言太频繁了，请稍后再试。' });
      let o; try { o = JSON.parse(await readBody(req, 5000)); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }
      if (o && o.website) return send(res, 200, { ok: true, pending: true }); // 蜜罐字段，真人不会填
      const name = String((o && o.name) || '').trim().slice(0, 30), content = String((o && o.content) || '').trim().slice(0, 1000);
      if (!name || content.length < 2) return send(res, 400, { error: '请填写昵称和留言内容' });
      const all = loadC();
      if (all.filter(c => c.status === 'pending').length >= 200) return send(res, 503, { error: '待审留言太多，请稍后再来。' });
      all.push({ id: crypto.randomBytes(6).toString('hex'), postId: pid, postTitle: String(post.title || ''), name, content, status: 'pending', at: new Date().toISOString() });
      saveC(all); h.push(now); commentHits.set(ip, h); if (commentHits.size > 5000) commentHits.clear();
      return send(res, 200, { ok: true, pending: true });
    }
  }
  if (url === '/api/admin/comments' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    const st = new URL(req.url, 'http://x').searchParams.get('status') || 'pending', all = loadC();
    return send(res, 200, { pending: all.filter(c => c.status === 'pending').length, list: all.filter(c => st === 'all' || c.status === st).sort((a, b) => String(b.at).localeCompare(String(a.at))) });
  }
  const cmA = url.match(/^\/api\/admin\/comments\/([a-f0-9]{12})$/);
  if (cmA && (req.method === 'POST' || req.method === 'DELETE')) {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    const all = loadC(), i = all.findIndex(c => c.id === cmA[1]);
    if (i < 0) return send(res, 404, { error: '留言不存在' });
    if (req.method === 'DELETE') all.splice(i, 1);
    else {
      let o = {}; try { o = JSON.parse(await readBody(req, 1000)); } catch (e) {}
      if (!['approved', 'rejected', 'pending'].includes(o.status)) return send(res, 400, { error: 'status 只能是 approved、rejected、pending' });
      all[i].status = o.status;
    }
    saveC(all);
    return send(res, 200, { ok: true });
  }
  if (url === '/api/upload' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    let o;
    try { o = JSON.parse(await readBody(req, 14000000)); } catch (e) { return send(res, 400, { error: '图片太大或格式不对（上限约 10MB）' }); }
    const ext = String(o.name || '').toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
    if (!ext || typeof o.data !== 'string') return send(res, 400, { error: '只支持 png、jpg、gif、webp 图片' });
    const buf = Buffer.from(o.data, 'base64');
    if (!buf.length || buf.length > 10485760) return send(res, 400, { error: '图片不能超过 10MB' });
    const dir = path.join(PUB, 'posts-img', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const fn = Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '.' + ext[1];
    fs.writeFileSync(path.join(dir, fn), buf);
    return send(res, 200, { url: '/posts-img/uploads/' + fn });
  }
  if (url === '/api/site' && req.method === 'GET') {
    return send(res, 200, fs.readFileSync(DATA, 'utf-8'));
  }
  if (url === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req), ua = req.headers['user-agent'] || '';
    let pw = '';
    try { const b = JSON.parse(await readBody(req, 2000)); pw = b && typeof b.password === 'string' ? b.password : ''; } catch (e) {} // 格式不对也按一次失败记
    const r = AUTH.login(pw, ip, ua); // 锁定判断、失败计数、写日志、签发带有效期的 token 都在 lib/auth.js 里
    if (r.ok) return send(res, 200, { token: r.token, expiresAt: r.expiresAt, expiresIn: Math.floor((r.expiresAt - Date.now()) / 1000) });
    if (r.locked) return send(res, 429, { error: '尝试次数过多，该 IP 已被临时锁定，请 ' + Math.ceil(r.retryAfterSec / 60) + ' 分钟后再试' }, null, { 'Retry-After': String(r.retryAfterSec) });
    return send(res, 401, { error: '密码不对' + (r.remaining <= 2 ? '，再错 ' + r.remaining + ' 次将临时锁定' : '') });
  }
  if (url === '/api/logout' && req.method === 'POST') {
    AUTH.logout(req.headers['x-token'], clientIp(req), req.headers['user-agent'] || '');
    return send(res, 200, { ok: true });
  }
  if (url === '/api/site' && req.method === 'PUT') {
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    let obj;
    try { obj = JSON.parse(await readBody(req, 300000)); } catch (e) { return send(res, 400, { error: '内容不是合法 JSON' }); }
    if (!obj || typeof obj !== 'object' || !obj.profile || !Array.isArray(obj.projects)) return send(res, 400, { error: '缺少 profile 或 projects' });
    fs.mkdirSync(path.join(ROOT, 'data', 'backup'), { recursive: true });
    fs.copyFileSync(DATA, path.join(ROOT, 'data', 'backup', 'site-' + Date.now() + '.json'));
    const old = fs.readdirSync(path.join(ROOT, 'data', 'backup')).sort().slice(0, -30);
    old.forEach(f => fs.unlinkSync(path.join(ROOT, 'data', 'backup', f)));
    let disk = {}; try { disk = JSON.parse(fs.readFileSync(DATA, 'utf-8')); } catch (e) {} // 磁盘旧数据作为底，缺失字段原样保留
    const merged = mergeSite(disk, obj);
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(merged, null, 2));
    fs.renameSync(DATA + '.tmp', DATA);
    return send(res, 200, { ok: true });
  }
  const POSTS = path.join(ROOT, 'data', 'posts');
  const idOk = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '');
  const readPost = id => JSON.parse(fs.readFileSync(path.join(POSTS, id + '.json'), 'utf-8'));
  const TAGS = ['original', 'paper', 'news'], tagOf = p => TAGS.includes(p.tag) ? p.tag : 'original'; // 缺省或未知标签一律视为原创
  const listPosts = () => { // 读取全部文章（含草稿），列表和标签计数共用
    fs.mkdirSync(POSTS, { recursive: true });
    return fs.readdirSync(POSTS).filter(f => f.endsWith('.json')).map(f => {
      try { const p = readPost(f.slice(0, -5)); return { id: p.id, title: p.title, date: p.date, summary: p.summary, tag: tagOf(p), createdAt: p.createdAt || '', published: p.published !== false }; } catch (e) { return null; }
    }).filter(Boolean);
  };
  if (url === '/api/posts' && req.method === 'GET') {
    const tag = new URL(req.url, 'http://x').searchParams.get('tag') || 'all'; // url 已去掉 query，这里单独解析
    if (tag !== 'all' && !TAGS.includes(tag)) return send(res, 400, { error: '标签只能是 all、original、paper、news' });
    const list = listPosts().filter(p => p.published || authed(req)).filter(p => tag === 'all' || p.tag === tag).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return send(res, 200, list);
  }
  if (url === '/api/tags' && req.method === 'GET') { // 各标签计数，只统计已发布
    const c = { original: 0, paper: 0, news: 0 };
    listPosts().filter(p => p.published).forEach(p => c[p.tag]++);
    return send(res, 200, c);
  }
  const m = url.match(/^\/api\/posts\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!idOk(id)) return send(res, 400, { error: '文章 ID 只能用小写字母、数字和短横线' });
    const file = path.join(POSTS, id + '.json');
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return send(res, 404, { error: '文章不存在' });
      const p = readPost(id);
      if (p.published === false && !authed(req)) return send(res, 404, { error: '文章不存在' });
      return send(res, 200, p);
    }
    if (!authed(req)) return send(res, 401, { error: '未登录或登录已过期' });
    if (req.method === 'PUT') {
      let o;
      try { o = JSON.parse(await readBody(req, 600000)); } catch (e) { return send(res, 400, { error: '内容不是合法 JSON' }); }
      if (!o || !String(o.title || '').trim()) return send(res, 400, { error: '标题不能为空' });
      fs.mkdirSync(POSTS, { recursive: true });
      const prev = (() => { try { return readPost(id); } catch (e) { return {}; } })(); // 原文件（不存在或损坏则为空），用于保留 tag/link/source/createdAt
      if (o.tag != null && !TAGS.includes(o.tag)) return send(res, 400, { error: '标签只能是 original、paper、news' }); // 传了非法值不静默降级
      const post = { id, title: String(o.title).trim(), date: String(o.date || '').trim(), tag: o.tag != null ? o.tag : tagOf(prev), summary: String(o.summary || '').trim(), body: String(o.body || '') }; // tag 缺失则沿用原文件，新建默认 original
      const isNew = !fs.existsSync(file), str = v => (typeof v === 'string' ? v.trim() : ''), okTime = v => typeof v === 'string' && v && !isNaN(Date.parse(v)); // 非字符串的 link/source 当没传
      const link = str(o.link) || str(prev.link), source = str(o.source) || str(prev.source); // 请求体优先，其次原文件
      if (link) post.link = link;
      if (source) post.source = source;
      post.published = o.published !== false;
      const createdAt = prev.createdAt || (okTime(o.createdAt) ? o.createdAt : (isNew ? new Date().toISOString() : '')); // 已有文章保留原值不刷新；新建取请求体，没传则当前时间
      if (createdAt) post.createdAt = createdAt;
      fs.writeFileSync(file + '.tmp', JSON.stringify(post, null, 2));
      fs.renameSync(file + '.tmp', file);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/api/')) return await api(req, res, url);
    if (url === '/') url = '/index.html';
    if (url === '/admin') url = '/admin.html';
    if (url === '/admin/kb') url = '/kb.html';
    if (url === '/posts') { res.writeHead(301, { Location: '/blog' }); return res.end(); }
    if (url === '/blog') url = '/blog.html';
    if (url === '/courses') url = '/courses.html';
    if (url === '/k12') url = '/k12.html';
    if (url === '/chat') url = '/chat.html';
    if (/^\/post\/[a-z0-9-]+$/.test(url)) url = '/post.html';
    const file = path.normalize(path.join(PUB, url));
    if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: '服务器出错' });
  }
}).listen(PORT, () => console.log('http://localhost:' + PORT));

// 知识库空的时候，用网站已公开的内容自动灌一次种子；已有内容就跳过，不覆盖命令行写入的东西
setImmediate(() => {
  try {
    if (KB.stats().docs > 0) return;
    const docs = require('./lib/kb/seed').fromSite(ROOT);
    let n = 0; for (const d of docs) { const r = KB.add(d); if (r.ok) n++; }
    console.log('[kb] 空库初始化：灌入 ' + n + ' 篇网站内容');
  } catch (e) { console.warn('[kb] 初始化失败：' + e.message); }
});
