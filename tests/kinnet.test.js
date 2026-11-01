// 关系图（网络图）测试：node tests/kinnet.test.js
const K = require('../kinship.js'), T = require('../kintree.js');
const {people, viewer} = require('./kintree.fixture.js');
let bad = 0; const fail = m=>{ console.log('✗', m); bad++; };
const NW = 92, NH = 78;

// 1. 乱家庭：全部显示时没有 NaN、没有重叠、「我」在中央、边都连得到人
const km = K.compute(people, viewer, {dialect:'mandarin', custom:{}});
const L = T.networkLayout(people, km, viewer, {hops:0});
if(L.shown < 40) fail('人数太少 '+L.shown);
L.nodes.forEach(n=>{ if(!isFinite(n.x) || !isFinite(n.y)) fail('NaN '+n.id); if(n.x<0 || n.y<0 || n.x>L.width || n.y>L.height) fail('出界 '+n.id); });
let worst = 9;
for(let i=0;i<L.nodes.length;i++) for(let j=i+1;j<L.nodes.length;j++){
  const a = L.nodes[i], b = L.nodes[j];
  worst = Math.min(worst, Math.hypot((a.x-b.x)/NW, (a.y-b.y)/NH));
}
if(worst < 0.9) fail('人物重叠 '+worst.toFixed(2));
const ids = new Set(L.nodes.map(n=>n.id));
L.edges.forEach(e=>{ if(!ids.has(e.a) || !ids.has(e.b)) fail('边连到不存在的人'); });
if(!L.nodes.find(n=>n.me)) fail('缺「我」');
if(!L.edges.some(e=>e.type==='sp') || !L.edges.some(e=>e.type==='bio')) fail('应有夫妻边和亲生边');
console.log('乱家庭', L.shown, '人', L.edges.length, '条线', '最小间距比', worst.toFixed(2));

// 2. 确定性：同样的数据排两次，坐标完全一样
const L2 = T.networkLayout(people, km, viewer, {hops:0});
if(JSON.stringify(L.nodes) !== JSON.stringify(L2.nodes)) fail('两次排版不一致');

// 3. 范围：1 步内只有「我」的直接亲人；范围越大人越多；auto 对大图默认 2 步
const L1 = T.networkLayout(people, km, viewer, {hops:1}), L3 = T.networkLayout(people, km, viewer, {hops:3});
if(!(L1.shown < L3.shown && L3.shown <= L.shown)) fail('范围应单调变大 '+[L1.shown,L3.shown,L.shown]);
if(L1.hidden !== L.shown - L1.shown) fail('hidden 计数不对');
if(T.networkLayout(people, km, viewer, {}).hops !== (L.total<=36 ? 0 : 2)) fail('auto 范围不对');

// 4. 关系文字：亲生 / 继 / 养 / 干 / 性别不明
const eq = (a,b,m)=>{ if(a!==b) fail(m+'：'+a+' ≠ '+b); };
eq(T.pcLabel('M','M','bio'), '父子', '父子'); eq(T.pcLabel('F','F','bio'), '母女', '母女');
eq(T.pcLabel('M','F','adopt'), '养父女', '养父女'); eq(T.pcLabel('F','M','step'), '继母子', '继母子');
eq(T.pcLabel('M','M','god'), '干父子', '干父子'); eq(T.pcLabel('', 'M','bio'), '亲子', '亲子'); eq(T.pcLabel('M','','adopt'), '养亲子', '养亲子');

// 5. 极端数据不能抛错；同一对人两条边（配偶同时是父母）要错开成弧线
const mk = (id,g,o={})=>Object.assign({id,name:id,gender:g,parents:[],spouses:[]}, o);
const run = (ps, me, o)=>T.networkLayout(ps, K.compute(ps, me, {}), me, o||{});
try{
  if(T.networkLayout([mk('a','M')], null, 'a', {}).shown !== 0) fail('kinMap 为空应返回空');
  if(run([mk('a','M')], 'a').shown !== 1) fail('只有我一个人');
  run([mk('a','M',{parents:['b']}), mk('b','F',{parents:['a']})], 'a');
  const d = run([mk('a','M',{parents:['b'],spouses:['b']}), mk('b','F',{spouses:['a']})], 'a');
  if(!d.edges.length || !d.edges.some(e=>e.off)) fail('重复的一对应有弧线偏移');
  T.netEdgeGeoms(d).forEach(g=>{ if(!g || /NaN/.test(g.d)) fail('路径有 NaN'); });
  const m3 = [mk('me','M',{parents:['f','m','x'],parentTypes:{x:'adopt', f:'bogus'}}), mk('f','M',{spouses:['m']}), mk('m','F',{spouses:['f']}), mk('x','F')];
  const r3 = run(m3,'me');
  if(r3.shown !== 4) fail('三位父母应都显示');
  if(!r3.edges.some(e=>e.type==='adopt') || r3.edges.filter(e=>e.type==='bio').length !== 2) fail('养亲/未知类型处理不对');
  // 两个人叠在同一点也要能散开
  const same = [mk('me','M',{parents:['p1','p2']}), mk('p1','M'), mk('p2','F')];
  const rs = run(same,'me'); if(rs.nodes.some(n=>!isFinite(n.x))) fail('同点 NaN');
}catch(e){ fail('抛错 '+e.stack); }

// 6. 名字里的 HTML 必须被转义；隐藏某类线后路径变少
const ps = [mk('me','M',{parents:['f']}), mk('f','M',{name:'<img src=x onerror=alert(1)>', spouses:['w']}), mk('w','F',{spouses:['f']})];
const esc = s=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx = {escapeHtml:esc, personById:id=>ps.find(p=>p.id===id), photoSrc:()=>null, surnameChar:n=>esc(Array.from(n)[0]), isDeceased:()=>false, chain:()=>'', subtitle:''};
const Ln = run(ps,'me',{hops:0});
const html = T.renderNetHtml(Ln, ctx, {labels:true});
if(/<img src=x/.test(html)) fail('名字没有转义');
const cnt = h=>(h.match(/<path /g)||[]).length;
if(cnt(T.renderNetHtml(Ln, ctx, {hide:new Set(['sp'])})) >= cnt(html)) fail('隐藏夫妻线后路径应减少');
if(!/kn-el/.test(html) || /kn-el/.test(T.renderNetHtml(Ln, ctx, {labels:false}))) fail('关系名开关不对');

console.log(bad ? '失败 '+bad : '全部通过');
process.exitCode = bad ? 1 : 0;
