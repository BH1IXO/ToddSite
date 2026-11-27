#!/usr/bin/env node
'use strict';
// ingest.js —— 把 cron 日报（markdown）转成博客文章，写入 data/posts/
// 用法：node scripts/ingest.js --source <日报.md> --tag paper|news [--dry-run] [--force]
// 零依赖，只用 fs / path / crypto。核心函数导出给 fetch-sources.js 直接 require，不走 shell。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POSTS_DIR = path.join(__dirname, '..', 'data', 'posts');
// 文章字段顺序固定（与任务要求一致）
const FIELD_ORDER = ['id', 'title', 'date', 'tag', 'summary', 'body', 'link', 'source', 'published', 'createdAt'];

// ===== 第 1 部分：小工具 =====
function sha8(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 8);
}
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // tmp + rename：写到一半断电也不会留下半个文件
}
function serializePost(post) {
  const ordered = {};
  for (const k of FIELD_ORDER) ordered[k] = post[k];
  return JSON.stringify(ordered, null, 2) + '\n'; // 保留文件末尾换行
}
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// 日期优先取文件名里的 YYYY-MM-DD，其次取正文 Run Time 行，最后用今天
function detectDate(sourceFile, text) {
  const m = path.basename(sourceFile).match(/(\d{4}-\d{2}-\d{2})/) || String(text).match(/Run Time:\**\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : todayStr();
}

// ===== 第 2 部分：解析（[[PARSE]]）=====
// 【真实格式，2026-11-27 实测，以真实文件为准】
// 两种日报开头都有 ## Prompt（整份技能文档，里面全是示例标题），真正的产出在最后一个 ## Response 之后，
// 所以必须先截取 Response 之后的内容，否则示例会被当成条目。
// 资讯日报(06d320c5f6ee)：条目是二级标题「## 素材一（🔥今日最推荐）：标题」；键值是「- **来源**：媒体 → URL ｜ ...」「- **核心看点**：...」
//   「- **热度评级**：...」「- **口播切入点**：...」，「- **可用金句/数据**：」后面接缩进子列表；「## 备选」「## 今日口播选题推荐」不是条目。
// 论文日报(efc0fb26f8d0)：没有标题行，条目是加粗行「**论文1：标题**」，下面是不带项目符号的「作者：/arXiv编号：/核心贡献：/为什么值得读：/论文链接：」；
//   「🔥 **第1条：标题**」是资讯类条目（tag=paper 时跳过，不算解析失败）。
// 同时兼容任务文档设想的格式：「### 1. 标题」+「- arXiv: ...」，「### 素材一：标题」+「**原文链接**：...」。
const KEY_ALIASES = {
  why: ['为什么值得读', '为什么重要', '推荐理由', '为什么值得学', '为什么值得看'],
  link: ['原文链接', '链接', '论文链接', '原文', 'url'],
  src: ['来源'],
  summary: ['要点', '摘要', '核心', '核心看点', '一句话总结', '简介'],
  contrib: ['核心贡献', '主要贡献', '贡献'],
  authors: ['作者'],
  arxiv: ['arxiv', 'arxiv编号', 'arxivid'],
  heat: ['热度', '热度评级'],
  angle: ['口播切入点', '切入点'],
  quotes: ['可用金句/数据', '可用金句', '金句'],
  rating: ['重要性']
};
const ALIAS_MAP = {};
for (const f of Object.keys(KEY_ALIASES)) for (const a of KEY_ALIASES[f]) ALIAS_MAP[a.replace(/\s+/g, '').toLowerCase()] = f;
function normKey(k) { return String(k).replace(/[*`\s]/g, '').toLowerCase(); }
function mapKey(k) { const n = normKey(k); return ALIAS_MAP[n] || 'x_' + n; }
function mapKeyKnown(k) { return ALIAS_MAP[normKey(k)] || null; }
function cleanText(s) { return String(s || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim(); }

// 标题前缀：素材一：/ 论文1： / 第1条： / 素材一（🔥今日最推荐）：
const PREFIX_RE = /^(?:素材|论文|第)\s*[一二三四五六七八九十百零\d]+\s*[条篇个]?(?:\s*[（(][^）)]*[）)])?\s*[：:.、]/;
const NUMBERED_RE = /^\d+\s*[.、)）]\s*\S/;
function cleanTitle(t) {
  let s = String(t).replace(/\*\*/g, '').replace(/`/g, '').trim();
  s = s.replace(/^[^\p{L}\p{N}]+/u, ''); // 去掉开头的 emoji 等符号
  s = s.replace(/^(?:素材|论文|第)\s*[一二三四五六七八九十百零\d]+\s*[条篇个]?(?:\s*[（(][^）)]*[）)])?\s*[：:.、]\s*/, ''); // 去「素材一：」类前缀
  s = s.replace(/^\d+\s*[.、)）]\s*/, ''); // 去「1.」类序号
  return s.trim();
}
function isEntryText(t) { return PREFIX_RE.test(t) || NUMBERED_RE.test(t); }
// 判断一行是不是条目开头：二~四级标题（三、四级一律算条目，二级须带「素材/论文/第N条/序号」），或整行加粗且带前缀
function entryStart(line) {
  let m = line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
  if (m) {
    const text = m[2].replace(/\*\*/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
    if (m[1].length >= 3 || isEntryText(text)) return { raw: text, title: cleanTitle(text), level: m[1].length };
    return null;
  }
  m = line.match(/^[^\p{L}\p{N}*]*\*\*(.+?)\*\*\s*$/u);
  if (m && isEntryText(m[1].trim())) return { raw: m[1].trim(), title: cleanTitle(m[1]), level: 9 };
  return null;
}
// 条目结束：任意非条目标题、分隔线、📈💡📚 开头的栏目行、整行加粗的小标题
function isTerminator(line) {
  return /^#{1,6}\s/.test(line) || /^\s*(?:---+|\*\*\*+)\s*$/.test(line) || /^[📈💡📚]/u.test(line) || /^\*\*[^*]+\*\*\s*$/.test(line);
}
// 键值行：「- **键**：值」「**键**：值」「- 键：值」「键：值」（后两种要求键名在同义表里，避免误伤普通句子）；缩进行属于上一个键的续行
function parseKV(line) {
  if (/^\s{2,}/.test(line)) return null;
  const s = line.replace(/^[-*+]\s+/, '').trim();
  let m = s.match(/^\*\*(.{1,16}?)\*\*\s*[：:]\s*(.*)$/) || s.match(/^\*\*(.{1,16}?)\s*[：:]\s*\*\*\s*(.*)$/);
  if (m) return { key: mapKey(m[1]), value: m[2] };
  m = s.match(/^(.{1,16}?)\s*[：:]\s*(.*)$/);
  if (m) { const k = mapKeyKnown(m[1]); if (k) return { key: k, value: m[2] }; }
  return null;
}
function appendField(fields, key, val) {
  val = String(val || '').trim();
  if (!val) return;
  fields[key] = fields[key] ? fields[key] + '\n' + val : val;
}
function firstUrl(s) {
  const m = String(s || '').match(/https?:\/\/[^\s)）｜|>\]」”]+/);
  return m ? m[0].replace(/[.,，。;；、]+$/, '') : '';
}
// 解析整份 markdown，返回条目数组：{ title, kind(paper|news), link, arxivId, authors, srcName, summary, contrib, why, heat, angle, quotes, valid }
function parseMarkdown(text) {
  const marks = [...String(text).matchAll(/^## Response\s*$/gm)];
  const last = marks[marks.length - 1];
  const body = last ? text.slice(last.index + last[0].length) : text;
  const entries = [];
  let cur = null, lastKey = null;
  for (const line of body.split(/\r?\n/)) {
    const st = entryStart(line);
    if (st) { cur = { raw: st.raw, title: st.title, fields: {} }; entries.push(cur); lastKey = null; continue; }
    if (isTerminator(line)) { cur = null; lastKey = null; continue; }
    if (!cur) continue;
    const kv = parseKV(line);
    if (kv) { appendField(cur.fields, kv.key, kv.value); lastKey = kv.key; }
    else if (line.trim() && lastKey) appendField(cur.fields, lastKey, line.replace(/^\s*[-*+]\s+/, ''));
  }
  return entries.map(e => {
    const f = e.fields;
    const arxivId = (String(f.arxiv || '').match(/\d{4}\.\d{4,5}/) || [])[0] || '';
    const link = firstUrl(f.link) || firstUrl(f.src) || (arxivId ? 'https://arxiv.org/abs/' + arxivId : '');
    // 类型：「论文N」是论文；「第N条/素材N」是资讯；其余标题看有没有 arXiv 字段或链接
    const kind = /^论文/.test(e.raw) ? 'paper' : /^(第|素材)/.test(e.raw) ? 'news' : (f.arxiv || /arxiv\.org/.test(link) ? 'paper' : 'news');
    const item = {
      title: e.title, kind, link, arxivId,
      authors: cleanText(f.authors),
      srcName: cleanText(String(f.src || '').split(/[→｜|]|https?:\/\//)[0]), // 来源行形如「量子位 → URL ｜ 项目官网 URL（备注）」，只取第一段媒体名
      summary: cleanText(f.summary), contrib: cleanText(f.contrib), why: cleanText(f.why),
      heat: cleanText(f.heat), angle: cleanText(f.angle), quotes: cleanText(f.quotes)
    };
    item.valid = !!(item.title && (item.link || item.summary || item.contrib || item.why));
    return item;
  });
}

// ===== 第 3 部分：把条目写成文章正文（[[COMPOSE]]）=====
// 前端 post.html 只认：空行分段、# 开头的标题（渲染成 h2）、图片；不认加粗/列表/链接。所以正文只用「空行分段 + ## 小标题」，链接以纯文本放在底部。
function sentences(t) { return String(t || '').split('\n').flatMap(l => l.match(/[^。！？]+[。！？]?/g) || []).map(s => s.trim()).filter(Boolean); }
function clip(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/[，、；,;:：\s]+$/, '') + '…' : t; }
function balanced(s) { for (const [o, c] of [['（', '）'], ['(', ')'], ['「', '」'], ['“', '”'], ['《', '》'], ['‘', '’']]) if (s.split(o).length !== s.split(c).length) return false; return true; }
// 太长时在最后一个完整的分句处截断（避免半句话加省略号），括号和引号必须成对；找不到合适位置才退回硬截断
function clauseCut(s, n, strict) {
  if (s.length <= n) return s;
  for (let i = Math.min(n, s.length - 1); i >= 15; i--) {
    if ('；，;,'.includes(s[i]) && balanced(s.slice(0, i))) return s.slice(0, i);
  }
  return strict ? '' : clip(s, n); // strict：切不干净就返回空，由调用方决定省略这一句
}
function firstSentence(t, n, strict) { return clauseCut((sentences(t)[0] || '').replace(/[。！？]+$/, '').trim(), n, strict); }
function endSentence(s) { return !s || /[。！？…]$/.test(s) ? s : s + '。'; }
// 长文本按句子切成每段约 110 字，读起来不压抑
function paragraphize(t, size) {
  const out = []; let cur = '';
  for (const s of sentences(t)) { cur += s; if (cur.length >= size) { out.push(cur); cur = ''; } }
  if (cur) { if (out.length && cur.length < 20) out[out.length - 1] += cur; else out.push(cur); }
  return out;
}

// 「怎么用到我的工作里」：按标题和内容里的关键词判断论文属于哪一类，套对应的具体建议（规则模板，不调用任何模型）
const TOPICS = [
  { re: /监控|安全|攻击|红队|对齐|漏检|越狱|评估|评测|monitor|safety|attack|red.?team|jailbreak|evaluat|benchmark/i, text: '如果我在给自己的 AI 产品做安全或质量自测，可以先用这篇的思路检查一遍：现在用的攻击样本和评测方法够不够强，别测出来的只是测试者的水平。具体做法是把评测拆成「生成方式」和「优化程度」两个维度，各跑几档再看结果的波动；波动越大，之前的单点结论越不能直接当依据。' },
  { re: /agent|智能体|多智能体|工具调用|orchestr/i, text: '对我做的 agent 项目，最直接的用法是把它的设计当检查清单：任务怎么拆、结果由谁来验证、出错后怎么回退。可以挑一个现有流程补上一道验证环节，再对比补之前和补之后的成功率与单次成本，用数据决定要不要推广。' },
  { re: /transformer|loop|预训练|架构|attention|moe|pretrain/i, text: '这篇偏模型架构，适合先小规模复现再决定要不要采用：挑一个 10 亿参数以内的开源模型，按论文设置跑一组对照实验，重点看效率收益和推理延迟能不能同时成立。如果只做应用层，把它当选型参考就行，等开源实现和推理框架支持后再评估成本变化。' },
  { re: /检索|rag|retriev|知识库|记忆|memory/i, text: '放到我的知识库或检索类项目里，可以先拿一批真实的用户问题做对比：同样的数据，分别用现有方案和这篇的思路各跑一遍，看召回的准确度和回答的稳定性。提升明显再考虑改造索引或记忆结构，不明显就先记下来观望。' },
  { re: /视觉|视频|图像|多模态|vision|video|image|multimodal|diffusion/i, text: '放到我的多模态或内容生成类需求里，可以先找几个典型场景试一试：同一批素材分别用现有方案和这篇的方法各出一版，对比质量、速度和单条成本。能明显省钱或提质，再考虑接进正式流程。' },
  { re: /成本|延迟|推理|量化|蒸馏|效率|latency|inference|quantiz|distill/i, text: '对我做的上线产品，这篇最实际的价值在成本和延迟：把它的方法放到自己的真实请求上测一遍，算出每次请求的耗时和费用变化。如果能省下一截，就值得写进下一轮的优化清单。' }
];
const DEFAULT_TOPIC = { text: '可以先把它的核心结论整理成一页笔记，再挑一个最容易验证的点，在我手头的真实任务上做一次小实验。不用追求复现全部结果，只要确认这个思路在自己的数据和场景里有没有明显收益，再决定值不值得投入更多时间。' };
// 先只看标题匹配，匹配不上再看全文，减少被正文里的零星词误导
function pickTopic(title, all) {
  for (const src of [title, all]) for (const t of TOPICS) if (t.re.test(src)) return t;
  return DEFAULT_TOPIC;
}

// 论文：导语 → 为什么值得读 → 核心贡献 → 怎么用到我的工作里 → 原文链接
function composePaper(it) {
  const core = it.contrib || it.summary || it.why;
  const p = [];
  p.push('今天推荐读的一篇论文是《' + it.title + '》' + (it.arxivId ? '（arXiv:' + it.arxivId + '）' : '') + (it.authors ? '，作者：' + it.authors : '') + '。' + (core ? endSentence('它主要讲的是：' + firstSentence(core, 100)) : ''));
  if (it.why) p.push('## 为什么值得读', ...paragraphize(it.why, 110));
  if (it.contrib) p.push('## 核心贡献', ...paragraphize(it.contrib, 110));
  if (!it.why && !it.contrib && it.summary) p.push('## 核心内容', ...paragraphize(it.summary, 110));
  p.push('## 怎么用到我的工作里', pickTopic(it.title, [it.title, it.contrib, it.why, it.summary].join(' ')).text);
  if (it.link) p.push('原文链接：' + it.link);
  return p.join('\n\n');
}

// 「为什么这条适合口播」：1-2 句，按热度判断 + 有无现成金句/切入点来选措辞
function whyVoiceover(it) {
  const h = it.heat || '';
  let a, b;
  if (/起飞前夜|上升期|潜在热度[^；。]{0,8}(极高|高)/.test(h)) a = '它正处在升温阶段，现在发出来有赶早的优势。';
  else if (/高点期|当前热度[^；。]{0,4}高/.test(h)) a = '它已经是公认的热点，观众有现成的关注度，适合快速跟进并加上自己的判断。';
  else a = '话题本身信息量够，用一个具体数字或对比开场就能抓住观众。';
  if (it.quotes) b = '素材里已经带了可直接引用的数据和说法，口播时不用再花时间找素材。';
  else if (it.angle) b = '建议的切入角度是：' + clip(it.angle, 70) + '。';
  else b = /\d/.test(it.summary || '') ? '里面有具体的数字，开口就能给观众一个记忆点。' : '可以挑其中一个细节展开，把一件事讲清楚就够了。';
  return a + b;
}

// 资讯：导语 → 要点展开 → 为什么这条适合口播 → 原文链接
function composeNews(it) {
  const p = [];
  const lead = firstSentence(it.summary || it.why, 90, true); // 切不干净就不写这句结论，「要点展开」里有完整原句
  p.push('今天值得关注的一条资讯：' + it.title + '。' + (it.srcName ? '消息来自' + clip(it.srcName, 30) + '。' : '') + (lead ? endSentence('先说结论：' + lead) : ''));
  const detail = [];
  if (it.summary) detail.push(...paragraphize(it.summary, 110));
  if (it.why) detail.push(...paragraphize(it.why, 110));
  if (it.heat) detail.push('热度判断：' + clip(it.heat, 160));
  const qs = String(it.quotes || '').split('\n').map(s => s.replace(/^[“「]|[”」]$/g, '').trim()).filter(Boolean).slice(0, 3);
  if (qs.length) { detail.push('可以直接引用的数据和说法：'); qs.forEach(q => detail.push('· ' + clip(q, 140))); }
  if (detail.length) p.push('## 要点展开', ...detail);
  p.push('## 为什么这条适合口播', whyVoiceover(it));
  if (it.link) p.push('原文链接：' + it.link);
  return p.join('\n\n');
}

function composeBody(it, tag) { return (tag === 'paper' ? composePaper(it) : composeNews(it)).trim(); }
function makeSummary(it, tag) {
  // 论文：核心贡献首句信息最完整，单独放在列表里也看得懂；「为什么值得读」常以「它给的是…」这类承接句开头，不适合做摘要
  const base = tag === 'paper' ? (it.contrib || it.summary || it.why) : (it.summary || it.why || it.contrib);
  return endSentence(firstSentence(base, 120) || it.title);
}

// ===== 第 4 部分：去重与写入（[[RUN]]）=====
// 扫描 data/posts/ 里已有文章，收集 title / link / 文件名，用来做二次去重
function loadExisting() {
  const titles = new Map(), links = new Map(), ids = new Set();
  if (!fs.existsSync(POSTS_DIR)) return { titles, links, ids };
  for (const f of fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'))) {
    ids.add(f.slice(0, -5));
    try {
      const p = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf-8'));
      if (p && p.title) titles.set(String(p.title).trim(), f);
      if (p && p.link) links.set(String(p.link).trim(), f);
    } catch (e) { /* 坏文件不影响去重，直接忽略 */ }
  }
  return { titles, links, ids };
}

// 核心函数：处理一个日报文件。opts: { source, tag, dryRun, force, limit, verbose, log }
// 返回 { added, skipped, exists, failed, ignored, truncated, items }
function ingestFile(opts) {
  const log = opts.log || console.log;
  const tag = opts.tag, dry = !!opts.dryRun, force = !!opts.force;
  const kindName = tag === 'paper' ? '论文' : '资讯';
  const res = { added: 0, skipped: 0, exists: 0, failed: 0, ignored: 0, truncated: 0, items: [] };
  const source = path.resolve(opts.source);
  const text = fs.readFileSync(source, 'utf-8');
  const date = detectDate(source, text);
  const all = parseMarkdown(text);
  log((dry ? '[试运行] ' : '') + '读取日报：' + path.basename(source) + '（日期 ' + date + '，按「' + kindName + '」处理），共识别出 ' + all.length + ' 个条目');

  let cands = [];
  for (const it of all) {
    if (it.kind !== tag) { res.ignored++; log('忽略（不是' + kindName + '类条目）：' + it.title); continue; }
    if (!it.valid) { res.failed++; res.skipped++; log('SKIP (解析失败)：' + (it.title || '(没有标题)')); continue; }
    cands.push(it);
  }
  if (opts.limit && cands.length > opts.limit) {
    res.truncated = cands.length - opts.limit;
    cands = cands.slice(0, opts.limit);
    log('条目超过单次上限 ' + opts.limit + ' 篇，已截断，丢弃后面 ' + res.truncated + ' 条');
  }

  const ex = loadExisting();
  if (!dry && !fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });
  for (const it of cands) {
    const title = it.title.trim();
    const id = tag + '-' + date + '-' + sha8(title); // 标题 sha1 前 8 位
    const dup = !force && (ex.titles.has(title) || (it.link && ex.links.has(it.link)) || ex.ids.has(id));
    if (dup) { res.exists++; res.skipped++; log('SKIP (exists): ' + title); continue; }
    const post = {
      id, title, date, tag,
      summary: makeSummary(it, tag),
      body: composeBody(it, tag),
      link: it.link || '',
      source: path.basename(source),
      published: true,
      createdAt: new Date().toISOString()
    };
    if (dry) {
      log('[试运行] 将新增：' + id + ' ｜ ' + title);
      log('    摘要：' + post.summary);
      log('    正文：' + post.body.length + ' 字，' + post.body.split(/\n\s*\n/).length + ' 段' + (post.link ? '，链接 ' + post.link : '，没有链接'));
      if (opts.verbose) log(post.body.split('\n').map(l => '      | ' + l).join('\n'));
    } else {
      atomicWrite(path.join(POSTS_DIR, id + '.json'), serializePost(post));
      log('新增：' + id + ' ｜ ' + title);
    }
    ex.titles.set(title, id + '.json'); if (post.link) ex.links.set(post.link, id + '.json'); ex.ids.add(id); // 同一次运行里的重复条目也拦住
    res.added++; res.items.push(post);
  }
  log((dry ? '[试运行] ' : '') + '新增 ' + res.added + ' 篇，跳过 ' + res.skipped + ' 篇（已存在 ' + res.exists + ' / 解析失败 ' + res.failed + '）' + (res.ignored ? '；另有 ' + res.ignored + ' 条不属于' + kindName + '类，已忽略' : ''));
  return res;
}

// ===== 第 5 部分：命令行入口（[[CLI]]）=====
function parseArgs(argv) {
  const a = { source: '', tag: '', dryRun: false, force: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--source') a.source = argv[++i] || '';
    else if (x === '--tag') a.tag = argv[++i] || '';
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--force') a.force = true;
    else if (x === '--verbose') a.verbose = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else { console.error('不认识的参数：' + x); a.bad = true; }
  }
  return a;
}
function usage() {
  console.log('用法：node scripts/ingest.js --source <日报.md> --tag paper|news [--dry-run] [--force] [--verbose]\n' +
    '  --source   cron 产出的日报 markdown 文件\n' +
    '  --tag      paper（论文日报）或 news（口播素材日报）\n' +
    '  --dry-run  试运行：只打印将写入什么，不落盘\n' +
    '  --force    忽略去重，强制写入\n' +
    '  --verbose  试运行时把完整正文也打印出来');
}
function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { usage(); return; }
  if (a.bad || !a.source || !['paper', 'news'].includes(a.tag)) {
    console.error('参数不完整或不正确：必须给出 --source 文件，并且 --tag 只能是 paper 或 news。');
    usage();
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(a.source)) { console.error('找不到日报文件：' + a.source); process.exitCode = 1; return; }
  try {
    const r = ingestFile({ source: a.source, tag: a.tag, dryRun: a.dryRun, force: a.force, verbose: a.verbose });
    if (r.added === 0 && r.skipped === 0) console.error('没有解析出任何可用条目，请检查日报格式是否变化。');
  } catch (e) {
    console.error('处理失败：' + e.message);
    process.exitCode = 1;
  }
}

module.exports = { ingestFile, parseMarkdown, composeBody, makeSummary, sha8, loadExisting, POSTS_DIR };
if (require.main === module) main();
