const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('请先设置环境变量 ADMIN_PASSWORD'); process.exit(1); }
const ROOT = __dirname, PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data', 'site.json');
const sessions = new Map(), fails = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function same(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
function authed(req) {
  const t = req.headers['x-token'];
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000;
}


const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const chatHits = new Map();
let siteDay = { d: '', n: 0 };
function clientIp(req) {
  return (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
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
function persona() {
  let d = {}; try { d = JSON.parse(fs.readFileSync(DATA, 'utf-8')); } catch (e) {}
  const p = d.profile || {};
  const areas = (d.workAreas || []).map(a => '- ' + a.title + '：' + a.desc + ((a.items || []).length ? '（项目：' + a.items.map(i => i.name + ' ' + (i.desc || '')).join('；') + '）' : '')).join('\n');
  const course = d.courses ? d.courses.title + '：' + (d.courses.lessons || []).map(l => '第' + l.no + '讲 ' + l.title).join('；') : '';
  const offers = (d.offers || []).map(o => '- ' + o.title + '：' + o.desc + (o.price ? '（' + o.price + '）' : '')).join('\n');
  let posts = '';
  try {
    const dir = path.join(ROOT, 'data', 'posts');
    posts = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))).filter(x => x.published !== false).map(x => '- ' + x.title + '：' + (x.summary || '')).join('\n');
  } catch (e) {}
  return '你是' + (p.name || '刘涛') + '（Todd）的网站分身，在他的个人主页上和访客聊天。用第一人称“我”，语气自然、简短、直接，每次回答尽量不超过 150 字。\n' +
    '只依据下面的资料回答，资料里没有的事就说“这个我还没写在网站上，可以通过下面的联系方式直接问我本人”，不要编造经历、数据、客户或价格。\n' +
    '不透露任何私人信息（住址、证件、银行卡、家人隐私等），不替本人做商务承诺或报价，有合作意向就引导对方留下联系方式。\n' +
    '你是 AI 分身，访客问起时要如实说明。\n\n' +
    '【简介】' + (p.headline || '') + ' ' + (p.intro || '') + '\n' +
    '【工作方向与项目】\n' + areas + '\n' +
    (course ? '【课程】' + course + '\n' : '') +
    (offers ? '【合作方式】\n' + offers + '\n' : '') +
    (posts ? '【文章】\n' + posts + '\n' : '');
}

async function api(req, res, url) {
  if (url === '/api/chat' && req.method === 'POST') {
    if (!DS_KEY) return send(res, 503, { error: '分身暂未开放，请通过下面的联系方式找我。' });
    const tip = chatLimit(clientIp(req));
    if (tip) return send(res, 429, { error: tip });
    let body;
    try { body = JSON.parse(await readBody(req, 20000)); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }
    const hist = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 600) }));
    if (!hist.length || hist[hist.length - 1].role !== 'user') return send(res, 400, { error: '消息不能为空' });
    let up;
    try {
      up = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DS_KEY },
        body: JSON.stringify({ model: DS_MODEL, stream: true, max_tokens: 500, temperature: 0.6, messages: [{ role: 'system', content: persona() }].concat(hist) }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (e) { return send(res, 502, { error: '分身这会儿没响应，稍后再试。' }); }
    if (!up.ok || !up.body) return send(res, 502, { error: '分身这会儿没响应，稍后再试。' });
    chatCount(clientIp(req));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try { const t = JSON.parse(data).choices[0].delta.content; if (t) res.write('data: ' + JSON.stringify({ content: t }) + '\n\n'); } catch (e) {}
        }
      }
    } catch (e) {}
    res.write('data: [DONE]\n\n'); return res.end();
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
    const ip = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
    if (blocked(ip)) return send(res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    let pw = '';
    try { pw = JSON.parse(await readBody(req, 2000)).password || ''; } catch (e) {}
    if (!same(pw, PASS)) {
      const f = fails.get(ip) || { n: 0, t: 0 };
      fails.set(ip, { n: f.n + 1, t: Date.now() });
      return send(res, 401, { error: '密码不对' });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + 12 * 3600 * 1000);
    return send(res, 200, { token });
  }
  if (url === '/api/logout' && req.method === 'POST') {
    sessions.delete(req.headers['x-token']);
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
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(DATA + '.tmp', DATA);
    return send(res, 200, { ok: true });
  }
  const POSTS = path.join(ROOT, 'data', 'posts');
  const idOk = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '');
  const readPost = id => JSON.parse(fs.readFileSync(path.join(POSTS, id + '.json'), 'utf-8'));
  if (url === '/api/posts' && req.method === 'GET') {
    fs.mkdirSync(POSTS, { recursive: true });
    const list = fs.readdirSync(POSTS).filter(f => f.endsWith('.json')).map(f => {
      try { const p = readPost(f.slice(0, -5)); return { id: p.id, title: p.title, date: p.date, summary: p.summary, published: p.published !== false }; } catch (e) { return null; }
    }).filter(Boolean).filter(p => p.published || authed(req)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return send(res, 200, list);
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
      const post = { id, title: String(o.title).trim(), date: String(o.date || '').trim(), summary: String(o.summary || '').trim(), body: String(o.body || ''), published: o.published !== false };
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
    if (url === '/posts') { res.writeHead(301, { Location: '/blog' }); return res.end(); }
    if (url === '/blog') url = '/blog.html';
    if (url === '/courses') url = '/courses.html';
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
