#!/usr/bin/env node
// 把 data/site.json 的 courses 从单课程结构迁移成 groups 多课程结构。幂等：已经有 groups 数组就跳过。
// 用法：node scripts/migrate-courses.js [--dry-run] [site.json 路径，缺省为 data/site.json]
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), dry = args.includes('--dry-run');
const FILE = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'site.json'));
let raw, d;
try { raw = fs.readFileSync(FILE, 'utf-8'); d = JSON.parse(raw); } catch (e) { console.error('读取失败：' + FILE + '（' + e.message + '）'); process.exit(1); }
const c = d && d.courses;
if (!c || typeof c !== 'object' || Array.isArray(c)) { console.error('site.json 里没有 courses 对象，未做任何修改'); process.exit(1); }
if (Array.isArray(c.groups)) { console.log('已经是 groups 结构（' + c.groups.length + ' 门课），跳过，未做任何修改'); process.exit(0); }
const orig = JSON.parse(raw); // 另存一份原始数据，写入前用来逐字比对
const lessons = Array.isArray(c.lessons) ? c.lessons : [];
d.courses = { groups: [
  { id: 'vibe-coding', title: c.title || '', subtitle: c.intro || '', audience: '想自己动手把想法做成产品的人', status: 'open', lessons },
  { id: 'web3-pm', title: 'Web3 产品经理', subtitle: '课程筹备中', audience: '想进入 Web3 做产品的人', status: 'wip', lessons: [] },
  { id: 'fde', title: 'FDE 前线部署工程师', subtitle: '课程筹备中', audience: '想把 AI 落地到客户现场的工程师', status: 'wip', lessons: [] }
] };
const out = JSON.stringify(d, null, 2) + (raw.endsWith('\n') ? '\n' : '');
const back = JSON.parse(out), g0 = back.courses.groups[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = [];
if (!same(g0.lessons, orig.courses.lessons || [])) bad.push('讲次内容与原数据不一致');
if (g0.title !== (orig.courses.title || '') || g0.subtitle !== (orig.courses.intro || '')) bad.push('标题或副标题不一致');
Object.keys(orig).filter(k => k !== 'courses').forEach(k => { if (!same(back[k], orig[k])) bad.push('其他字段被改动：' + k); });
if (bad.length) { console.error('校验失败，未写入：' + bad.join('；')); process.exit(1); }
console.log((dry ? '[dry-run] ' : '') + '迁移 courses：' + lessons.length + ' 讲 → groups[0]（vibe-coding），新增 2 门筹备中课程');
if (!dry) {
  const bdir = path.join(path.dirname(FILE), 'backup'); fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(FILE, path.join(bdir, 'site-' + Date.now() + '.json'));
  fs.writeFileSync(FILE + '.tmp', out); fs.renameSync(FILE + '.tmp', FILE); // tmp + rename 原子写入
}
