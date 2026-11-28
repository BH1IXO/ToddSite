// 分词：零依赖。中文取相邻二字组（bigram），整段只有一个字时保留单字；英文数字按词；统一小写。
// 不用词典分词：语料大了词典会漏词、还要维护；bigram 对中文召回稳，BM25 的 IDF 会自动压低“的是”这类满地都是的组合。
const RE = /[一-龥]+|[a-z0-9][a-z0-9._+#-]*/g;
const CJK = /^[一-龥]/;

function tokens(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  const out = [];
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(s))) {
    const w = m[0];
    if (CJK.test(w)) {
      const cs = Array.from(w);
      if (cs.length === 1) out.push(cs[0]);
      for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i] + cs[i + 1]);
    } else {
      const t = w.replace(/[._+#-]+$/, '');
      if (t) out.push(t);
    }
  }
  return out;
}

// 去重并保持顺序（查询词用）
function uniq(arr) { return Array.from(new Set(arr)); }

// 词 → 分片号用的哈希（FNV-1a）。写索引和查询必须是同一个函数。
function hash(term) {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++) { h ^= term.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

module.exports = { tokens, uniq, hash };
