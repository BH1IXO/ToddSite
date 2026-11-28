// 知识库测试：node test/kb.test.js
// 覆盖清洗隔离、切块、检索、删除与增量、以及通过真实 server.js 的端到端隐私检查。
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
let n = 0; const ok = (cond, msg) => { assert(cond, msg); n++; };

// ---------- 清洗 ----------
{
  const priv = tmp('kb-priv-');
  fs.writeFileSync(path.join(priv, 'blocklist.txt'), '星河银行上海分行\n');
  const S = require('../lib/kb/sanitize').create(priv);
  const raw = '邮箱 todd@example.com，手机 13800138000，微信：todd_lab，身份证 110101199003071234。\n\n' +
    '星河银行上海分行是我们的客户，合同金额八百万。\n\n' +
    '我爸爸住院了，这事别外传。\n\n' +
    '张总这个人很不靠谱，只会甩锅。\n\n' +
    '上海财经大学是我的母校，我在那里带研究生。\n\n' +
    'API key: sk-abcdefghijklmnopqrstuvwx';
  const c = S.clean(raw, { trust: 'chat' });
  for (const secret of ['todd@example.com', '13800138000', 'todd_lab', '110101199003071234', '星河银行上海分行', 'sk-abcdefghijklmnopqrstuvwx']) {
    ok(!c.text.includes(secret), '清洗后不应出现：' + secret);
  }
  ok(c.hits['邮箱'] === 1 && c.hits['手机'] === 1 && c.hits['证件号'] === 1, '联系方式命中计数：' + JSON.stringify(c.hits));
  ok(c.text.includes('[邮箱已移除]') && c.text.includes('[电话已移除]'), '联系方式应留占位标记');
  const reasons = c.quarantined.flatMap(q => q.reasons);
  ok(reasons.includes('未公开商业信息'), '合同金额应隔离：' + reasons.join(','));
  ok(reasons.includes('私事'), '家事应隔离：' + reasons.join(','));
  ok(reasons.includes('评价他人'), '负面评价应隔离：' + reasons.join(','));
  ok(c.text.includes('上海财经大学'), '公开的母校信息应保留');
  // 公开来源只抹联系方式，不做私事/评价/商业判断；但客户名单照样生效
  const pub = S.clean(raw, { trust: 'public' });
  ok(pub.quarantined.length === 1 && pub.quarantined[0].reasons.includes('密钥'), '公开来源只隔离密钥段：' + JSON.stringify(pub.quarantined.map(x => x.reasons)));
  ok(pub.text.includes('合同金额八百万') && pub.text.includes('我爸爸住院了'), '公开来源不做私事/商业判断');
  ok(!pub.text.includes('星河银行上海分行') && pub.text.includes('某客户'), '公开来源也要按名单抹客户名');
  ok(!pub.text.includes('todd@example.com'), '公开来源也要抹邮箱');
  // 手动标记
  const marked = S.clean('这段是内部讨论\n\n[私密] 别发出去\n', { trust: 'public' });
  ok(marked.quarantined.length === 1 && marked.quarantined[0].reasons.includes('标记为私密'), '手动 [私密] 标记应隔离');
  const courseTalk = S.clean('必备技能：Token 经济：协议设计、密码学、经济学、安全。', { trust: 'public' });
  ok(courseTalk.quarantined.length === 0, '公开课程里的 Token 经济不应误判为密钥');
  // 出入口复用的脱敏
  ok(!S.redact('联系我 13900139000').includes('13900139000'), '响应脱敏应抹手机号');
}

// ---------- 切块 ----------
{
  const { chunk } = require('../lib/kb/store');
  const long = Array.from({ length: 60 }, (_, i) => '第' + i + '段：' + '这是一句用来凑长度的中文内容。'.repeat(6)).join('\n\n');
  const cs = chunk(long, 700);
  ok(cs.length > 3, '长文应切成多块，实际 ' + cs.length);
  ok(cs.every(c => c.length <= 700 + 50), '每块长度受控');
  const tiny = chunk('短句。', 700);
  ok(tiny.length === 1 && tiny[0] === '短句。', '短文本不切');
  const empty = chunk('   \n\n  ', 700);
  ok(empty.length === 0, '空白不产生块');
}

// ---------- 存储与检索 ----------
{
  const dir = tmp('kb-store-');
  const KB = require('../lib/kb').open(dir);
  const r1 = KB.add({ id: 'a', title: 'Web3 产品经理必修课', trust: 'public', text: '我写过一本书叫《Web3 产品经理必修课》，讲区块链产品怎么从零设计。' });
  ok(r1.ok && r1.chunks >= 1, '入库成功');
  KB.add({ id: 'b', title: 'Vigilath 平台', trust: 'public', text: 'Vigilath 是 AI 搜索可见性平台，检测品牌在 ChatGPT 和 DeepSeek 里的呈现。' });
  KB.add({ id: 'c', title: '教学经历', trust: 'public', text: '我在上海财经大学做兼职硕士生导师，带产品方向的研究生。' });
  ok(KB.search('区块链产品设计', 3)[0].doc === 'a', '检索应命中 Web3 书');
  ok(KB.search('DeepSeek 品牌呈现', 3)[0].doc === 'b', '检索应命中 Vigilath');
  ok(KB.search('硕士生导师', 3)[0].doc === 'c', '检索应命中教学经历');
  ok(KB.search('完全不相干的火星土壤', 3).length === 0 || KB.search('完全不相干的火星土壤', 3)[0].score < 1, '无关查询不返回高相关结果');
  // 联系方式即便写进正文，检索出口也要抹掉
  KB.add({ id: 'd', title: '联系方式测试', trust: 'chat', text: '想联系我可以打 13700137000 或者发邮件到 me@example.com。' });
  const hit = KB.search('联系 邮件', 3).find(h => h.doc === 'd');
  ok(hit && !hit.text.includes('13700137000') && !hit.text.includes('me@example.com'), '检索结果不应含联系方式');
  // 删除后不再返回
  KB.remove('b');
  ok(!KB.search('Vigilath', 3).some(h => h.doc === 'b'), '删除后不应命中');
  ok(!KB.list().some(x => x.id === 'b'), '删除后列表不应出现');
  // 增量写入
  KB.add({ id: 'e', title: 'FDE 现场改造', trust: 'public', text: 'FDE 是进到客户现场做 AI 改造的方式。' });
  ok(KB.search('FDE 现场改造', 3)[0].doc === 'e', '增量写入后应立即可检索');
  // 同一 id 覆盖：旧内容作废，不和新内容同时命中
  KB.add({ id: 'a', title: 'Web3 产品经理必修课（改版）', trust: 'public', text: '改版后只保留课程大纲：意图工程、上下文、组合工作流。' });
  ok(!KB.search('区块链', 3).some(h => h.text.includes('从零设计')), '覆盖后旧内容不应命中');
  ok(KB.search('课程大纲 意图工程', 3).some(h => h.doc === 'a'), '覆盖后新内容应命中');
  // 合并整理后仍正确
  const st = KB.compact();
  ok(st.docs === 4 && st.chunks >= 4, '整理后文档数正确：' + JSON.stringify(st));
  ok(KB.search('硕士生导师', 3)[0].doc === 'c', '整理后检索仍正确');
  // 标题里也不能带隐私
  KB.add({ id: 't', title: '联系人 13800138000 的档案', trust: 'chat', text: '正文是正常的工作经历。' });
  ok(!KB.list().find(x => x.id === 't').title.includes('13800138000'), '标题也要脱敏');
  ok(!KB.search('联系人档案', 3).some(h => h.title.includes('13800138000')), '检索结果标题也要脱敏');
  // 整篇私密内容：隔离，不入库
  const q = KB.add({ id: 'f', title: '私事', trust: 'chat', text: '我爸爸住院了，别外传。' });
  ok(q.ok === false && q.quarantined && q.reasons.includes('私事'), '整篇私密应被隔离');
  ok(!KB.has('f'), '被隔离的文档不应入库');
  ok(KB.quarantined().length >= 1, '隔离区留底');
  // 老的段文件没有 .map：追加新内容时要重建偏移表，旧块仍能按正确位置读出来
  {
    const legacy = tmp('kb-legacy-');
    const LB = require('../lib/kb/store').open(legacy);
    LB.addDoc({ id: 'old', title: '旧文档', text: '旧内容里的关键词是蓝鲸协议。' });
    fs.rmSync(path.join(legacy, 'docs', 'seg-1.map'));
    LB.addDoc({ id: 'new', title: '新文档', text: '新内容里的关键词是赤狐协议。' });
    const a = LB.search('蓝鲸协议', 2)[0], b = LB.search('赤狐协议', 2)[0];
    ok(a && a.text.includes('蓝鲸协议'), '重建偏移表后旧块可读');
    ok(b && b.text.includes('赤狐协议'), '重建偏移表后新块可读');
  }
  // 超大单篇拒绝
  const big = KB.add({ id: 'g', title: '太大', trust: 'chat', text: 'x'.repeat(8 * 1024 * 1024 + 1) });
  ok(big.ok === false && /8MB/.test(big.error), '超过 8MB 应拒绝');
}

// ---------- 端到端：真实进程 + HTTP ----------
(async () => {
  const KBDIR = tmp('kb-e2e-');
  fs.mkdirSync(path.join(KBDIR, 'private'), { recursive: true });
  fs.writeFileSync(path.join(KBDIR, 'private', 'blocklist.txt'), '星河银行上海分行\n');
  const PW = crypto.randomBytes(16).toString('hex'), PORT = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { ADMIN_PASSWORD: PW, PORT: String(PORT), KB_DIR: KBDIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  const B = 'http://127.0.0.1:' + PORT;
  const req = async (method, p, { body, token } = {}) => {
    const r = await fetch(B + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'X-Token': token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, j, text };
  };
  try {
    for (let i = 0; i < 80 && !out.includes('localhost:' + PORT); i++) await sleep(100);
    ok(out.includes('localhost:' + PORT), '服务应启动：' + out.slice(0, 300));
    await sleep(300); // 等空库种子灌完
    const login = await req('POST', '/api/login', { body: { password: PW } });
    ok(login.status === 200 && login.j.token, '登录成功');
    const token = login.j.token;
    // 未登录不能写
    const denied = await req('POST', '/api/kb/ingest', { body: { title: 'x', text: 'y' } });
    ok(denied.status === 401, '未登录写入应 401');
    // 写入一篇混合内容
    const ing = await req('POST', '/api/kb/ingest', { token, body: { items: [{
      id: 'e2e-doc', title: '端到端档案', kind: '履历', trust: 'chat',
      text: '我在上海财经大学做兼职硕士生导师，带产品方向的研究生。\n\n电话 13800138000，邮箱 e2e@example.com，微信：e2e_lab。\n\n星河银行上海分行是客户，合同金额八百万，不要外传。\n\n我爸爸住院了，别告诉别人。',
    }] } });
    ok(ing.status === 200 && ing.j.results[0].ok, '入库成功：' + ing.text);
    ok(ing.j.results[0].quarantinedParas === 2, '应隔离两段：' + JSON.stringify(ing.j.results[0]));
    ok(ing.j.results[0].redactions['手机'] === 1 && ing.j.results[0].redactions['邮箱'] === 1, '清洗统计正确：' + JSON.stringify(ing.j.results[0].redactions));
    ok(!JSON.stringify(ing.j.results[0]).includes('13800138000'), '响应里不出现手机号原文');
    // 管理端检索：命中公开部分，隐私部分不出现
    const s = await req('GET', '/api/admin/kb/search?q=' + encodeURIComponent('硕士生导师 上海财经大学'), { token });
    ok(s.status === 200 && s.j.hits.length > 0, '检索有结果');
    const all = JSON.stringify(s.j.hits);
    for (const bad of ['13800138000', 'e2e@example.com', 'e2e_lab', '星河银行上海分行', '八百万', '住院']) ok(!all.includes(bad), '检索响应不应出现：' + bad);
    // 未登录不能看管理端
    ok((await req('GET', '/api/admin/kb')).status === 401, '管理端需要登录');
    const list = await req('GET', '/api/admin/kb', { token });
    ok(list.status === 200 && list.j.docs.some(d => d.id === 'e2e-doc'), '只读列表包含新文档');
    const quar = await req('GET', '/api/admin/kb/quarantine', { token });
    ok(quar.status === 200 && quar.j.list.some(x => x.id === 'e2e-doc'), '隔离区留底');
    // 删除
    const del = await req('DELETE', '/api/kb/doc/e2e-doc', { token });
    ok(del.status === 200 && del.j.ok, '删除成功');
    ok(!(await req('GET', '/api/admin/kb', { token })).j.docs.some(d => d.id === 'e2e-doc'), '删除后列表不再出现');
    console.log('知识库测试全部通过（' + n + ' 项断言）');
  } finally {
    srv.kill('SIGKILL');
  }
})().catch(e => { console.error('❌ 知识库测试失败：' + (e && e.stack || e)); process.exit(1); });
