(function(){
var K='lt-palette',M='lt-mode';
var P=[['mono','极简黑白','#111111'],['ocean','海洋','#0A6CBF'],['forest','森林','#2F7D4F'],['sunset','日落','#E4572E'],['violet','紫罗兰','#6B3FD4'],['paper','纸本','#8A5A2B']];
var r=document.documentElement,mq=window.matchMedia('(prefers-color-scheme: dark)');
function get(k,d){try{return localStorage.getItem(k)||d}catch(e){return d}}
function set(k,v){try{localStorage.setItem(k,v)}catch(e){}}
var pal=get(K,'mono'),md=get(M,'system');
if(!P.some(function(x){return x[0]===pal}))pal='mono';
function eff(){return md==='dark'||md==='light'?md:(mq.matches?'dark':'light')}
function apply(){if(md==='system')r.removeAttribute('data-theme');else r.setAttribute('data-theme',md);r.setAttribute('data-palette',pal);r.setAttribute('data-mode',eff())}
apply();
if(mq.addEventListener)mq.addEventListener('change',apply);
function build(){
var box=document.createElement('div');box.className='theme-fab';
var b=document.createElement('button');b.type='button';b.className='tf-btn';b.textContent='主题';b.setAttribute('aria-expanded','false');
var pn=document.createElement('div');pn.className='tf-panel';pn.hidden=true;
function draw(){pn.textContent='';
P.forEach(function(x){var o=document.createElement('button');o.type='button';o.className='tf-opt'+(x[0]===pal?' on':'');var d=document.createElement('i');d.style.background=x[2];o.appendChild(d);o.appendChild(document.createTextNode(x[1]));o.onclick=function(){pal=x[0];set(K,pal);apply();draw()};pn.appendChild(o)});
var row=document.createElement('div');row.className='tf-row';
[['system','跟随系统'],['light','浅色'],['dark','深色']].forEach(function(m){var o=document.createElement('button');o.type='button';o.className='tf-opt'+(m[0]===md?' on':'');o.textContent=m[1];o.onclick=function(){md=m[0];set(M,md);apply();draw()};row.appendChild(o)});
pn.appendChild(row)}
draw();
b.onclick=function(){pn.hidden=!pn.hidden;b.setAttribute('aria-expanded',String(!pn.hidden))};
box.appendChild(pn);box.appendChild(b);document.body.appendChild(box)}
if(document.body)build();else document.addEventListener('DOMContentLoaded',build);
})();
