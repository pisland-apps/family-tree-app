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

/* ---------- 路径搜索：按层 BFS；同长度时 姻缘边少 > 非亲生边少 > id 小 ---------- */
function search(people, meId){
  const byId = new Map(people.map(p=>[p.id,p])), kids = new Map();
  people.forEach(p=>(p.parents||[]).forEach(pid=>{ if(byId.has(pid)){ if(!kids.has(pid)) kids.set(pid,[]); kids.get(pid).push(p.id); } }));
  const nonbio = (child, parent)=> ((byId.get(child).parentTypes||{})[parent]) ? 1 : 0;
  const best = new Map([[meId,{len:0,sp:0,nb:0,prev:null,e:null}]]);
  let layer = [meId];
  while(layer.length){
    const cand = new Map();
    for(const x of layer){
      const bx = best.get(x);
      if(bx.len - bx.sp >= MAX_BLOOD) { /* 血缘步数用尽，只允许再走配偶边 */ }
      const nbrs = [];
      (byId.get(x).parents||[]).forEach(y=>{ if(byId.has(y)) nbrs.push([y,'U',nonbio(x,y)]); });
      (kids.get(x)||[]).forEach(y=>nbrs.push([y,'D',nonbio(y,x)]));
      (byId.get(x).spouses||[]).forEach(y=>{ if(byId.has(y)) nbrs.push([y,'S',0]); });
      for(const [y,e,n] of nbrs){
        if(best.has(y)) continue;
        const sp = bx.sp + (e==='S'?1:0), len = bx.len+1;
        if(sp>MAX_SPOUSE || len-sp>MAX_BLOOD) continue;
        const c = {len,sp,nb:bx.nb+n,prev:x,e};
        const old = cand.get(y);
        if(!old || c.sp<old.sp || (c.sp===old.sp && (c.nb<old.nb || (c.nb===old.nb && x<old.prev)))) cand.set(y,c);
      }
    }
    layer = [];
    cand.forEach((c,y)=>{ best.set(y,c); layer.push(y); });
  }
  return {byId, best};
}
function pathTo(best, id){
  const ns=[id], es=[]; let c=best.get(id);
  while(c && c.prev!==null){ ns.unshift(c.prev); es.unshift(c.e); c=best.get(c.prev); }
  return {ns, es};
}

/* ---------- 长幼：同父母兄弟优先比排行，其次比出生年份；比不出来就报"缺数据" ---------- */
function cmpAge(a,b){
  const pa=a.parents||[], pb=b.parents||[];
  const full = pa.length>0 && pa.length===pb.length && pa.every(x=>pb.includes(x)); // 父母完全相同才信排行
  const x=parseInt(a.birth,10), y=parseInt(b.birth,10);
  const byYear = (!isNaN(x)&&!isNaN(y)&&x!==y) ? (x<y?1:-1) : 0;
  const byOrder = (full && a.birthOrder && b.birthOrder && a.birthOrder!==b.birthOrder) ? (a.birthOrder<b.birthOrder?1:-1) : 0;
  if(byYear && byOrder && byYear!==byOrder) return NaN;   // 年份与排行矛盾：不猜
  return byYear || byOrder;
}
const older = (a,b)=>{
  const c=cmpAge(a,b);
  if(Number.isNaN(c)){ const e=new Error('conflict'); e.hint='「'+a.name+'」与「'+b.name+'」的排行和出生年份互相矛盾，请检查'; throw e; }
  return c||need('排行或出生年份');
};
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
  if(a===1&&b===1){ const o=older(last,me); return {t:sx(last,o>0?'哥哥':'弟弟',o>0?'姐姐':'妹妹'),k:'sib',o}; }
  if(a===1&&b===2) return {t:sx(P[2],'侄','外甥')+sx(last,'子','女'),k:'nephew'};
  if(a===2&&b===1){
    const par=P[1];
    if(sx(par,1,0)){ const t = sx(last, older(last,par)>0?'伯父':'叔叔','姑妈'); return {t,k:'uncle'}; }
    return {t:sx(last,'舅舅','姨妈'),k:'uncle'};
  }
  if(a===2&&b===2){
    const pre = (sx(P[1],1,0) && sx(P[3],1,0)) ? '堂':'表', o=older(last,me);
    return {t:pre+sx(last,o>0?'哥':'弟',o>0?'姐':'妹'),k:'cousin'};
  }
  if(a===2&&b===3){
    const pre = (sx(P[1],1,0) && sx(P[3],1,0)) ? '堂':'表';
    return {t:pre+sx(P[4],'侄','外甥')+sx(last,'子','女'),k:'cn'};
  }
  if(a===3&&b===1){
    const g1m=sx(P[1],1,0), g2m=sx(P[2],1,0);
    if(g2m) return {t:sx(last, g1m ? (older(last,P[2])>0?'伯祖父':'叔祖父') : (older(last,P[2])>0?'大姥爷':'小姥爷'), g1m?'姑奶奶':'姑姥姥'),k:'gsib'};
    return {t:sx(last, g1m?'舅爷':'舅姥爷', g1m?'姨奶奶':'姨姥姥'),k:'gsib'};
  }
  return null;
}
const UNCLE_SPOUSE = {'伯父':'伯母','叔叔':'婶婶','舅舅':'舅妈','姑妈':'姑丈','姨妈':'姨丈'};

/* ---------- 含一条配偶边的路径 ---------- */
function withSpouse(P, es){
  const i=es.indexOf('S'), me=P[0], last=P[P.length-1];
  if(es.length===1) return sx(last,'丈夫','妻子');
  if(i===0){ // 我 → 配偶 → 配偶的血亲
    const r=blood(P.slice(1), es.slice(1)); if(!r) return null;
    const m = sx(me,1,0);
    if(r.k==='parent') return sx(last, m?'岳父':'公公', m?'岳母':'婆婆');
    if(r.k==='sib') return sx(last, m?(r.o>0?'大舅子':'小舅子'):(r.o>0?'大伯子':'小叔子'), m?(r.o>0?'大姨子':'小姨子'):(r.o>0?'大姑子':'小姑子'));
    if(r.k==='child') return sx(last,'继子','继女');
    return null;
  }
  if(i===es.length-1){ // 血亲的配偶
    const rel=P[P.length-2], r=blood(P.slice(0,-1), es.slice(0,-1)); if(!r) return null;
    if(r.k==='sib') return sx(rel, older(rel,me)>0?'嫂嫂':'弟媳', older(rel,me)>0?'姐夫':'妹夫');
    if(r.k==='child') return sx(rel,'儿媳','女婿');
    if(r.k==='uncle') return UNCLE_SPOUSE[r.t]||null;
    if(r.k==='parent') return sx(rel,'继母','继父');
  }
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

/* ---------- 主入口 ---------- */
function compute(people, meId){
  const result = new Map();
  if(!people.some(p=>p.id===meId)) return result;
  const {byId,best} = search(people, meId);
  best.forEach((c,id)=>{
    const {ns,es} = pathTo(best,id), P = ns.map(x=>byId.get(x));
    const info = {title:null, chain:chainText(P,es), hint:''};
    try{
      const nS = es.filter(e=>e==='S').length;
      let t = nS===0 ? (blood(P,es)||{}).t : nS===1 ? withSpouse(P,es) : null;
      if(t){ info.title = t + (best.get(id).nb ? '（继/养）' : ''); }
      else info.hint = '关系较远，暂无标准称谓';
    }catch(e){
      if(e.need) info.hint = '补充'+e.need+'后可显示称谓'; else if(e.hint) info.hint = e.hint; else throw e;
    }
    result.set(id, info);
  });
  return result;
}

const api = {compute, detectCycles};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.Kinship = api;
})(typeof window!=='undefined' ? window : globalThis);
