#!/usr/bin/env node
'use strict';
// push-online.js —— 日报 → 线上博客（走 /api 直推，不碰 git）
// 用法：
//   SITE_URL=https://aiucc.cn ADMIN_PASSWORD=xxx node scripts/push-online.js [--dry-run] [--limit 5]
//   node scripts/push-online.js --source <日报.md> --tag paper   （只推单个文件）
//
// 为什么不用 git：deploy.yml 里 `git checkout origin/main -- . ':(exclude)data'` 明确排除 data/，
// 所以提交到 git 的 data/posts/*.json 永远不会生效，线上内容只能走 API 写入。
//
// 流程：复用 ingest.js 的解析器（dry-run 模式取 items）→ 拉线上已有列表做去重 → PUT /api/posts/:id

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ingestFile } = require('./ingest.js');

const SITE = (process.env.SITE_URL || 'https://aiucc.cn').replace(/\/$/, '');
const TOKEN_FILE = path.join(os.homedir(), '.hermes', 'aiucc_token');

function log(...a) { console.log(...a); }
function die(msg) { console.error('❌ ' + msg); process.exit(1); }

function parseArgs(argv) {
  const a = { dryRun: false, limit: 5, source: '', tag: '', token: '', keepLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10) || 5;
    else if (x === '--source') a.source = argv[++i] || '';
    else if (x === '--tag') a.tag = argv[++i] || '';
    else if (x === '--token') a.token = argv[++i] || '';
    else if (x === '--keep-local') a.keepLocal = true;
  }
  return a;
}

async function api(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-token'] = token;
  const res = await fetch(SITE + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function login(password) {
  const r = await api('POST', '/api/login', { body: { password } });
  if (!r.ok || !r.data || !r.data.token) die('登录失败（HTTP ' + r.status + '）：' + JSON.stringify(r.data));
  return r.data.token;
}

// 线上已有文章的标题 + 链接 + id，用于跨机器去重
async function fetchOnlineIndex(token) {
  const r = await api('GET', '/api/posts?tag=all', { token });
  if (!r.ok) die('拉取线上文章列表失败（HTTP ' + r.status + '）');
  const titles = new Set(), links = new Set(), ids = new Set();
  for (const p of r.data || []) {
    if (p.title) titles.add(String(p.title).trim());
    ids.add(p.id);
    // 列表接口不一定带 link，稍后用单篇接口补
  }
  return { titles, links, ids };
}

// 日报找最新的（早于 maxAgeHours 则视为过期）
function latestReport(dir, maxAgeHours = 24) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
    .map(f => ({ f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  const top = files[0];
  const ageH = (Date.now() - top.mtime) / 3600000;
  return { ...top, ageH };
}

// 用 ingest.js 的解析器取出文章对象（走 dry-run，不落本地盘）
function extract(sourceFile, tag, limit) {
  const items = [];
  const sink = () => {}; // 吞掉 ingest 的日志，稍后统一输出
  const res = ingestFile({ source: sourceFile, tag, dryRun: true, limit, log: sink, verbose: false });
  return res.items || [];
}

async function pushOne(token, post, dryRun) {
  if (dryRun) {
    log('  [试运行] 将推上线：' + post.title);
    log('    摘要：' + post.summary);
    log('    正文：' + post.body.length + ' 字，' + post.body.split(/\n\s*\n/).length + ' 段' + (post.link ? '，链接 ' + post.link : ''));
    return { ok: true, dry: true };
  }
  const r = await api('PUT', '/api/posts/' + encodeURIComponent(post.id), { token, body: post });
  if (!r.ok) {
    log('  ❌ 失败：' + post.title + ' → HTTP ' + r.status + ' ' + JSON.stringify(r.data));
    return { ok: false, status: r.status };
  }
  log('  ✅ 已上线：' + post.title);
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const PASSWORD = process.env.ADMIN_PASSWORD || '';
  const token = args.token || process.env.ADMIN_TOKEN || '';

  log('=========== ToddSite 内容推送 ===========');
  log('目标站点：' + SITE + (args.dryRun ? '（试运行，不写入线上）' : ''));

  let tk = token;
  if (!args.dryRun) {
    if (!tk) {
      if (!PASSWORD) die('缺少密码：请设置环境变量 ADMIN_PASSWORD，或用 --token 直接给 token');
      log('登录中……');
      tk = await login(PASSWORD);
      try { fs.writeFileSync(TOKEN_FILE, tk, { mode: 0o600 }); } catch (e) {}
      log('登录成功');
    }
  }

  // 决定要处理哪些日报
  const jobs = [];
  const HOME = os.homedir();
  if (args.source) {
    if (!args.tag) die('--source 必须同时给 --tag paper|news');
    jobs.push({ source: path.resolve(args.source), tag: args.tag, label: path.basename(args.source) });
  } else {
    const sources = [
      { dir: path.join(HOME, '.hermes', 'cron', 'output', 'efc0fb26f8d0'), tag: 'paper', name: '论文日报' },
      { dir: path.join(HOME, '.hermes', 'cron', 'output', '06d320c5f6ee'), tag: 'news', name: '资讯日报' },
    ];
    for (const s of sources) {
      const f = latestReport(s.dir);
      if (!f) { log('⚠️  ' + s.name + '：目录里没有 md 文件，跳过'); continue; }
      if (f.ageH > 24) { log('⚠️  ' + s.name + '：最新的 ' + f.f + ' 已是 ' + f.ageH.toFixed(1) + ' 小时前（超过24小时），跳过'); continue; }
      log(s.name + '：找到最新 ' + f.f + '（' + f.ageH.toFixed(1) + ' 小时前）');
      jobs.push({ source: f.full, tag: s.tag, label: s.name });
    }
  }

  if (!jobs.length) { log('没有可处理的日报，结束。'); return; }

  // 线上已有的索引（去重）
  let online = { titles: new Set(), links: new Set(), ids: new Set() };
  if (!args.dryRun) {
    online = await fetchOnlineIndex(tk);
    log('线上现有文章：' + online.ids.size + ' 篇');
  }

  let totalPush = 0, totalSkip = 0, totalFail = 0;
  for (const job of jobs) {
    log('\n--- ' + job.label + '（tag=' + job.tag + '）---');
    let items;
    try { items = extract(job.source, job.tag, args.limit); }
    catch (e) { log('  ❌ 解析失败：' + e.message); continue; }
    log('  解析出 ' + items.length + ' 篇可推送');
    for (const post of items) {
      const dup = online.titles.has(post.title.trim()) || online.ids.has(post.id);
      if (dup) { log('  ⏭  已存在，跳过：' + post.title); totalSkip++; continue; }
      const r = await pushOne(tk, post, args.dryRun);
      if (r.ok) { totalPush++; online.titles.add(post.title.trim()); online.ids.add(post.id); }
      else totalFail++;
    }
  }

  log('\n=========== 汇总 ===========');
  log((args.dryRun ? '[试运行] ' : '') + '推送成功 ' + totalPush + ' 篇，跳过 ' + totalSkip + ' 篇，失败 ' + totalFail + ' 篇');

  if (!args.dryRun && totalPush > 0) {
    const check = await api('GET', '/api/tags', { token: tk });
    if (check.ok) log('线上现在：原创 ' + check.data.original + ' / 论文 ' + check.data.paper + ' / 资讯 ' + check.data.news);
  }
  if (totalFail > 0) process.exit(1);
}

main().catch(e => { console.error('❌ 异常：' + (e && e.stack || e)); process.exit(1); });
