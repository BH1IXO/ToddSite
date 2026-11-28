// 入库前的敏感信息隔离。零依赖，规则都在这个文件里，仓库里不放任何真实名单。
// 两层处理：
//  1) 原地抹掉：联系方式、证件号、卡号、住址、密钥，以及你自己维护的真实客户名单（data/kb/private/blocklist.txt，不进仓库）。
//  2) 整段隔离：整段读下来属于私事、对他人的评价、未公开商业信息的，不进检索库，放进隔离区等人工复核。
// 已经公开的内容（网站正文、已发布文章）传 trust=public，只做第 1 层；聊天记录等来源默认两层都做。
const fs = require('fs'), path = require('path');
const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
const readList = f => { try { return fs.readFileSync(f, 'utf-8').split(NL).map(s => s.trim()).filter(s => s && s[0] !== '#'); } catch (e) { return []; } };

// 顺序有讲究：证件号先于卡号，卡号先于其他数字类
const PII = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:[.][A-Za-z0-9-]+)+/g, '[邮箱已移除]'],
  ['证件号', /(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g, '[证件号已移除]'],
  ['手机', /(?<![0-9])(?:[+]?86[- ]?)?1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}(?![0-9])/g, '[电话已移除]'],
  ['座机', /(?<![0-9])0[0-9]{2,3}[- ][0-9]{7,8}(?![0-9])/g, '[电话已移除]'],
  ['卡号', /(?<![0-9])[0-9]{16,19}(?![0-9])/g, '[卡号已移除]'],
  ['微信', /(?:微信|wechat|weixin|vx|wx)(?:号|id)?[ ]*[:：=][ ]*[A-Za-z][A-Za-z0-9_-]{5,19}/gi, '[微信已移除]'],
  ['QQ', /QQ(?:号)?[ ]*[:：=][ ]*[0-9]{5,12}/gi, '[QQ已移除]'],
  ['住址', /[一-龥]{2,}(?:省|市|区|县)[一-龥0-9]{1,20}(?:路|街|道|巷|弄)[0-9]+号[一-龥0-9-]{0,12}/g, '[住址已移除]'],
];
// 密钥：英文赋值形式必须带足够长的值；中文只认“密码/口令”这类明确说法。
// 不把裸的 token 当关键词，否则 “Token 经济：……” 这种公开课程内容会被误判。
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|Bearer[ ]+[A-Za-z0-9._-]{20,}|(?:密码|口令)\s*[:：=]\s*\S{6,}|(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token)\s*[:：=]\s*\S{6,}|(?:token|密钥)\s*[:：=]\s*[A-Za-z0-9._-]{16,})/i;
const SECRET_G = new RegExp(SECRET.source, 'gi');

// [标签, 正则, 公开内容也要查吗]。宁可多隔离：被隔离的段落可以在隔离区人工放行。
const RULES = [
  ['私事', /(?:离婚|出轨|前妻|前夫|女朋友|男朋友|老婆|妻子|丈夫|岳父|岳母|爸爸|妈妈|父亲|母亲|儿子|女儿|住院|确诊|抑郁|病历|体检报告|房贷|车贷|负债|欠款|存款|工资|月薪|年薪|私下说|别告诉|不要外传)/, false],
  ['评价他人', /(?:他|她|这个人|此人|对方|[一-龥]{2,3}(?:总|经理|老师|老板))[^。！？!?；;]{0,14}(?:很蠢|太蠢|傻|垃圾|废物|不靠谱|不专业|能力差|能力不行|水平差|水平低|甩锅|小人|虚伪|心机|忽悠|骗子|无能|画饼|看不上|瞧不起)/, false],
  ['未公开商业信息', /(?:未公开|未发布|尚未公开|尚未发布|保密|机密|内部资料|内部数据|内部消息|NDA|融资额|融资条款|估值|营收|利润|毛利|合同金额|合同价|报价|中标|签约金额|回款|股权比例|股权结构|期权池|cap table)/i, false],
];
const MARKERS = ['[私密]', '[内部]', '#private', '#内部']; // 你自己手动标的，公开来源也认
const ORG = /[一-龥A-Za-z0-9]{2,12}(?:股份有限公司|有限责任公司|有限公司|集团|银行|医院|研究院|研究所)/g;
const CLIENT_CTX = /(?:客户|甲方|乙方|合同|签约|交付|服务了|落地在|合作方|项目方)/;

function paragraphs(text) {
  const out = []; let cur = [];
  for (const line of String(text || '').split(NL)) {
    if (line.trim() === '') { if (cur.length) out.push(cur.join(NL)); cur = []; }
    else cur.push(line.split(CR).join(''));
  }
  if (cur.length) out.push(cur.join(NL));
  return out;
}

function create(privDir) {
  let cache = null, at = 0;
  const lists = () => { // 名单文件很小，5 秒缓存一次，改了名单不用重启
    if (cache && Date.now() - at < 5000) return cache;
    at = Date.now();
    return (cache = {
      block: readList(path.join(privDir, 'blocklist.txt')).sort((a, b) => b.length - a.length),
      allow: ['世纪互联', 'Zen7', '上海财经大学'].concat(readList(path.join(privDir, 'allowlist.txt'))),
    });
  };

  // 只抹可识别信息，不做整段判断。聊天接口输出口也复用它。
  function redact(text, hits) {
    hits = hits || {};
    const bump = (k, n) => { hits[k] = (hits[k] || 0) + n; };
    let s = String(text || '');
    for (const name of lists().block) {
      const n = s.split(name).length - 1;
      if (n) { s = s.split(name).join('某客户'); bump('客户名', n); }
    }
    for (const [k, re, rep] of PII) s = s.replace(re, () => { bump(k, 1); return rep; });
    return s;
  }

  // 客户语境里出现的机构名（不在白名单）一律泛化，白名单放你自己公开的单位
  function orgs(p, hits) {
    if (!CLIENT_CTX.test(p)) return p;
    const allow = lists().allow;
    return p.replace(ORG, m => {
      if (allow.some(a => m.includes(a))) return m;
      hits['机构名'] = (hits['机构名'] || 0) + 1;
      return '某机构';
    });
  }

  function clean(text, opt) {
    const trust = (opt && opt.trust) || 'unknown';
    const hits = {}, kept = [], quarantined = [];
    for (const raw of paragraphs(text)) {
      const reasons = [];
      // 公开内容里的机构名照原样保留；只有非公开来源才把“客户语境里的机构”泛化
      let p = redact(raw, hits);
      if (trust !== 'public') p = orgs(p, hits);
      if (SECRET.test(p)) { reasons.push('密钥'); p = p.replace(SECRET_G, '[密钥已移除]'); }
      if (MARKERS.some(k => p.toLowerCase().includes(k.toLowerCase()))) reasons.push('标记为私密');
      if (trust !== 'public') for (const [label, re] of RULES) if (re.test(p)) reasons.push(label);
      if (reasons.length) quarantined.push({ text: p, reasons }); else kept.push(p);
    }
    return { text: kept.join(NL + NL), quarantined, hits };
  }
  return { clean, redact };
}

module.exports = { create, paragraphs, PII };
