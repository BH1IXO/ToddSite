// 事实提炼：把对话里的稳定信息抽出来，而不是存聊天流水。
// 只提取"关于对方是谁、关心什么、处在什么位置"，绝不记录姓名、公司名、电话等可识别信息。
const EXTRACT_SYS = `你是一个信息提炼器。从对话片段里提取关于【对方（访客）】的稳定事实。

严格规则：
1. 只提取：他的身份类型（行业/岗位/角色）、他的处境（公司阶段/手上项目/遇到什么困难）、他关心什么、他对刘涛的态度或意向阶段。
2. 绝不提取任何可识别个人的信息：真实姓名、具体公司名、手机号、微信、邮箱、住址、证件号。如果对方说了，把它泛化成类型，例如"某制造业公司"→"制造业"，"我叫张三"→丢弃。
3. 不提取：提问本身、寒暄、客套、刘涛回答的内容。
4. 只提取有长期价值的信息。一次性的细节（"帮我改个错别字"）不算。
5. 每条 value 控制在 30 字以内，用陈述句，第三人称。

输出格式：只输出 JSON，不要任何解释文字。
{"facts":[{"k":"身份|处境|关注|态度","v":"一句话","conf":0.0到1.0的置信度}]}
没有值得记的事实就输出 {"facts":[]}`;

function buildExtractPrompt(turns) {
  const txt = turns.map(t => (t.role === 'user' ? '对方：' : '刘涛：') + String(t.content).slice(0, 500)).join('\n');
  return { system: EXTRACT_SYS, user: '对话片段：\n' + txt + '\n\n请输出 JSON。' };
}

// 从模型回复里挖出 JSON（容忍被包了 ```json 或者前后有多余话）
function parseFacts(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return [];
  try {
    const o = JSON.parse(s.slice(i, j + 1));
    const arr = Array.isArray(o) ? o : (Array.isArray(o.facts) ? o.facts : []);
    return arr.filter(x => x && x.k && x.v).map(x => ({
      k: String(x.k).slice(0, 8),
      v: String(x.v).slice(0, 80),
      conf: Math.max(0, Math.min(1, Number(x.conf) || 0.6)),
    }));
  } catch (e) { return []; }
}

// 调用 DeepSeek 做一次提炼（非流式，短请求，失败就静默返回空）
async function extractFacts({ url, key, model, turns, timeout = 25000 }) {
  if (!key || !Array.isArray(turns) || turns.length < 2) return [];
  const { system, user } = buildExtractPrompt(turns);
  try {
    const up = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model, stream: false, max_tokens: 600, temperature: 0.1,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!up.ok) return [];
    const j = await up.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return parseFacts(text);
  } catch (e) { return []; }
}

module.exports = { EXTRACT_SYS, buildExtractPrompt, parseFacts, extractFacts };
