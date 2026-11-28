// 流式输出分块：上游模型按 token 吐字（"Web"、"3" 这种碎片），这里攒成整句或整短语再往外送。
// 切点只落在标点上：句末标点优先，句子太长才退到逗号/顿号，实在没有标点才在安全位置硬切。
// 标点两侧不会是电话、邮箱、微信号的一部分，所以按标点切开再逐块脱敏，不会把联系方式劈成两半漏出去。
'use strict';

const STRONG = new Set(['。', '！', '？', '；', '!', '?', ';', '\n', '…']);
const WEAK = new Set(['，', '、', ',']);
// 句末标点后面紧跟的收尾符号，跟前一句一起送出
const CLOSERS = new Set(['”', '’', '"', "'", '）', ')', '】', '」', '』', '》', ']', '*']);
// 硬切时两侧都不能是这些字符：英文单词、数字、邮箱/电话/微信号里会出现的符号
const WORDISH = /[A-Za-z0-9@._%+\-:：=#/]/;

function create(opts) {
  const o = Object.assign({ minSentence: 8, minPhrase: 16, phraseAt: 36, hardAt: 160, hardTail: 60 }, opts);
  const redact = typeof o.redact === 'function' ? o.redact : (s => s);
  const emit = o.emit;
  let pending = '';

  // 从 i 开始吞掉连续的标点和收尾符号，返回切点（不含）；切点必须后面还有字，才能确认收尾符号已经到齐
  const runEnd = (s, i) => { let j = i + 1; while (j < s.length && (STRONG.has(s[j]) || CLOSERS.has(s[j]))) j++; return j; };
  // 英文句点只有后面跟空白才算句末（避开 3.5、e.g、邮箱里的点）
  const isStrong = (s, i) => STRONG.has(s[i]) || (s[i] === '.' && /\s/.test(s[i + 1] || '') && !/[0-9]/.test(s[i - 1] || ''));

  function findCut(s) {
    let strong = -1, weak = -1;
    for (let i = 0; i < s.length; i++) {
      if (isStrong(s, i)) {
        const j = runEnd(s, i);
        if (j < s.length && j >= o.minSentence) strong = j;
        i = j - 1;
      } else if (WEAK.has(s[i]) && i + 1 < s.length && i + 1 >= o.minPhrase) weak = i + 1;
    }
    if (strong > 0) return strong;
    if (s.length >= o.phraseAt && weak > 0) return weak;
    return -1;
  }

  // 没有任何标点的长串：留一段尾巴，在不劈开英文单词/数字/联系方式的位置切
  function hardCut(s) {
    if (s.length < o.hardAt) return -1;
    for (let i = s.length - o.hardTail; i > 0; i--) {
      if (/\s/.test(s[i - 1])) { if (!/\s/.test(s[i])) return i; continue; }
      if (!WORDISH.test(s[i - 1]) && !WORDISH.test(s[i]) && !/\s/.test(s[i])) return i;
    }
    return -1;
  }

  function send(piece) { const out = redact(piece); if (out) emit(out); }

  return {
    push(t) {
      if (!t) return;
      pending += t;
      for (;;) {
        let cut = findCut(pending);
        if (cut < 0 && pending.length >= o.hardAt) {
          // 硬切前先对整段待发内容脱敏，已经完整的联系方式（含住址）不会被切点劈开
          pending = redact(pending);
          cut = hardCut(pending);
        }
        if (cut <= 0) break;
        const piece = pending.slice(0, cut); pending = pending.slice(cut);
        send(piece);
      }
    },
    end() { if (pending) send(pending); pending = ''; },
  };
}

module.exports = { create };
