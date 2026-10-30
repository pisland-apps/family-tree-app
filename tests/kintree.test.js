// 树状图布局测试：node tests/kintree.test.js   （先把 kintree.fixture.js 里那个刻意写乱的家庭排版一遍，再试几个极端数据）
const K = require('../kinship.js'), T = require('../kintree.js');
const {people, viewer} = require('./kintree.fixture.js');
let bad = 0; const fail = m=>{ console.log('✗', m); bad++; };

// 1. 乱家庭：不重叠、没有 NaN、折叠钮存在、展开后人数变多
let km = K.compute(people, viewer, {dialect:'mandarin', custom:{}});
let L = T.layout(people, km, viewer, {});
const all = L.nodes.concat(L.pills);
all.forEach(n=>{ if(isNaN(n.x) || isNaN(n.y)) fail('NaN '+n.id); });
for(let i=0;i<all.length;i++) for(let j=i+1;j<all.length;j++){
  const a = all[i], b = all[j];
  if(a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h) fail('重叠 '+a.id+' / '+b.id);
}
if(!L.pills.some(p=>p.kind==='pill')) fail('舅舅一支应该被折叠');
const key = L.pills.find(p=>p.kind==='pill').key;
const L2 = T.layout(people, km, viewer, {expanded:new Set([key])});
if(L2.shown <= L.shown) fail('展开后应显示更多人');
if(!L2.pills.some(p=>p.kind==='chip')) fail('展开后应有「收起」');
if(L.skipped < 1) fail('无性别的人应计入脚注');
console.log('乱家庭', L.shown, '人', L.pills.length, '个折叠钮', '脚注', L.skipped);

// 2. 极端数据不能抛错
const mk = (id,g,o={})=>Object.assign({id,name:id,gender:g,parents:[],spouses:[]}, o);
const run = (ps, me)=>T.layout(ps, K.compute(ps, me, {}), me, {});
try{
  run([mk('a','M')], 'a');
  if(T.layout([mk('a','M')], null, 'a', {}).shown !== 0) fail('kinMap 为空应返回空');
  run([mk('a','M',{parents:['b']}), mk('b','F',{parents:['a']})], 'a');                    // 祖先环
  run([mk('a','M',{parents:['b'],spouses:['b']}), mk('b','F',{spouses:['a']})], 'a');      // 配偶同时是父母
  const m3 = [mk('me','M',{parents:['f','m','x'],parentTypes:{x:'adopt'}}), mk('f','M',{spouses:['m']}), mk('m','F',{spouses:['f']}), mk('x','F')];
  if(run(m3,'me').shown !== 4) fail('三位父母应都显示');
}catch(e){ fail('抛错 '+e.message); }

// 3. 名字里的 HTML 必须被转义
const ps = [mk('me','M',{parents:['f']}), mk('f','M',{name:'<img src=x onerror=alert(1)>'})];
const esc = s=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const html = T.renderHtml(run(ps,'me'), {escapeHtml:esc, personById:id=>ps.find(p=>p.id===id), photoSrc:()=>null, surnameChar:n=>esc(Array.from(n)[0]), isDeceased:()=>false, chain:()=>'', subtitle:''});
if(/<img src=x/.test(html)) fail('名字没有转义');

console.log(bad ? '失败 '+bad : '全部通过');
process.exitCode = bad ? 1 : 0;
