(function(){
'use strict';
var TABS=[{id:'wechat',name:'微信',src:'/pay/wechat.png',hint:'打开微信，扫一扫'},{id:'alipay',name:'支付宝',src:'/pay/alipay.png',hint:'打开支付宝，扫一扫'}];
var CSS=''
+'.tip-ov{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}'
+'.tip-ov[hidden]{display:none}'
+'.tip-box{position:relative;width:100%;max-width:340px;max-height:100%;overflow-y:auto;background:var(--card,var(--bg));color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:22px 20px 18px;box-shadow:0 20px 50px -20px rgba(0,0,0,.5);font-family:var(--sans)}'
+'.tip-x{position:absolute;top:4px;right:4px;width:44px;height:44px;font:inherit;font-size:22px;line-height:1;cursor:pointer;color:var(--mute);background:transparent;border:0}'
+'.tip-x:hover{color:var(--fg)}'
+'.tip-t{margin:0 0 4px;padding-right:36px;font-size:17px;line-height:1.4;font-weight:600;letter-spacing:-.02em}'
+'.tip-s{margin:0 0 14px;font-size:13px;line-height:1.7;color:var(--mute)}'
+'.tip-tabs{display:flex;gap:6px;margin-bottom:14px}'
+'.tip-tab{flex:1;min-height:40px;font:inherit;font-size:14px;cursor:pointer;color:var(--mute);background:transparent;border:1px solid var(--line);border-radius:4px}'
+'.tip-tab[aria-selected=true]{color:var(--bg);background:var(--accent,var(--fg));border-color:var(--accent,var(--fg))}'
+'.tip-qr{width:100%;aspect-ratio:1;display:grid;place-items:center;background:#fff;border:1px solid var(--line);border-radius:4px;overflow:hidden}'
+'.tip-qr img{width:100%;height:100%;object-fit:contain}'
+'.tip-qr p{margin:0;padding:16px;font-size:13px;line-height:1.7;color:#6B6B72;text-align:center}'
+'.tip-h{margin:12px 0 0;font-size:12.5px;line-height:1.6;text-align:center;color:var(--mute)}'
+'.tip-m{margin:8px 0 0;font-size:12.5px;line-height:1.6;text-align:center}'
+'.tip-m a{display:inline-block;padding:8px 4px;text-underline-offset:3px}';
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
var ov,box,qr,hint,btns=[],cur=0,last=null,prevOv='',built=false;
function build(){
var st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st);
ov=el('div','tip-ov');ov.hidden=true;
ov.addEventListener('click',function(e){if(e.target===ov)close()});
box=el('div','tip-box');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','tip-title');
var x=el('button','tip-x','×');x.type='button';x.setAttribute('aria-label','关闭');x.addEventListener('click',close);
var t=el('h2','tip-t','请我喝杯咖啡');t.id='tip-title';
var s=el('p','tip-s','内容对你有帮助的话，随意支持一下。完全自愿，不影响任何使用。');
var tabs=el('div','tip-tabs');tabs.setAttribute('role','tablist');
TABS.forEach(function(d,i){
var b=el('button','tip-tab',d.name);b.type='button';b.id='tip-tab-'+d.id;b.setAttribute('role','tab');b.setAttribute('aria-controls','tip-panel');
b.addEventListener('click',function(){show(i)});
b.addEventListener('keydown',function(e){
if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();var n=(i+(e.key==='ArrowRight'?1:TABS.length-1))%TABS.length;show(n);btns[n].focus()}
});
btns.push(b);tabs.appendChild(b)
});
qr=el('div','tip-qr');qr.id='tip-panel';qr.setAttribute('role','tabpanel');
hint=el('p','tip-h');
var more=el('p','tip-m');var a=el('a',null,'打赏会用在哪里 →');a.href='/support';more.appendChild(a);
box.appendChild(x);box.appendChild(t);box.appendChild(s);box.appendChild(tabs);box.appendChild(qr);box.appendChild(hint);box.appendChild(more);
ov.appendChild(box);document.body.appendChild(ov);
built=true;
}
function show(i){
cur=i;var d=TABS[i];
btns.forEach(function(b,j){b.setAttribute('aria-selected',j===i?'true':'false');b.tabIndex=j===i?0:-1});
qr.setAttribute('aria-labelledby','tip-tab-'+d.id);
qr.textContent='';
var img=new Image();img.alt=d.name+'收款码';
img.onerror=function(){if(qr.firstChild!==img)return;qr.textContent='';qr.appendChild(el('p',null,'收款码暂时还没放上来，可以先看看打赏页的说明。'))};
img.src=d.src;qr.appendChild(img);
hint.textContent=d.hint+'，金额随意';
}
function onKey(e){
if(e.key==='Escape'){e.preventDefault();close();return}
if(e.key!=='Tab')return;
var f=Array.prototype.filter.call(box.querySelectorAll('button,a[href]'),function(n){return n.tabIndex>=0});
if(!f.length)return;
var a=f[0],z=f[f.length-1];
if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}
else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}
}
function open(){
if(!built)build();
last=document.activeElement;
prevOv=document.documentElement.style.overflow;document.documentElement.style.overflow='hidden';
ov.hidden=false;show(cur);btns[cur].focus();
document.addEventListener('keydown',onKey);
}
function close(){
ov.hidden=true;document.documentElement.style.overflow=prevOv;
document.removeEventListener('keydown',onKey);
if(last&&last.focus)last.focus();
}
document.addEventListener('click',function(e){
var a=e.target.closest&&e.target.closest('[data-tip]');
if(!a||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;
e.preventDefault();open();
});
})();
