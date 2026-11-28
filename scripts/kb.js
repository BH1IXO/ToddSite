#!/usr/bin/env node
'use strict';
// 知识库维护命令行。写入走线上接口（需要 ADMIN_PASSWORD），检索也可在本地直接跑。
//   node scripts/kb.js add --title "标题" --file 档案.md [--kind 履历] [--trust chat]
//   node scripts/kb.js add --title "标题" --text "正文" [--split] [--id 自定义id]
//   node scripts/kb.js seed                把网站内容与已发布文章灌进去（可重复执行，同一 id 覆盖）
//   node scripts/kb.js search "关键词" [--k 6]
//   node scripts/kb.js list | stats | rm <id> | compact
//   node scripts/kb.js quarantine          查看被隔离的段落（只读）
// 公共参数：
//   --local            直接读写本机 data/kb，不经过服务器
//   --url <地址>       默认 https://aiucc.cn；--local 时忽略
//   --token <token>    已有登录 token；否则用 ADMIN_PASSWORD 登录
//   --dry-run          只打印将要写入什么，不落库（add/seed 支持）
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; }
    } else a._.push(x);
  }
  return a;
}
const log = (...s) => console.log(...s);
const die = m => { console.error('❌ ' + m); process.exit(1); };
const readText = f => fs.readFileSync(f, 'utf-8').replace(/\r\n?/g, '\n');

// ---- 本地模式 ----
function localKB() {
  const KB = require('../lib/kb').open(path.join(ROOT, 'data', 'kb'));
  return KB;
}

// ---- 远程模式 ----
const TOKEN_FILE = path.join(os.homedir(), '.hermes', 'aiucc_token');
async function login(a) {
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!pw) return '';
  const url = (a.url && a.url !== true ? a.url : 'https://aiucc.cn').replace(/\/$/, '');
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  if (!r.ok) die('登录失败：' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  if (!j.token) die('登录没有返回 token');
  // 只有默认线上地址才把 token 存起来；本地调试不覆盖真实 token
  if (!(a.url && a.url !== true)) { try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, j.token); } catch (e) {} }
  return j.token;
}
async function tokenOf(a) {
  if (a.token && a.token !== true) return a.token;
  // 密码优先于缓存 token：服务重启后旧 token 一定失效，而密码总是能用
  if (process.env.ADMIN_PASSWORD) return login(a);
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); if (t) return t; } catch (e) {}
  die('没有 token，也没设置 ADMIN_PASSWORD 环境变量');
}
async function remote(a, method, p, body, retried) {
  const base = (a.url && a.url !== true ? a.url : 'https://aiucc.cn').replace(/\/$/, '');
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'x-token': await tokenOf(a) }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 401 && !retried && process.env.ADMIN_PASSWORD) { await login(a); return remote(a, method, p, body, true); }
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) die('接口返回 ' + r.status + '：' + (j && j.error ? j.error : text.slice(0, 300)));
  return j;
}

// 把 markdown 按二级/三级标题拆成多篇；没有标题就整篇
function splitMarkdown(text, baseTitle) {
  const lines = text.split('\n'), out = []; let cur = null, buf = [];
  const flush = () => { if (cur && buf.join('\n').trim()) out.push({ title: cur, text: buf.join('\n').trim() }); buf = []; };
  for (const l of lines) {
    const m = l.match(/^#{2,3}\s+(.+)$/);
    if (m) { flush(); cur = m[1].trim(); } else { if (!cur) cur = baseTitle; buf.push(l); }
  }
  flush();
  if (!out.length) out.push({ title: baseTitle, text: text.trim() });
  return out;
}

function report(res, label) {
  if (!res || res.ok === false) {
    if (res && res.quarantined) return log('⛔ ' + label + ' 整篇被隔离（' + res.reasons.join('、') + '），已放进隔离区，未入库');
    return log('⚠️ ' + (res && res.error ? res.error : '失败') + '：' + label);
  }
  const bits = ['已入库：' + label, res.chunks + ' 段', res.chars + ' 字'];
  if (res.trimmed) bits.push('清洗掉 ' + res.trimmed + ' 字');
  if (res.quarantinedParas) bits.push('隔离 ' + res.quarantinedParas + ' 段');
  log('✅ ' + bits.join(' · '));
}

async function main() {
  const a = parseArgs(process.argv.slice(2)), cmd = a._[0];
  if (!cmd || a.help) {
    log('用法：node scripts/kb.js add|seed|search|list|stats|rm|compact|quarantine [参数]');
    log('细节见文件头注释。');
    return;
  }
  const local = !!a.local;
  const kb = local ? localKB() : null;

  if (cmd === 'add') {
    let text = '';
    if (a.file && a.file !== true) text = readText(String(a.file));
    else if (a.text && a.text !== true) text = String(a.text);
    else die('需要 --file 或 --text');
    const baseTitle = a.title && a.title !== true ? String(a.title) : path.basename(String(a.file || '未命名')).replace(/\.(md|txt|json)$/i, '');
    const items = a.split ? splitMarkdown(text, baseTitle) : [{ title: baseTitle, text }];
    const docs = items.map(it => Object.assign({}, it, {
      kind: a.kind && a.kind !== true ? String(a.kind) : '',
      trust: a.trust && a.trust !== true ? String(a.trust) : 'unknown',
      id: a.id && a.id !== true && items.length === 1 ? String(a.id) : undefined,
    }));
    if (a['dry-run']) { log('将写入 ' + docs.length + ' 篇：'); docs.forEach(d => log('- ' + d.title + '（' + d.text.length + ' 字，trust=' + d.trust + '）')); return; }
    if (local) { docs.forEach(d => report(kb.add(d), d.title)); return; }
    const out = await remote(a, 'POST', '/api/kb/ingest', { items: docs });
    (out.results || []).forEach((r, i) => report(r, docs[i].title));
    return;
  }

  if (cmd === 'seed') {
    const docs = require('../lib/kb/seed').fromSite(ROOT);
    if (a['dry-run']) { log('将写入 ' + docs.length + ' 篇：'); docs.forEach(d => log('- ' + d.title + '（' + d.text.length + ' 字）')); return; }
    if (local) { docs.forEach(d => report(kb.add(d), d.title)); return; }
    const out = await remote(a, 'POST', '/api/kb/ingest', { items: docs });
    (out.results || []).forEach((r, i) => report(r, docs[i].title));
    return;
  }

  if (cmd === 'search') {
    const q = a._.slice(1).join(' ') || die('需要检索词');
    const k = parseInt(a.k, 10) || 6;
    if (local) {
      const hits = kb.search(q, k);
      log('共 ' + hits.length + ' 段命中');
      hits.forEach((h, i) => log('\n' + (i + 1) + '. 【' + (h.title || h.doc) + '】 分数 ' + h.score + '\n' + h.text.slice(0, 300)));
      return;
    }
    const out = await remote(a, 'GET', '/api/admin/kb/search?q=' + encodeURIComponent(q) + '&k=' + k);
    log('共 ' + out.hits.length + ' 段命中（' + out.ms + 'ms）');
    out.hits.forEach((h, i) => log('\n' + (i + 1) + '. 【' + (h.title || h.doc) + '】 分数 ' + h.score + '\n' + h.text.slice(0, 300)));
    return;
  }

  if (cmd === 'list' || cmd === 'stats') {
    if (local) {
      if (cmd === 'list') kb.list().forEach(d => log([d.id, d.title, d.kind, d.chars + '字', d.chunks + '段'].join(' · ')));
      else log(JSON.stringify(kb.stats(), null, 2));
      return;
    }
    const out = await remote(a, 'GET', '/api/admin/kb');
    if (cmd === 'list') out.docs.forEach(d => log([d.id, d.title, d.kind, d.chars + '字', d.chunks + '段'].join(' · ')));
    else log(JSON.stringify(out.stats, null, 2) + '\n隔离区：' + out.quarantine + ' 批');
    return;
  }

  if (cmd === 'quarantine') {
    if (local) { const q = kb.quarantined(); log('隔离区 ' + q.length + ' 批'); q.slice(-20).forEach(x => log('\n- ' + (x.title || x.id) + '：' + x.chunks.map(c => c.text.slice(0, 120) + '（' + c.reasons.join('、') + '）').join('\n  '))); return; }
    const out = await remote(a, 'GET', '/api/admin/kb/quarantine');
    log('隔离区 ' + out.list.length + ' 批（最近 100 批）');
    out.list.forEach(x => log('\n- ' + (x.title || x.id) + '：' + x.chunks.map(c => c.text.slice(0, 120) + '（' + c.reasons.join('、') + '）').join('\n  ')));
    return;
  }

  if (cmd === 'rm') {
    const id = a._[1] || die('需要文档 id');
    if (local) { const r = kb.remove(id); log(r.ok ? '已删除 ' + id : r.error); return; }
    const r = await remote(a, 'DELETE', '/api/kb/doc/' + encodeURIComponent(id), {});
    log(r.ok ? '已删除 ' + id : r.error || '删除失败');
    return;
  }

  if (cmd === 'compact') {
    if (local) { log(JSON.stringify(kb.compact(), null, 2)); return; }
    const r = await remote(a, 'POST', '/api/kb/compact', {});
    log(JSON.stringify(r.stats, null, 2));
    return;
  }

  die('不认识的命令：' + cmd);
}

main().catch(e => die(e && e.message ? e.message : String(e)));
