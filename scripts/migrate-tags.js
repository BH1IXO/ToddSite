#!/usr/bin/env node
// 给 data/posts/*.json 补 tag 字段（缺省 original）。用法：node scripts/migrate-tags.js [--dry-run]
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'posts');
const dry = process.argv.includes('--dry-run');
let changed = 0, skipped = 0, failed = 0;
if (!fs.existsSync(DIR)) { console.error('找不到文章目录：' + DIR); process.exit(1); }
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort()) {
  const file = path.join(DIR, f);
  let raw, obj;
  try { raw = fs.readFileSync(file, 'utf-8'); obj = JSON.parse(raw); } catch (e) { console.error('读取失败，已跳过：' + f + '（' + e.message + '）'); failed++; continue; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { console.error('不是文章对象，已跳过：' + f); failed++; continue; }
  if (Object.prototype.hasOwnProperty.call(obj, 'tag')) { skipped++; continue; }
  obj.tag = 'original'; // 新字段追加在末尾，原有字段顺序不变
  if (!dry) { fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2) + (raw.endsWith('\n') ? '\n' : '')); fs.renameSync(file + '.tmp', file); } // tmp + rename 原子写入
  changed++;
}
console.log((dry ? '[dry-run] ' : '') + '改了 ' + changed + ' 个，跳过 ' + skipped + ' 个' + (failed ? '，失败 ' + failed + ' 个' : ''));
if (failed) process.exitCode = 1;
