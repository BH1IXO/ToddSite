// 知识库存储层。零依赖，Node 18+。
// 目录（都在 data/kb/，不进公开仓库）：
//   docs/seg-N.jsonl      切好块的正文，只追加，一行一块 {id, doc, i, t}
//   docs/seg-N.map        每块在段文件里的起始字节（8 字节小端），检索时随机读取，不整段扫
//   docs/manifest.json    分段与块数、全局块号 next
//   docs/docs.jsonl       文档元数据（标题、来源、字数），一行一篇
//   index/seg-N/bK.json   第 N 段索引的第 K 个分片：词 → [[块号, 词频, 块长], ...]
//   index/manifest.json   索引段、总块数、平均块长
//   quarantine/q-N.jsonl  被隔离的段落，等人工复核
//   deleted.txt           已删除的文档 id
// 设计取舍：追加写段；删除记墓碑，检索时过滤，compact() 再真正重写。
// 词表按哈希分 64 片，检索只读命中词所在分片；批量导入每 32 篇合并写一次分片。
const fs = require('fs'), path = require('path');
const { tokens, uniq, hash } = require('./tokenize');

const SHARDS = 64;
const CHUNK_CHARS = 700;     // 单块目标长度，约合中文 400-500 字
const MIN_CHUNK = 120;       // 太短的尾块并进上一块
const TITLE_WEIGHT = 2;      // 标题词额外计入，提高按标题命中
const SEG_MAX_CHUNKS = 20000;
const SEG_MAX_BYTES = 64 * 1024 * 1024;
const BATCH_DOCS = 32;
const K1 = 1.2, B = 0.75;

const jl = a => a.map(x => JSON.stringify(x)).join('\n') + (a.length ? '\n' : '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return d; } };
function writeAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp-' + process.pid;
  fs.writeFileSync(t, data); fs.renameSync(t, f);
}
function readJsonl(f) {
  let raw = ''; try { raw = fs.readFileSync(f, 'utf-8'); } catch (e) { return []; }
  const out = []; for (const l of raw.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (e) {} }
  return out;
}

// 按空行分段，超长段落按句末标点切，再拼成不超过 size 的块
function chunk(text, size) {
  size = size || CHUNK_CHARS;
  const pieces = [];
  for (const p of String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)) {
    if (p.length <= size) { pieces.push(p); continue; }
    let buf = '';
    for (const s of p.split(/(?<=[。！？!?；;])\s*/)) {
      let rest = s;
      while (rest.length > size) { if (buf) { pieces.push(buf); buf = ''; } pieces.push(rest.slice(0, size)); rest = rest.slice(size); }
      if (buf && buf.length + rest.length > size) { pieces.push(buf); buf = ''; }
      buf += rest;
    }
    if (buf) pieces.push(buf);
  }
  const out = []; let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > size) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) {
    if (out.length && cur.length < MIN_CHUNK) out[out.length - 1] += '\n\n' + cur; else out.push(cur);
  }
  return out;
}

function open(root) {
  const DIR = root;
  const D = path.join(DIR, 'docs'), I = path.join(DIR, 'index'), Q = path.join(DIR, 'quarantine');
  fs.mkdirSync(D, { recursive: true }); fs.mkdirSync(I, { recursive: true });
  const segFile = n => path.join(D, 'seg-' + n + '.jsonl');
  const mapFile = n => path.join(D, 'seg-' + n + '.map');
  const docsMeta = () => readJsonl(path.join(D, 'docs.jsonl'));
  const docMan = () => readJson(path.join(D, 'manifest.json'), { segs: [], next: 0 });
  const idxMan = () => readJson(path.join(I, 'manifest.json'), { segs: [], chunks: 0, avgdl: 1 });
  const dead = () => { try { return new Set(fs.readFileSync(path.join(DIR, 'deleted.txt'), 'utf-8').split('\n').filter(Boolean)); } catch (e) { return new Set(); } };
  const fsize = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };

  // 批量入库：每批 32 篇只写一次段文件和分片；返回与输入一一对应的结果
  function addMany(docs) {
    const results = new Array(docs.length), metas = [];
    for (let s = 0; s < docs.length; s += BATCH_DOCS) {
      const slice = docs.slice(s, s + BATCH_DOCS);
      const dm = docMan(), im = idxMan();
      let seg = dm.segs[dm.segs.length - 1];
      if (!seg || seg.chunks >= SEG_MAX_CHUNKS || fsize(segFile(seg.n)) >= SEG_MAX_BYTES) {
        seg = { n: seg ? seg.n + 1 : 1, chunks: 0 };
        dm.segs.push(seg);
      }
      const base = dm.next || 0;
      const rows = [], shards = new Map();
      let cursor = base, lenSum = 0;
      slice.forEach((doc, j) => {
        const texts = chunk(doc.text);
        if (!texts.length) { results[s + j] = { ok: false, error: '正文为空' }; return; }
        const titleTok = tokens(doc.title || '');
        for (const t of texts) {
          const tf = new Map();
          const add = tk => tf.set(tk, (tf.get(tk) || 0) + 1);
          tokens(t).forEach(add);
          for (let w = 0; w < TITLE_WEIGHT; w++) titleTok.forEach(add);
          rows.push({ id: cursor, doc: doc.id, i: cursor - base, t });
          const len = Array.from(tf.values()).reduce((a, b) => a + b, 0); lenSum += len;
          for (const [tk, n] of tf) {
            const k = hash(tk) % SHARDS;
            if (!shards.has(k)) shards.set(k, []);
            shards.get(k).push([tk, cursor, n, len]);
          }
          cursor++;
        }
        results[s + j] = { ok: true, id: doc.id, chunks: texts.length, chars: doc.text.length };
        metas.push({ id: doc.id, title: doc.title || '', kind: doc.kind || '', src: doc.src || '', date: doc.date || '', chars: doc.text.length, chunks: texts.length, status: 'ready', addedAt: new Date().toISOString() });
      });
      if (!rows.length) continue;
      // 先正文与偏移，再索引，最后 manifest：中途失败最多留孤儿数据，不会让检索读到错位的结果
      let pos = fsize(segFile(seg.n));
      const offs = Buffer.alloc(8 * rows.length), body = [];
      rows.forEach((r, i) => { const line = JSON.stringify(r) + '\n'; offs.writeBigUInt64LE(BigInt(pos), i * 8); pos += Buffer.byteLength(line); body.push(line); });
      fs.appendFileSync(segFile(seg.n), body.join(''));
      fs.appendFileSync(mapFile(seg.n), offs);
      for (const [k, list] of shards) {
        const f = path.join(I, 'seg-' + seg.n, 'b' + k + '.json');
        const cur = readJson(f, {});
        for (const [tk, cid, n, len] of list) (cur[tk] = cur[tk] || []).push([cid, n, len]);
        writeAtomic(f, JSON.stringify(cur));
      }
      seg.chunks += rows.length;
      dm.next = base + rows.length;
      writeAtomic(path.join(D, 'manifest.json'), JSON.stringify(dm));
      const idxSeg = im.segs.find(x => x.n === seg.n);
      if (idxSeg) idxSeg.chunks += rows.length; else im.segs.push({ n: seg.n, chunks: rows.length });
      const total = im.segs.reduce((a, x) => a + x.chunks, 0), prev = im.chunks || 0;
      im.chunks = total;
      im.avgdl = total ? ((im.avgdl || 1) * prev + lenSum) / total : 1;
      writeAtomic(path.join(I, 'manifest.json'), JSON.stringify(im));
    }
    if (metas.length) {
      const keep = docsMeta().filter(x => !metas.some(m => m.id === x.id));
      writeAtomic(path.join(D, 'docs.jsonl'), jl(keep.concat(metas)));
    }
    return results;
  }
  const addDoc = doc => addMany([doc])[0];

  function quarantine(item) {
    fs.mkdirSync(Q, { recursive: true });
    const n = readJson(path.join(Q, 'manifest.json'), { n: 0 }).n + 1;
    fs.appendFileSync(path.join(Q, 'q-' + n + '.jsonl'), jl([item]));
    writeAtomic(path.join(Q, 'manifest.json'), JSON.stringify({ n }));
  }
  const quarantined = () => { try { return fs.readdirSync(Q).filter(f => f.endsWith('.jsonl')).flatMap(f => readJsonl(path.join(Q, f))); } catch (e) { return []; } };

  // 按偏移随机读块；老段没有 .map 时退回整段读（只影响升级前的数据）
  function readChunks(segs, baseOf, wanted) {
    const got = new Map();
    for (const [n, locals] of wanted) {
      const sf = segFile(n), mf = mapFile(n);
      const hasMap = fs.existsSync(mf);
      let fd = null, mfd = null;
      try {
        fd = fs.openSync(sf, 'r');
        if (hasMap) mfd = fs.openSync(mf, 'r');
        const sorted = Array.from(locals).sort((a, b) => a - b);
        for (let idx = 0; idx < sorted.length; idx++) {
          const local = sorted[idx];
          let start, end;
          if (hasMap) {
            const b = Buffer.alloc(8);
            if (fs.readSync(mfd, b, 0, 8, local * 8) !== 8) continue;
            start = Number(b.readBigUInt64LE(0));
            const nb = Buffer.alloc(8);
            end = fs.readSync(mfd, nb, 0, 8, (local + 1) * 8) === 8 ? Number(nb.readBigUInt64LE(0)) : fsize(sf);
          } else {
            // 兼容：整段读一次，按行号挑
            if (!got.has('_raw' + n)) got.set('_raw' + n, fs.readFileSync(sf, 'utf-8').split('\n'));
            const line = got.get('_raw' + n)[local];
            if (!line) continue;
            try { const o = JSON.parse(line); got.set(o.id, o); } catch (e) {}
            continue;
          }
          const len = end - start;
          if (len <= 0 || len > 4 * 1024 * 1024) continue;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          try { const o = JSON.parse(buf.toString('utf-8')); got.set(o.id, o); } catch (e) {}
        }
      } catch (e) {} finally {
        if (fd !== null) try { fs.closeSync(fd); } catch (e) {}
        if (mfd !== null) try { fs.closeSync(mfd); } catch (e) {}
      }
    }
    return got;
  }

  function search(q, k) {
    k = Math.max(1, Math.min(20, k || 5));
    const terms = uniq(tokens(q)).slice(0, 64);
    const im = idxMan();
    if (!terms.length || !im.chunks) return [];
    const gone = dead(), N = im.chunks, avgdl = im.avgdl || 1;
    const scores = new Map(), matched = new Map();
    for (const term of terms) {
      const shard = hash(term) % SHARDS, postings = [];
      for (const seg of im.segs) {
        const cur = readJson(path.join(I, 'seg-' + seg.n, 'b' + shard + '.json'), null);
        if (cur && cur[term]) for (const p of cur[term]) postings.push(p);
      }
      if (!postings.length) continue;
      const idf = Math.log(1 + (N - postings.length + 0.5) / (postings.length + 0.5));
      for (const [cid, tf, len] of postings) {
        scores.set(cid, (scores.get(cid) || 0) + idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * len / avgdl)));
        if (!matched.has(cid)) matched.set(cid, []);
        matched.get(cid).push(term);
      }
    }
    const segs = docMan().segs, baseOf = {}; let off = 0;
    for (const s of segs) { baseOf[s.n] = off; off += s.chunks; }
    const segOf = cid => segs.find(x => cid >= baseOf[x.n] && cid < baseOf[x.n] + x.chunks);
    const top = Array.from(scores.entries()).filter(([cid]) => !!segOf(cid)).sort((a, b) => b[1] - a[1]).slice(0, k * 3);
    const wanted = new Map();
    for (const [cid] of top) {
      const s = segOf(cid);
      if (!wanted.has(s.n)) wanted.set(s.n, new Set());
      wanted.get(s.n).add(cid - baseOf[s.n]);
    }
    const got = readChunks(segs, baseOf, wanted);
    const metas = new Map(docsMeta().map(x => [x.id, x]));
    const hits = [];
    for (const [cid, sc] of top) {
      const o = got.get(cid); if (!o || gone.has(o.doc)) continue;
      hits.push({ score: Math.round(sc * 1000) / 1000, chunk: cid, doc: o.doc, title: (metas.get(o.doc) || {}).title || '', terms: matched.get(cid), text: o.t });
      if (hits.length >= k) break;
    }
    return hits;
  }

  const list = () => docsMeta().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  function stats() {
    const im = idxMan(), dm = docMan();
    let bytes = 0;
    for (const d of [D, I]) { try { for (const f of fs.readdirSync(d, { recursive: true })) { try { bytes += fs.statSync(path.join(d, f)).size; } catch (e) {} } } catch (e) {} }
    return { docs: docsMeta().length, chunks: im.chunks || 0, segs: dm.segs.length, indexSegs: (im.segs || []).length, avgdl: Math.round(im.avgdl || 0), bytes };
  }
  function remove(id) {
    const metas = docsMeta();
    if (!metas.some(x => x.id === id)) return { ok: false, error: '没有这篇：' + id };
    fs.appendFileSync(path.join(DIR, 'deleted.txt'), id + '\n');
    writeAtomic(path.join(D, 'docs.jsonl'), jl(metas.filter(x => x.id !== id)));
    return { ok: true, id };
  }
  const has = id => docsMeta().some(x => x.id === id);

  // 真正重写：没删的块重新切、重新索引，换新段后删旧文件。文档多时是整库重建。
  function compact() {
    const all = docsMeta(), gone = dead(), dm = docMan();
    const chunksAll = new Map();
    for (const s of dm.segs) {
      let raw = ''; try { raw = fs.readFileSync(segFile(s.n), 'utf-8'); } catch (e) { continue; }
      for (const l of raw.split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (!gone.has(o.doc)) chunksAll.set(o.id, o); } catch (e) {} }
    }
    fs.rmSync(D, { recursive: true, force: true }); fs.rmSync(I, { recursive: true, force: true });
    fs.rmSync(path.join(DIR, 'deleted.txt'), { force: true });
    fs.mkdirSync(D, { recursive: true }); fs.mkdirSync(I, { recursive: true });
    const docs = [];
    for (const m of all) {
      const rows = Array.from(chunksAll.values()).filter(o => o.doc === m.id).sort((a, b) => a.i - b.i);
      if (!rows.length) continue;
      docs.push({ id: m.id, title: m.title, kind: m.kind, src: m.src, date: m.date, text: rows.map(r => r.t).join('\n\n') });
    }
    addMany(docs);
    return stats();
  }

  return { addDoc, addMany, quarantine, quarantined, search, list, stats, remove, has, compact, chunk, DIR };
}

module.exports = { open, chunk, SHARDS };
