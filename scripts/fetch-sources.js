#!/usr/bin/env node
'use strict';
// fetch-sources.js —— 从本机 cron 产出目录里找最新的日报，交给 ingest 处理
// 用法：node scripts/fetch-sources.js [--dry-run]
// 零依赖。直接 require ./ingest 的核心函数，不走 shell。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ingestFile } = require('./ingest');

const MAX_AGE_HOURS = Number(process.env.INGEST_MAX_AGE_HOURS) || 24; // 日报早于这个时长就不灌，避免灌陈货
const MAX_PER_RUN = 5; // 每类日报单次最多灌 5 篇，防止源文件超长刷屏
const BASE = process.env.HERMES_CRON_OUTPUT || path.join(os.homedir(), '.hermes', 'cron', 'output');
const SOURCES = [
  { name: '论文日报', tag: 'paper', dir: path.join(BASE, 'efc0fb26f8d0') },
  { name: '资讯日报', tag: 'news', dir: path.join(BASE, '06d320c5f6ee') }
];

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function log(m) { console.log('[' + stamp() + '] ' + m); }

// 文件名形如 2026-11-27_08-06-51.md，时间戳直接取自文件名；取不到再用文件修改时间
function fileTime(file) {
  const m = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return fs.statSync(file).mtime;
}
// 按文件名（含时间戳）倒序，取最新 1 个
function latestFile(dir) {
  const names = fs.readdirSync(dir).filter(f => /\.md$/.test(f)).sort().reverse();
  return names.length ? path.join(dir, names[0]) : null;
}

function main() {
  const dry = process.argv.includes('--dry-run');
  log('开始检查日报来源' + (dry ? '（试运行，不会写入任何文章）' : '') + '，只处理 ' + MAX_AGE_HOURS + ' 小时内的最新日报，每类最多 ' + MAX_PER_RUN + ' 篇');
  const total = { added: 0, skipped: 0, exists: 0, failed: 0 };
  let problems = 0;
  for (const s of SOURCES) {
    log('--- ' + s.name + '（' + s.dir + '）');
    try {
      if (!fs.existsSync(s.dir)) { log('目录不存在，已跳过。请确认 cron 任务是否在这台机器上运行。'); problems++; continue; }
      const file = latestFile(s.dir);
      if (!file) { log('目录里没有 .md 日报文件，已跳过。'); continue; }
      const t = fileTime(file);
      const ageH = (Date.now() - t.getTime()) / 3600000;
      if (ageH > MAX_AGE_HOURS) {
        log('最新日报是 ' + path.basename(file) + '，距今 ' + ageH.toFixed(1) + ' 小时，超过 ' + MAX_AGE_HOURS + ' 小时，已跳过（避免灌陈货）。');
        continue;
      }
      log('找到最新日报：' + path.basename(file) + '（距今 ' + ageH.toFixed(1) + ' 小时）');
      const r = ingestFile({ source: file, tag: s.tag, dryRun: dry, limit: MAX_PER_RUN, log: m => log('  ' + m) });
      total.added += r.added; total.skipped += r.skipped; total.exists += r.exists; total.failed += r.failed;
    } catch (e) {
      problems++;
      log('处理' + s.name + '时出错：' + e.message);
    }
  }
  log('全部完成' + (dry ? '（试运行）' : '') + '：新增 ' + total.added + ' 篇，跳过 ' + total.skipped + ' 篇（已存在 ' + total.exists + ' / 解析失败 ' + total.failed + '）' + (problems ? '，有 ' + problems + ' 个来源出现问题，请查看上面的日志' : ''));
  if (problems) process.exitCode = 1;
}

main();
