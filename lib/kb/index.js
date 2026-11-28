// 知识库对外接口：入库（清洗 → 隔离 → 建索引）、检索、给提示词取上下文、响应脱敏。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const store = require('./store');
const san = require('./sanitize');

const MAX_DOC_CHARS = 8 * 1024 * 1024; // 单篇 8MB 上限，防误传超大文件把进程拖死
const MAX_CTX_CHARS = 2600;             // 拼进提示词的资料上限，控制 token 成本

function makeId(title) {
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const h = crypto.createHash('sha1').update(String(title || '') + Date.now()).digest('hex').slice(0, 6);
  return (slug || 'doc') + '-' + h;
}

function open(dir) {
  const S = store.open(dir);
  const priv = path.join(dir, 'private');
  fs.mkdirSync(priv, { recursive: true });
  try { fs.writeFileSync(path.join(priv, 'blocklist.txt'), fs.existsSync(path.join(priv, 'blocklist.txt')) ? fs.readFileSync(path.join(priv, 'blocklist.txt')) : '# 每行一个真实客户/机构名，入库时替换成“某客户”。这个文件不进仓库。\n'); } catch (e) {}
  try { fs.writeFileSync(path.join(priv, 'allowlist.txt'), fs.existsSync(path.join(priv, 'allowlist.txt')) ? fs.readFileSync(path.join(priv, 'allowlist.txt')) : '# 可以公开出现的单位名，每行一个。不写就用代码里的默认三条。\n'); } catch (e) {}
  const guard = san.create(priv);

  // 批量入库：逐篇清洗，合批写索引。结果与输入一一对应
  function addMany(docs) {
    const results = new Array(docs.length), prepared = [], prepIdx = [];
    docs.forEach((doc, i) => {
      if (!doc || typeof doc !== 'object') { results[i] = { ok: false, error: '格式不对' }; return; }
      const text = String(doc.text || '').replace(/\r\n?/g, '\n').trim();
      if (!String(doc.title || '').trim() || !text) { results[i] = { ok: false, error: '标题和正文都不能为空' }; return; }
      if (text.length > MAX_DOC_CHARS) { results[i] = { ok: false, error: '单篇超过 ' + (MAX_DOC_CHARS / 1048576) + 'MB' }; return; }
      const trust = ['public', 'chat', 'note', 'unknown'].includes(doc.trust) ? doc.trust : 'unknown';
      const title = guard.redact(String(doc.title || ''));
      const c = guard.clean(text, { trust });
      const id = String(doc.id || makeId(title)).replace(/[^a-z0-9一-龥-]/gi, '-').slice(0, 64);
      if (!c.text.trim()) {
        const reasons = Array.from(new Set(c.quarantined.flatMap(q => q.reasons)));
        S.quarantine({ id, title, src: doc.src || '', at: new Date().toISOString(), reasons, chunks: c.quarantined });
        results[i] = { ok: false, quarantined: true, id, reasons, error: '整篇被隔离，未入库' };
        return;
      }
      prepared.push({ id, title, kind: doc.kind || '', src: doc.src || '', date: doc.date || '', text: c.text });
      prepIdx.push(i);
      results[i] = { pending: true, meta: { before: text.length, kept: c.text.length, hits: c.hits, quarantinedParas: c.quarantined.length }, quarantine: c.quarantined.length ? { id, title, src: doc.src || '', at: new Date().toISOString(), chunks: c.quarantined } : null };
    });
    const stored = prepared.length ? S.addMany(prepared) : [];
    prepIdx.forEach((i, j) => {
      const pending = results[i];
      const r = Object.assign({}, stored[j]), m = pending.meta;
      if (r.ok) Object.assign(r, { kept: m.kept, trimmed: m.before - m.kept, redactions: m.hits, quarantinedParas: m.quarantinedParas });
      results[i] = r;
      if (pending.quarantine) S.quarantine(pending.quarantine);
    });
    return results;
  }

  // 入库：单篇，复用批量实现
  const add = doc => addMany([doc])[0];

  const search = (q, k) => S.search(q, k).map(h => Object.assign(h, { title: guard.redact(h.title || ''), text: guard.redact(h.text) }));
  const redact = (t) => guard.redact(t);

  // 提示词用：检索 + 截断到预算内，带上出处标题
  function context(q, k) {
    const hits = search(q, k || 6);
    const out = []; let used = 0;
    for (const h of hits) {
      const piece = '· ' + (h.title ? '【' + h.title + '】' : '') + h.text.trim();
      if (used + piece.length > MAX_CTX_CHARS) {
        const room = MAX_CTX_CHARS - used;
        if (room > 80) out.push(piece.slice(0, room) + '…');
        break;
      }
      out.push(piece); used += piece.length;
    }
    return { block: out.join('\n'), hits: hits.length };
  }

  return { add, addMany, search, context, redact, list: S.list, stats: S.stats, remove: S.remove, has: S.has, quarantined: S.quarantined, compact: S.compact, dir };
}

module.exports = { open, makeId };
