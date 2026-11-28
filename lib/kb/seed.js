// 种子：把网站上已经公开的内容整理成知识库文档。命令行 seed 和空库自动灌入共用这一份。
const fs = require('fs'), path = require('path');

function fromSite(root) {
  const read = f => fs.readFileSync(f, 'utf-8');
  const docs = [];
  const site = JSON.parse(read(path.join(root, 'data', 'site.json')));
  const p = site.profile || {};
  docs.push({ id: 'site-profile', title: '个人简介', kind: '简介', trust: 'public', text: [p.headline, p.intro].filter(Boolean).join('\n\n') });
  if ((site.facts || []).length) docs.push({ id: 'site-facts', title: '身份与经历要点', kind: '履历', trust: 'public', text: site.facts.map(f => (f.k ? f.k + '：' : '') + f.v).join('\n') });
  for (const ar of site.workAreas || []) {
    const items = (ar.items || []).map(i => '- ' + i.name + '：' + (i.desc || '') + (i.url ? '（' + i.url + '）' : '')).join('\n');
    docs.push({ id: 'area-' + (ar.key || ar.title), title: ar.title, kind: ar.kind || '方向', trust: 'public', text: [ar.desc, (ar.points || []).length ? '要点：' + ar.points.join('、') : '', items].filter(Boolean).join('\n\n') });
  }
  const cg = site.courses ? (Array.isArray(site.courses.groups) ? site.courses.groups : [site.courses]) : [];
  for (const g of cg) docs.push({ id: 'course-' + (g.id || g.title), title: g.title, kind: '课程', trust: 'public', text: [g.subtitle, g.audience ? '适合：' + g.audience : '', (g.lessons || []).map(l => '第' + l.no + '讲 ' + l.title + ((l.points || []).length ? '：' + l.points.join('；') : '')).join('\n')].filter(Boolean).join('\n\n') });
  if ((site.offers || []).length) docs.push({ id: 'site-offers', title: '合作方式', kind: '合作', trust: 'public', text: site.offers.map(o => o.title + '：' + o.desc).join('\n\n') });
  if ((site.life || []).length) docs.push({ id: 'site-life', title: '生活', kind: '生活', trust: 'public', text: site.life.map(o => o.title + '：' + o.desc).join('\n\n') });
  const dir = path.join(root, 'data', 'posts');
  let files = [];
  try { files = fs.readdirSync(dir).filter(x => x.endsWith('.json')); } catch (e) {}
  for (const f of files) {
    let post; try { post = JSON.parse(read(path.join(dir, f))); } catch (e) { continue; }
    if (!post || post.published === false || !post.title) continue;
    docs.push({
      id: 'post-' + post.id, title: post.title, kind: '文章', date: post.date || '', trust: 'public',
      text: (post.summary || '') + '\n\n' + String(post.body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim(),
    });
  }
  return docs;
}

module.exports = { fromSite };
