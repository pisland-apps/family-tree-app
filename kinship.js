/* kinship.js — 亲戚称谓计算（纯函数，不碰 DOM）
   流程：路径搜索 → 归约成特征 → 查称谓表；路径同时用来生成"关系链"解释。
   称谓表目前只有普通话"背称"，集中在 blood()/spouseTitle() 两处，方言可替换这两处的字符串。 */
(function(root){
'use strict';
const MAX_BLOOD = 6, MAX_SPOUSE = 2;

function need(what){ const e = new Error(what); e.need = what; throw e; }

/* ---------- 数据校验：祖先环 ---------- */
function detectCycles(people){
  const byId = new Map(people.map(p=>[p.id,p]));
  const color = new Map(), found = [];
  (function(){
    function dfs(id){
      color.set(id,1);
      for(const pid of (byId.get(id).parents||[])){
        if(!byId.has(pid)) continue;
        const c = color.get(pid)||0;
        if(c===1) found.push([id,pid]); else if(c===0) dfs(pid);
      }
      color.set(id,2);
    }
    people.forEach(p=>{ if(!color.get(p.id)) dfs(p.id); });
  })();
  people.forEach(p=>{ // 配偶同时是自己的父母/子女，也属于配错
    (p.spouses||[]).forEach(s=>{ const q=byId.get(s); if(q && ((p.parents||[]).includes(s) || (q.parents||[]).includes(p.id))) found.push([p.id,s]); });
  });
  return found;
}

/* ---------- 路径搜索 ----------
   血缘段只允许"先上后下"（U*D*），不走折线，否则经由半血亲/多重父母会抢走标准路径；
   每遇配偶边重新开始一段。同长度时 姻缘边少 > 非亲生边少 > id 小。 */
function search(people, meId){
  const byId = new Map(people.map(p=>[p.id,p])), kids = new Map();
  people.forEach(p=>(p.parents||[]).forEach(pid=>{ if(byId.has(pid)){ if(!kids.has(pid)) kids.set(pid,[]); kids.get(pid).push(p.id); } }));
  const nonbio = (child, parent)=> ((byId.get(child).parentTypes||{})[parent]) ? 1 : 0;
  const key = (id,ph)=>id+'|'+ph;
  const k0 = key(meId,'u');
  const best = new Map([[k0,{id:meId,len:0,sp:0,nb:0,prev:null,e:null}]]);
  let layer = [k0];
  while(layer.length){
    const cand = new Map();
    for(const kx of layer){
      const bx = best.get(kx), x = bx.id, ph = kx.slice(kx.lastIndexOf('|')+1), px = byId.get(x);
      const nbrs = [];
      if(ph==='u') (px.parents||[]).forEach(y=>{ if(byId.has(y)) nbrs.push([y,'U',nonbio(x,y),'u']); });
      (kids.get(x)||[]).forEach(y=>nbrs.push([y,'D',nonbio(y,x),'d']));
      (px.spouses||[]).forEach(y=>{ if(byId.has(y)) nbrs.push([y,'S',0,'u']); });
      for(const [y,e,n,nph] of nbrs){
        const ky = key(y,nph);
        if(best.has(ky)) continue;
        const sp = bx.sp + (e==='S'?1:0), len = bx.len+1;
        if(sp>MAX_SPOUSE || len-sp>MAX_BLOOD) continue;
        const c = {id:y,len,sp,nb:bx.nb+n,prev:kx,e};
        const old = cand.get(ky);
        if(!old || c.sp<old.sp || (c.sp===old.sp && (c.nb<old.nb || (c.nb===old.nb && kx<old.prev)))) cand.set(ky,c);
      }
    }
    layer = [];
    cand.forEach((c,ky)=>{ best.set(ky,c); layer.push(ky); });
  }
  // 每个人取最优状态
  const pick = new Map();
  best.forEach((c,ky)=>{
    const o = pick.get(c.id);
    if(!o || c.len<o.c.len || (c.len===o.c.len && (c.sp<o.c.sp || (c.sp===o.c.sp && (c.nb<o.c.nb || (c.nb===o.c.nb && ky<o.ky)))))) pick.set(c.id,{ky,c});
  });
  return {byId, best, pick};
}
function pathTo(best, ky){
  const ns=[], es=[]; let c=best.get(ky);
  while(c){ ns.unshift(c.id); if(c.prev===null) break; es.unshift(c.e); c=best.get(c.prev); }
  return {ns, es};
}

/* ---------- 长幼：同父母兄弟优先比排行，其次比出生年份；比不出来就报"缺数据" ---------- */
const PENDING = [];   // 本次计算中比不出长幼的人对 [a.id,b.id]，用于界面询问
function cmpAge(a,b){
  const pa=a.parents||[], pb=b.parents||[];
  const full = pa.length>0 && pa.length===pb.length && pa.every(x=>pb.includes(x)); // 父母完全相同才信排行
  const x=parseInt(a.birth,10), y=parseInt(b.birth,10);
  const byYear = (!isNaN(x)&&!isNaN(y)&&x!==y) ? (x<y?1:-1) : 0;
  const byOrder = (full && a.birthOrder && b.birthOrder && a.birthOrder!==b.birthOrder) ? (a.birthOrder<b.birthOrder?1:-1) : 0;
  if(byYear && byOrder && byYear!==byOrder) return NaN;   // 年份与排行矛盾：不猜
  if(!byYear && !byOrder){   // 同年或缺年份：用户手动指定的"谁更大"（person.elder = 比其年幼的人 id 列表）
    if((a.elder||[]).includes(b.id)) return 1;
    if((b.elder||[]).includes(a.id)) return -1;
  }
  return byYear || byOrder;
}
const older = (a,b)=>{
  const c=cmpAge(a,b);
  if(Number.isNaN(c)){ const e=new Error('conflict'); e.hint='「'+a.name+'」与「'+b.name+'」的排行和出生年份互相矛盾，请检查'; throw e; }
  if(!c) PENDING.push([a.id,b.id]);
  return c;
};
const ab = (o,x,y)=> o>0 ? x : o<0 ? y : x+'/'+y;   // 长幼未知时两个都给
const sx = (p,m,f)=> p.gender==='M'?m : p.gender==='F'?f : need('性别');

/* ---------- 纯血缘段 → {t:称谓, k:类型, o:长幼}；不在表内返回 null ---------- */
function blood(P, es){
  let a=0; while(a<es.length && es[a]==='U') a++;
  const b=es.length-a;
  if(es.slice(a).some(e=>e!=='D')) return null;
  const me=P[0], last=P[P.length-1];
  if(!a && !b) return {t:'我',k:'self'};
  if(!b){
    const n=[['父亲','母亲'],['祖父','祖母'],['曾祖父','曾祖母'],['高祖父','高祖母']];
    if(a>4) return null;
    let t = sx(last,n[a-1][0],n[a-1][1]);
    if(a>=2 && sx(P[1],0,1)) t='外'+t;
    return {t,k:a===1?'parent':'anc'};
  }
  if(!a){
    if(b===1) return {t:sx(last,'儿子','女儿'),k:'child'};
    if(b===2) return {t:(sx(P[1],1,0)?'':'外')+sx(last,'孙子','孙女'),k:'gchild'};
    return null;
  }
  if(a===1&&b===1){ const o=older(last,me); return {t:sx(last,ab(o,'哥哥','弟弟'),ab(o,'姐姐','妹妹')),k:'sib',o}; }
  if(a===1&&b===2) return {t:sx(P[2],'侄','外甥')+sx(last,'子','女'),k:'nephew'};
  if(a===2&&b===1){
    const par=P[1];
    if(sx(par,1,0)){ const t = sx(last, ab(older(last,par),'伯父','叔叔'),'姑妈'); return {t,k:'uncle'}; }
    return {t:sx(last,'舅舅','姨妈'),k:'uncle'};
  }
  if(a===2&&b===2){
    const pre = (sx(P[1],1,0) && sx(P[3],1,0)) ? '堂':'表', o=older(last,me);
    return {t:sx(last,ab(o,pre+'哥',pre+'弟'),ab(o,pre+'姐',pre+'妹')),k:'cousin',o};
  }
  if(a===2&&b===3){
    const pre = (sx(P[1],1,0) && sx(P[3],1,0)) ? '堂':'表';
    return {t:pre+sx(P[4],'侄','外甥')+sx(last,'子','女'),k:'cn'};
  }
  if(a===3&&b===2){ // 祖辈兄弟姐妹的子女：堂/表伯叔、表姑妈、表舅、表姨妈
    const p1=P[1], paternal=sx(p1,1,0);
    if(!sx(last,1,0)) return {t:paternal?'表姑妈':'表姨妈',k:'pcousin'};
    if(!paternal) return {t:'表舅',k:'pcousin'};
    const pre=(sx(P[2],1,0)&&sx(P[4],1,0))?'堂':'表';
    return {t:ab(older(last,p1),pre+'伯',pre+'叔'),k:'pcousin'};
  }
  if(a===3&&b===3){ // 父母的堂/表兄弟姐妹的孩子（同曾祖父母的远房兄弟姐妹）
    const pre='远房'+((sx(P[1],1,0)&&sx(P[2],1,0)&&sx(P[4],1,0)&&sx(P[5],1,0))?'堂':'表'), o=older(last,me);
    return {t:sx(last,ab(o,pre+'哥',pre+'弟'),ab(o,pre+'姐',pre+'妹')),k:'rcousin',o};
  }
  if(a===3&&b===1){
    const g1m=sx(P[1],1,0), g2m=sx(P[2],1,0);
    if(g2m) return {t:sx(last, g1m ? ab(older(last,P[2]),'伯祖父','叔祖父') : ab(older(last,P[2]),'大姥爷','小姥爷'), g1m?'姑奶奶':'姑姥姥'),k:'gsib'};
    return {t:sx(last, g1m?'舅爷':'舅姥爷', g1m?'姨奶奶':'姨姥姥'),k:'gsib'};
  }
  return null;
}
const SPOUSE_OF = {'伯父':'伯母','叔叔':'婶婶','舅舅':'舅妈','姑妈':'姑丈','姨妈':'姨丈',
  '堂伯':'堂伯母','堂叔':'堂婶','表伯':'表伯母','表叔':'表婶','表姑妈':'表姑丈','表舅':'表舅妈','表姨妈':'表姨丈',
  '伯祖父':'伯祖母','叔祖父':'叔祖母','姑奶奶':'姑爷','大姥爷':'大姥姥','小姥爷':'小姥姥','姑姥姥':'姑姥爷',
  '舅爷':'舅奶奶','舅姥爷':'舅姥姥','姨奶奶':'姨爷','姨姥姥':'姨姥爷'};

/* ---------- 含一条配偶边的路径 ---------- */
function withSpouse(P, es){
  const i=es.indexOf('S'), me=P[0], last=P[P.length-1];
  if(es.length===1) return sx(last,'丈夫','妻子');
  if(es.join('')==='DSU') return sx(last,'亲家公','亲家母'); // 子女配偶的父母
  if(i===0){ // 我 → 配偶 → 配偶的血亲
    const r=blood(P.slice(1), es.slice(1)); if(!r) return null;
    const m = sx(me,1,0);
    if(r.k==='parent') return sx(last, m?'岳父':'公公', m?'岳母':'婆婆');
    if(r.k==='sib') return sx(last, m?ab(r.o,'大舅子','小舅子'):ab(r.o,'大伯子','小叔子'), m?ab(r.o,'大姨子','小姨子'):ab(r.o,'大姑子','小姑子'));
    if(r.k==='child') return sx(last,'继子','继女');
    return null;
  }
  if(i===es.length-1){ // 血亲的配偶
    const rel=P[P.length-2], r=blood(P.slice(0,-1), es.slice(0,-1)); if(!r) return null;
    if(r.k==='sib') return (()=>{ const o=older(rel,me); return sx(rel, ab(o,'嫂嫂','弟媳'), ab(o,'姐夫','妹夫')); })();
    if(r.k==='child') return sx(rel,'儿媳','女婿');
    if(r.k==='uncle'||r.k==='pcousin'||r.k==='gsib') { const m=r.t.split('/').map(x=>SPOUSE_OF[x]); return m.every(Boolean) ? m.join('/') : null; }
    if(r.k==='cousin'||r.k==='rcousin'){ const pre=r.k==='rcousin'?r.t.slice(0,3):r.t[0]; return sx(rel, ab(r.o,pre+'嫂',pre+'弟媳'), ab(r.o,pre+'姐夫',pre+'妹夫')); }
    if(r.k==='parent') return sx(rel,'继母','继父');
  }
  return null;
}

/* ---------- 含两条配偶边：连襟（妻子的姐妹的丈夫）、妯娌（丈夫的兄弟的妻子） ---------- */
function withTwoSpouses(P, es){
  if(es.join('')!=='SUDS') return null;
  const m=sx(P[0],1,0), sibM=sx(P[3],1,0), lastM=sx(P[P.length-1],1,0);
  if(m && !sibM && lastM) return '连襟';
  if(!m && sibM && !lastM) return '妯娌';
  return null;
}

/* ---------- 关系链文字：我的 父亲 的 姐姐 的 丈夫 ---------- */
function chainText(P, es){
  const out=[]; 
  for(let i=0;i<es.length;i++){
    const p=P[i+1];
    if(es[i]==='U' && es[i+1]==='D'){
      const q=P[i+2], c=cmpAge(q,P[i]);
      out.push(q.gender==='M'?(c>0?'哥哥':c<0?'弟弟':'兄弟'):q.gender==='F'?(c>0?'姐姐':c<0?'妹妹':'姐妹'):'兄弟姐妹'); i++; continue;
    }
    if(es[i]==='U') out.push(p.gender==='M'?'父亲':p.gender==='F'?'母亲':'父母');
    else if(es[i]==='D') out.push(p.gender==='M'?'儿子':p.gender==='F'?'女儿':'子女');
    else out.push(p.gender==='M'?'丈夫':p.gender==='F'?'妻子':'配偶');
  }
  return out.length ? '我的'+out.join('的') : '我自己';
}

/* ---------- 方言：在普通话称谓上叠一层"改叫法"表；表里没有的沿用普通话 ----------
   值可以是字符串，或数组 [默认写法, 又作...]；用户自定义覆盖优先于任何方言表。
   "沙巴"表以使用者家里的叫法为基准（外祖父=家公、外祖母=家婆、弟弟=老太[lau tai，谐音记号]），
   其余为常见叫法，各地差异大，未逐条核实。 */
const DIALECTS = {
  mandarin: {name:'普通话', map:{}},
  hakka_sb: {name:'客家话（沙巴）', unverified:true, map:{
    '外祖父':['家公','毑公'],'外祖母':['家婆','毑婆'],'弟弟':['老太','老弟'],
    '父亲':'阿爸','母亲':'阿姆','祖父':'阿公','祖母':'阿婆','曾祖父':'公太','曾祖母':'婆太',
    '伯父':'阿伯','伯母':'伯姆','叔叔':'阿叔','婶婶':['阿婶','叔姆'],'姑妈':'阿姑','舅舅':'阿舅','舅妈':'阿妗','姨妈':'阿姨',
    '哥哥':'阿哥','姐姐':['阿姐','阿姊'],'妹妹':['阿妹','老妹'],'嫂嫂':'阿嫂','姐夫':['姐夫','姊丈'],'妹夫':['妹夫','妹婿'],
    '儿子':'倈仔','女儿':'妹仔','女婿':'婿郎','儿媳':['新妇','心臼'],
    '公公':'家官','婆婆':'家娘','妻子':'老婆','丈夫':'老公',
    '干爹':['契爺','契爸'],'干妈':['契娘','契妈'],'干儿子':'契仔','干女儿':'契女'
  }}
};
function localize(title, dialect, custom){
  const map = (DIALECTS[dialect]||DIALECTS.mandarin).map, cu = custom||{};
  const m = title.match(/^(.*?)(（[^）]*）)?$/), base = m[1], suffix = m[2]||'';
  const one = x=>{ if(cu[x]) return [cu[x]]; const v=map[x]; return v ? (Array.isArray(v)?v:[v]) : [x]; };
  const parts = base.split('/').map(one);
  return {title: parts.map(v=>v[0]).join('/') + suffix, alts: parts.length===1 ? parts[0].slice(1) : []};
}

/* 并列称谓去掉重复前缀：远房表哥/远房表弟 → 远房表哥/弟 */
function compact(title){
  const m = title.match(/^(.*?)(（[^）]*）)?$/), parts = m[1].split('/');
  if(parts.length!==2) return title;
  const [x,y] = parts; let i=0;
  while(i<x.length && i<y.length-1 && x[i]===y[i]) i++;
  return x+'/'+y.slice(i)+(m[2]||'');
}

/* 图表用：辈分（相对"我"，负数为长辈）与所属区块 p父系 / m母系 / self本人这一辈及晚辈 / s配偶一方 */
function placeOf(P, es){
  const gen = es.filter(e=>e==='U').length - es.filter(e=>e==='D').length;
  let side='self';
  if(es.length){
    if(es[0]==='S') side = es.length===1 ? 'self' : 's';
    else if(es[0]==='U' && es[1]!=='D') side = P[1].gender==='M' ? 'p' : P[1].gender==='F' ? 'm' : 'self';
  }
  return {gen:-gen, side};
}

/* ---------- 主入口 ---------- */
function compute(people, meId, opts){
  const dialect = (opts && opts.dialect) || 'mandarin', custom = (opts && opts.custom) || {};
  const result = new Map();
  if(!people.some(p=>p.id===meId)) return result;
  const {byId,best,pick} = search(people, meId);
  pick.forEach(({ky,c},id)=>{
    const {ns,es} = pathTo(best,ky), P = ns.map(x=>byId.get(x));
    const info = {title:null, chain:chainText(P,es), hint:'', place:placeOf(P,es)};
    PENDING.length = 0;
    try{
      const nS = es.filter(e=>e==='S').length;
      let t = nS===0 ? (blood(P,es)||{}).t : nS===1 ? withSpouse(P,es) : nS===2 ? withTwoSpouses(P,es) : null;
      let direct = null;   // 直接的继/养父母、继/养子女：用专名，不加后缀；干亲（god）另有专名
      if(es.length===1 && es[0]==='U' && (P[0].parentTypes||{})[P[1].id]) direct = {tp:P[0].parentTypes[P[1].id], g:P[1].gender, p:1};
      if(es.length===1 && es[0]==='D' && (P[1].parentTypes||{})[P[0].id]) direct = {tp:P[1].parentTypes[P[0].id], g:P[1].gender, p:0};
      if(direct && direct.tp==='god' && (direct.g==='M'||direct.g==='F')){   // v8.26: 干亲（契爷/契仔），可按方言改叫法
        t = direct.p ? (direct.g==='M'?'干爹':'干妈') : (direct.g==='M'?'干儿子':'干女儿');
        const loc = localize(t, dialect, custom);
        info.std = t; info.title = loc.title; info.alts = loc.alts; result.set(id, info); return;
      }
      if(direct && (direct.tp==='step'||direct.tp==='adopt') && (direct.g==='M'||direct.g==='F')){
        t = (direct.tp==='step'?'继':'养') + (direct.p ? (direct.g==='M'?'父':'母') : (direct.g==='M'?'子':'女'));
        info.std = t; info.title = t; result.set(id, info); return;
      }
      if(t){ info.std = t; const loc = localize(t, dialect, custom); const viaGod = es.some((e,i)=>{ const ch = e==='U' ? P[i] : e==='D' ? P[i+1] : null, pa = e==='U' ? P[i+1] : e==='D' ? P[i] : null; return ch && ((ch.parentTypes||{})[pa.id]==='god'); });
        info.title = compact(loc.title + (viaGod ? '（干亲）' : c.nb ? '（继/养）' : '')); info.alts = loc.alts; if(t.includes('/')) info.hint = '补充出生年份或排行，或在详情面板指定谁大，即可确定'; }
      else info.hint = '关系较远，暂无标准称谓';
    }catch(e){
      info.ageQ = null;
      if(e.need) info.hint = '补充'+e.need+'后可显示称谓'; else if(e.hint) info.hint = e.hint; else throw e;
    }
    if(PENDING.length && info.title) info.ageQ = PENDING[0].slice();
    result.set(id, info);
  });
  return result;
}

const api = {compute, detectCycles, DIALECTS};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.Kinship = api;
})(typeof window!=='undefined' ? window : globalThis);
