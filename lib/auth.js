'use strict';
// 后台登录防护：按 IP 统计失败并临时锁定（重犯加倍）、登录日志（JSON Lines）、带有效期的会话 token。
// 全部状态在内存里：重启后会话失效、计数清零；日志落盘。
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function create(opts) {
  const o = Object.assign({
    password: '',
    maxFails: 5,                  // 窗口内允许连续输错的次数，达到即锁定
    windowMs: 15 * 60e3,          // 失败计数窗口
    lockMs: 15 * 60e3,            // 首次锁定时长；之后每次再被锁翻倍
    maxLockMs: 24 * 3600e3,       // 锁定时长上限；也是「前科」清零的冷却期
    sessionTtlMs: 12 * 3600e3,    // 会话有效期（从登录起算，固定不续期）
    maxSessions: 20,              // 同时有效的会话上限，超出踢掉最早的
    logFile: '',                  // 登录日志路径，空则不落盘
    logMaxBytes: 5 * 1024 * 1024, // 超过即轮转为 .1（只留一份旧的）
    now: () => Date.now(),
    warn: m => console.warn(m),
  }, opts);
  if (!o.password) throw new Error('auth: password required');
  const pw = digest(o.password);
  const sessions = new Map(); // token -> { exp, ip }
  const ips = new Map();      // ip -> { fails: [ts...], lockUntil, strikes, lastLock }

  function log(ev) {
    if (!o.logFile) return;
    try {
      fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
      try { if (fs.statSync(o.logFile).size > o.logMaxBytes) fs.renameSync(o.logFile, o.logFile + '.1'); } catch (e) {}
      fs.appendFileSync(o.logFile, JSON.stringify(Object.assign({ time: new Date(o.now()).toISOString() }, ev)) + '\n', { mode: 0o600 });
    } catch (e) { o.warn('[auth] 写登录日志失败：' + e.message); }
  }
  const sid = t => digest(t).toString('hex').slice(0, 12); // 日志里只记 token 的指纹，不记 token 本身

  function state(ip) {
    let s = ips.get(ip);
    if (!s) { s = { fails: [], lockUntil: 0, strikes: 0, lastLock: 0 }; ips.set(ip, s); }
    const now = o.now();
    if (s.lockUntil && s.lockUntil <= now) { s.lockUntil = 0; s.fails = []; } // 锁到期：重新给满次数，但前科保留
    if (s.strikes && now - s.lastLock > o.maxLockMs) s.strikes = 0;           // 长时间没再被锁，前科清零
    s.fails = s.fails.filter(t => now - t < o.windowMs);
    return s;
  }

  // 返回 { ok:true, token, expiresAt } | { ok:false, locked:true, retryAfterSec } | { ok:false, remaining }
  function login(password, ip, ua) {
    const now = o.now(), base = { ip: clip(ip, 64), ua: clip(ua, 300) };
    if (ips.size > 50000) prune();
    const s = state(base.ip);
    if (s.lockUntil > now) { // 锁定期间根本不比对密码，避免继续被当作猜测口
      const retryAfterSec = Math.ceil((s.lockUntil - now) / 1000);
      log(Object.assign({ result: 'locked' }, base, { lockedUntil: new Date(s.lockUntil).toISOString() }));
      return { ok: false, locked: true, retryAfterSec };
    }
    const good = typeof password === 'string' && password.length > 0 && crypto.timingSafeEqual(digest(password), pw);
    if (!good) {
      s.fails.push(now);
      if (s.fails.length >= o.maxFails) {
        s.strikes++; s.lastLock = now;
        const dur = Math.min(o.lockMs * Math.pow(2, s.strikes - 1), o.maxLockMs);
        s.lockUntil = now + dur;
        log(Object.assign({ result: 'fail' }, base, { fails: s.fails.length, lockedUntil: new Date(s.lockUntil).toISOString(), lockMinutes: Math.round(dur / 60e3) }));
        o.warn('[auth] IP ' + base.ip + ' 连续输错 ' + s.fails.length + ' 次，锁定 ' + Math.round(dur / 60e3) + ' 分钟');
        return { ok: false, locked: true, retryAfterSec: Math.ceil(dur / 1000) };
      }
      log(Object.assign({ result: 'fail' }, base, { fails: s.fails.length }));
      return { ok: false, remaining: o.maxFails - s.fails.length };
    }
    ips.delete(base.ip); // 成功：清掉该 IP 的失败记录和前科
    const token = crypto.randomBytes(32).toString('hex'), exp = now + o.sessionTtlMs;
    sessions.set(token, { exp, ip: base.ip });
    while (sessions.size > o.maxSessions) sessions.delete(sessions.keys().next().value); // Map 按插入顺序，第一个最早
    log(Object.assign({ result: 'success' }, base, { session: sid(token), expiresAt: new Date(exp).toISOString() }));
    return { ok: true, token, expiresAt: exp };
  }

  function check(token) {
    if (typeof token !== 'string' || token.length !== 64) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (s.exp <= o.now()) { sessions.delete(token); return false; }
    return true;
  }

  function logout(token, ip, ua) {
    if (typeof token !== 'string' || !sessions.delete(token)) return false;
    log({ result: 'logout', ip: clip(ip, 64), ua: clip(ua, 300), session: sid(token) });
    return true;
  }

  function prune() {
    const now = o.now();
    for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
    for (const [ip] of ips) {
      const s = state(ip);
      if (!s.lockUntil && !s.fails.length && !s.strikes) ips.delete(ip);
    }
    // 大量不同 IP 撒网时兜底：丢掉最早的未锁定记录，正在锁定的不动
    if (ips.size > 40000) for (const [ip, s] of ips) { if (ips.size <= 30000) break; if (!s.lockUntil) ips.delete(ip); }
  }

  return { login, check, logout, prune, _sessions: sessions, _ips: ips };
}

module.exports = { create };
