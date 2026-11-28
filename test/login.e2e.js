// 后台登录防护端到端测试：起一个真实的 server.js（随机密码、随机端口、临时日志），走 HTTP 验证。
// 用法：node test/login.e2e.js
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), net = require('net');
const { spawn, spawnSync } = require('child_process');
const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

(async () => {
  // 没有 ADMIN_PASSWORD 必须拒绝启动（不存在默认密码）
  const env0 = Object.assign({}, process.env); delete env0.ADMIN_PASSWORD;
  const r0 = spawnSync(process.execPath, [SERVER], { env: env0, timeout: 10000 });
  assert.notStrictEqual(r0.status, 0, '缺少 ADMIN_PASSWORD 时应退出');

  const PW = crypto.randomBytes(16).toString('hex'), PORT = await freePort();
  const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-e2e-')), 'admin-login.log');
  const srv = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { ADMIN_PASSWORD: PW, PORT: String(PORT), TRUST_PROXY: '1', LOGIN_LOG_FILE: LOG, SESSION_TTL_HOURS: String(3 / 3600) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  const B = 'http://127.0.0.1:' + PORT;
  try {
    for (let i = 0; i < 50 && !out.includes('localhost:' + PORT); i++) await sleep(100);
    const req = async (method, p, { body, ip, token, ua } = {}) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': ua || 'e2e-agent/1.0' };
      if (ip) h['X-Forwarded-For'] = ip;
      if (token) h['X-Token'] = token;
      const r = await fetch(B + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) };
    };
    const login = (password, ip, ua) => req('POST', '/api/login', { body: { password }, ip, ua });

    // 1) 同一 IP 连错 5 次 → 锁定；锁定期间正确密码也进不来
    const A = '203.0.113.7';
    for (let i = 1; i <= 4; i++) assert.strictEqual((await login('wrong' + i, A)).status, 401);
    const lk = await login('wrong5', A);
    assert.strictEqual(lk.status, 429); assert(+lk.headers.get('retry-after') >= 890, 'Retry-After');
    assert.strictEqual((await login(PW, A)).status, 429, '锁定期间正确密码也应拒绝');
    // 2) 伪造最左边的 X-Forwarded-For 绕不过锁定（反代追加的最右值才算数）
    assert.strictEqual((await login(PW, '198.51.100.' + 9 + ', ' + A)).status, 429, '伪造 XFF 不应绕过');
    // 3) 非法请求体也计一次失败
    assert.strictEqual((await req('POST', '/api/login', { body: 'not json', ip: '203.0.113.50' })).status, 401);

    // 4) 其他 IP 正常登录，token 有效 → 退出后失效
    const ok = await login(PW, '203.0.113.8', 'Mozilla/5.0 e2e');
    assert.strictEqual(ok.status, 200); assert(/^[0-9a-f]{64}$/.test(ok.json.token)); assert(ok.json.expiresAt > Date.now());
    assert.strictEqual((await req('GET', '/api/admin/comments', { token: ok.json.token })).status, 200);
    assert.strictEqual((await req('POST', '/api/logout', { token: ok.json.token, ip: '203.0.113.8' })).status, 200);
    assert.strictEqual((await req('GET', '/api/admin/comments', { token: ok.json.token })).status, 401, '退出后 token 应失效');
    assert.strictEqual((await req('GET', '/api/admin/comments', { token: 'f'.repeat(64) })).status, 401);

    // 5) 会话到期失效（测试里把有效期设成 3 秒）
    const s2 = await login(PW, '203.0.113.9');
    assert.strictEqual((await req('GET', '/api/admin/comments', { token: s2.json.token })).status, 200);
    await sleep(3300);
    assert.strictEqual((await req('GET', '/api/admin/comments', { token: s2.json.token })).status, 401, '过期 token 应失效');

    // 6) 日志：每次尝试一行，含时间、IP、UA，不含密码和 token
    const raw = fs.readFileSync(LOG, 'utf8'), lines = raw.trim().split('\n').map(JSON.parse);
    const n = k => lines.filter(l => l.result === k).length;
    assert.strictEqual(n('fail'), 6); assert.strictEqual(n('locked'), 2); assert.strictEqual(n('success'), 2); assert.strictEqual(n('logout'), 1);
    for (const l of lines) assert(l.time && !isNaN(Date.parse(l.time)) && l.ip && l.ua, JSON.stringify(l));
    assert(lines.some(l => l.result === 'success' && l.ip === '203.0.113.8' && l.ua === 'Mozilla/5.0 e2e'));
    assert(!raw.includes(PW) && !raw.includes(ok.json.token) && !raw.includes('wrong3'), '日志里不能出现密码或 token');
    console.log('LOGIN E2E PASSED (' + lines.length + ' log lines)');
  } finally { srv.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
