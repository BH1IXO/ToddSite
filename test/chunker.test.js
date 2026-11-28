// 流式分块测试：node test/chunker.test.js
// 单元：按句/短语切、不劈开英文单词、联系方式跨 token 也能被脱敏。
// 端到端：起一个假的上游（按 token 吐字的 SSE），真实 server.js 转发，检查前端收到的每一块都是整句或整短语。
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const CH = require('../lib/chunker');
const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

// 模拟模型按 token 吐字：中文一两个字一块，英文单词拆成子词
const tokenize = s => { const out = []; const re = /[A-Za-z]{1,3}|[0-9]|[\s\S]{1,2}/g; let m; while ((m = re.exec(s))) out.push(m[0]); return out; };
const run = (text, opts) => {
  const got = []; const c = CH.create(Object.assign({ emit: x => got.push(x) }, opts));
  for (const t of tokenize(text)) c.push(t);
  c.end(); return got;
};
const SAMPLE = '做过云平台和区块链底层，后来自己搞了 Zen7 Labs。具体两个：MoltsPay，给 AI Agent 用的区块链支付基础设施，有 Python 版和 AutoGPT 插件；还有 Zen7 Payment Agent，去中心化支付 Agent 的第一个实现。现在主攻 Web3 和 AI 交叉这块。你是想了解技术细节，还是想聊落地场景？';
const wordsOf = s => s.match(/[A-Za-z0-9]+/g) || [];

{
  const got = run(SAMPLE);
  ok(got.join('') === SAMPLE, '拼回去应与原文一致');
  ok(got.length >= 3 && got.length <= 8, '应切成几句，不是几十个碎片：' + got.length + ' ' + JSON.stringify(got));
  for (const g of got.slice(0, -1)) ok(/[。！？；，、]$/.test(g), '每块应在标点处结束：' + JSON.stringify(g));
  const whole = new Set(wordsOf(SAMPLE));
  for (const g of got) for (const w of wordsOf(g)) ok(whole.has(w), '英文/数字词不应被劈开：' + w + ' in ' + JSON.stringify(g));
  ok(got.some(g => g.includes('Web3')), 'Web3 应完整出现在一块里');
}
{
  // 收尾引号、括号跟前一句一起走
  const got = run('他说“这事能成。”然后就走了，我也没再追问下去。还有别的吗？');
  ok(got[0].endsWith('。”'), '收尾引号应跟着句号：' + JSON.stringify(got));
}
{
  // 小数点、版本号不算句末
  const got = run('DeepSeek V3.5 的价格比上一代低很多，大概是 0.5 元每百万 token 的水平，我觉得值得试试。');
  for (const g of got) ok(!/^\d/.test(g), '不应在小数点处切开：' + JSON.stringify(got));
}
{
  // 联系方式被 token 切成几段，出口仍要整段脱敏
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-priv-'));
  const S = require('../lib/kb/sanitize').create(priv);
  const text = '可以打我电话 13800138000 或者发邮件到 todd@example.com，微信：todd_lab 也行。';
  const got = run(text, { redact: S.redact });
  const all = got.join('');
  for (const bad of ['13800138000', 'todd@example.com', 'todd_lab']) ok(!all.includes(bad), '不应漏出：' + bad + ' ← ' + JSON.stringify(got));
  // 没有标点的长串：硬切也不能劈开英文单词，也不能漏出联系方式
  const long = '这一段故意不写标点'.repeat(12) + ' 电话13800138000 ' + 'Kubernetes Operator Framework '.repeat(4) + '结尾';
  const g2 = run(long, { redact: S.redact });
  ok(g2.length > 1, '长串应被硬切');
  ok(!g2.join('').includes('13800138000'), '硬切不应漏出电话');
  const allowed = new Set(['Kubernetes', 'Operator', 'Framework']);
  for (const g of g2) for (const w of wordsOf(g)) ok(allowed.has(w), '硬切不应劈开单词：' + w + ' ← ' + JSON.stringify(g2));
}

// ---------- 端到端：假上游 + 真实 server.js ----------
(async () => {
  const UP = await freePort(), PORT = await freePort();
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toks = tokenize(SAMPLE); let i = 0;
    const tick = () => {
      if (i < toks.length) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: toks[i++] } }] }) + '\n\n'); setTimeout(tick, 2); }
      else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    tick();
  }).listen(UP);
  const KBDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-kb-'));
  // 聊天会在 data/users 里新建一个测试访客档案，测完按快照差集清掉
  const UDIR = path.join(ROOT, 'data', 'users'), ls = () => { try { return fs.readdirSync(UDIR); } catch (e) { return []; } };
  const before = new Set(ls());
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { ADMIN_PASSWORD: crypto.randomBytes(16).toString('hex'), PORT: String(PORT), KB_DIR: KBDIR, DEEPSEEK_API_KEY: 'test', DEEPSEEK_API_URL: 'http://127.0.0.1:' + UP + '/chat/completions' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  try {
    for (let i = 0; i < 80 && !out.includes('localhost:' + PORT); i++) await sleep(100);
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '你以前做过什么区块链项目' }) });
    ok(r.status === 200, '聊天接口 200');
    const body = await r.text();
    const parts = body.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))).filter(o => o.content).map(o => o.content);
    ok(parts.join('') === SAMPLE, '前端拼起来应是完整回答');
    ok(parts.length >= 3 && parts.length <= 8, '端到端应按句发出：' + parts.length + ' ' + JSON.stringify(parts));
    for (const p of parts.slice(0, -1)) ok(/[。！？；，、]$/.test(p), '端到端每块在标点处结束：' + JSON.stringify(p));
    console.log('流式分块测试全部通过（' + n + ' 项断言）');
  } finally {
    srv.kill('SIGKILL'); up.close();
    for (const f of ls()) if (!before.has(f)) fs.rmSync(path.join(UDIR, f), { recursive: true, force: true });
  }
})().catch(e => { console.error('❌ 流式分块测试失败：' + (e && e.stack || e)); process.exit(1); });
