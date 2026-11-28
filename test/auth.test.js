// lib/auth.js 单元测试：node test/auth.test.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { create } = require(process.argv[2] || require('path').join(__dirname, '..', 'lib', 'auth'));
let t = 1_000_000; const now = () => t; const warns = [];
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authlog-')), 'x', 'login.log');
const A = create({ password: 'correct horse', now, logFile: log, warn: m => warns.push(m) });
const IP = '1.2.3.4', UA = 'TestUA/1.0';
// 4 fails -> remaining counts down
for (let i = 1; i <= 4; i++) { const r = A.login('nope', IP, UA); assert.deepStrictEqual(r, { ok: false, remaining: 5 - i }); }
// 5th fail locks 15 min
let r = A.login('nope', IP, UA); assert(r.locked && r.retryAfterSec === 900, JSON.stringify(r));
// correct password while locked is rejected (not even checked)
r = A.login('correct horse', IP, UA); assert(r.locked && !r.ok, 'locked should reject correct pw');
// other IP unaffected
r = A.login('correct horse', '5.6.7.8', UA); assert(r.ok && r.token.length === 64);
assert(A.check(r.token)); const tok = r.token;
// lock expires -> fresh 5 tries, second lock doubles to 30 min
t += 900_000 + 1;
for (let i = 1; i <= 4; i++) assert.strictEqual(A.login('nope', IP, UA).remaining, 5 - i);
r = A.login('nope', IP, UA); assert.strictEqual(r.retryAfterSec, 1800);
t += 1800_000 + 1; for (let i = 0; i < 5; i++) r = A.login('x', IP, UA); assert.strictEqual(r.retryAfterSec, 3600);
// success after lock clears strikes
t += 3600_000 + 1; assert(A.login('correct horse', IP, UA).ok);
for (let i = 0; i < 5; i++) r = A.login('x', IP, UA); assert.strictEqual(r.retryAfterSec, 900, 'strikes reset after success');
// sliding window: fails older than 15 min drop off
const IP2 = '9.9.9.9'; for (let i = 0; i < 4; i++) A.login('x', IP2, UA); t += 15 * 60e3 + 1;
assert.strictEqual(A.login('x', IP2, UA).remaining, 4);
// non-string / empty passwords fail
assert(!A.login('', '7.7.7.7', UA).ok); assert(!A.login(undefined, '7.7.7.7', UA).ok); assert(!A.login({}, '7.7.7.7', UA).ok);
// session expiry 12h
assert(A.check(tok), 'still valid after ~2h');
t = 1_000_000 + 12 * 3600e3 - 1; assert(A.check(tok), 'valid just before 12h');
t = 1_000_000 + 12 * 3600e3; assert(!A.check(tok), 'expired at 12h'); assert(!A._sessions.has(tok));
// garbage tokens
for (const bad of [undefined, '', 'abc', 123, 'a'.repeat(64)]) assert(!A.check(bad));
// logout
const L = A.login('correct horse', '8.8.8.8', UA); assert(A.check(L.token)); assert(A.logout(L.token, '8.8.8.8', UA)); assert(!A.check(L.token)); assert(!A.logout(L.token));
// session cap 20: oldest evicted
const toks = []; for (let i = 0; i < 25; i++) toks.push(A.login('correct horse', '8.8.4.' + i, UA).token);
assert.strictEqual(A._sessions.size, 20); assert(!A.check(toks[0]) && A.check(toks[24]));
// prune
t += 13 * 3600e3; A.prune(); assert.strictEqual(A._sessions.size, 0);
// log file contents
const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const kinds = lines.reduce((m, l) => (m[l.result] = (m[l.result] || 0) + 1, m), {});
console.log('log events', kinds, 'mode', (fs.statSync(log).mode & 0o777).toString(8));
for (const l of lines) { assert(l.time && l.ip && l.ua === UA, JSON.stringify(l)); assert(!JSON.stringify(l).includes('correct horse') && !JSON.stringify(l).includes('nope')); assert(!(l.session && toks.some(x => JSON.stringify(l).includes(x)))); }
assert(kinds.success && kinds.fail && kinds.locked && kinds.logout);
assert(warns.length >= 4, 'lock warnings');
// rotation
const B = create({ password: 'p', now, logFile: log, logMaxBytes: 200, warn: () => {} });
for (let i = 0; i < 10; i++) B.login('x', '3.3.3.' + i, 'u'.repeat(50));
assert(fs.existsSync(log + '.1') && fs.statSync(log).size < 1000);
// UA/IP truncation & no password -> throws
const C = create({ password: 'p', now, logFile: '', warn: () => {} }); C.login('x', 'i'.repeat(500), 'u'.repeat(5000));
assert.throws(() => create({ password: '' }));
// many-IP memory bound
const D = create({ password: 'p', now, warn: () => {} }); for (let i = 0; i < 60000; i++) D.login('x', 'ip' + i, 'u'); assert(D._ips.size <= 50001, 'ips bounded ' + D._ips.size);
console.log('ALL AUTH TESTS PASSED');
