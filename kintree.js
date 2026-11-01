/* kintree.js — 亲戚图表「树状」「关系图」两个视图的布局计算（关系图见下方 networkLayout，v8.50）（纯函数，不碰 DOM，可在 node 里直接测试）
   输入：people（家谱数据）、kinMap（Kinship.compute 的结果）、viewerId（「我」）
   输出：每张卡片/折叠钮的坐标、连线路径、列标题、区块标题。

   思路（对照参考图）：
   1. 只画 kinMap 里有称谓的真实存在的人；每个人按 place.gen 落在固定的列（左=长辈，右=晚辈），
      按 place.side 归入 父系 / 本人 / 母系 / 配偶一方 四个横向区块（父系在上、母系在下、我在中间）。
   2. 区块内：夫妻叠放成一个「单元」（男上女下，嫁入/娶入的一方跟着有父母的那一方），
      单元之间按真实的父母关系挂成树，纵向用「子树高度」排版（叶子依次排，父母居中）。
   3. 跨区块的父母→子女（爸爸在父系、妈妈在母系、我在中间）用「总线」连接：
      所有父母的右侧锚点和所有子女的左侧锚点接到同一条竖线上；同一缝隙里竖线区间重叠就错开槽位。
   4. 非「我」直系的旁支，子孙超过阈值时折叠成「+N人」，点击展开。 */
(function(root){
'use strict';

const BAND_ORDER = ['p','self','m','s'];
const BAND_LABEL = {p:'父系', self:'本人', m:'母系', s:'配偶一方'};
const GEN_LABEL  = {'-4':'高祖辈','-3':'曾祖辈','-2':'祖辈','-1':'父辈','0':'平辈','1':'子辈','2':'孙辈','3':'曾孙辈'};

function genLabel(g){ return GEN_LABEL[g] || (g<0 ? '上'+(-g)+'辈' : '下'+g+'辈'); }

function layout(people, kinMap, viewerId, opts){
  opts = opts || {};
  const CW = opts.cardW || 124, CH = opts.cardH || 46, CGAP = 6, ROW = CH + CGAP;
  const PILL_W = 66, PILL_H = 28, PADY = 10;
  const PADL = 30, PADR = 24, HEAD_H = 72, BAND_GAP = 20;
  const GAP_BASE = 30, SLOT_W = 8;
  const THRESH = opts.collapseOver || 6;
  const expanded = opts.expanded || new Set();

  const byId = new Map(people.map(p=>[p.id,p]));
  const info = new Map();
  let skipped = 0;
  if(kinMap) kinMap.forEach((k,id)=>{
    const p = byId.get(id); if(!p) return;
    if(!k.title && id!==viewerId){ skipped++; return; }
    info.set(id, {id, p, band: (k.place && k.place.side) || 'self', gen: ((k.place && k.place.gen) || 0) + 0, title: k.title || '我'});
  });
  const empty = {nodes:[], pills:[], links:[], heads:[], bands:[], width:0, height:0, skipped, shown:0};
  if(!info.size) return empty;

  // 配偶关系对称化（只在 info 内）
  const sp = new Map();
  const addSp = (a,b)=>{ if(!sp.has(a)) sp.set(a,new Set()); sp.get(a).add(b); };
  info.forEach((v,id)=>(v.p.spouses||[]).forEach(s=>{ if(info.has(s) && s!==id){ addSp(id,s); addSp(s,id); } }));
  const parIn = (id,band)=>(info.get(id).p.parents||[]).filter(pid=>pid!==id && info.has(pid) && (band==null || info.get(pid).band===band));

  // 「我」的直系祖先：排版时让这一支靠近「我」所在的中间区块，连线最短
  const lineage = new Set();
  (function up(id){ parIn(id).forEach(pid=>{ if(!lineage.has(pid)){ lineage.add(pid); up(pid); } }); })(viewerId);

  const yr = p=>{ const y = parseInt(p.birth,10); return isNaN(y) ? null : y; };
  const bo = p=>{ const n = parseInt(p.birthOrder,10); return n>0 ? n : null; };
  function cmpAge(a,b){
    const A = info.get(a).p, B = info.get(b).p, x = bo(A), y = bo(B);
    if(x!=null && y!=null && x!==y) return x-y;
    const ya = yr(A), yb = yr(B);
    if(ya!=null && yb!=null && ya!==yb) return ya-yb;
    return 0;
  }
  const rank = id=>{ const g = info.get(id).p.gender; return g==='M' ? 0 : g==='F' ? 1 : 2; };

  /* ---------- 1. 每个区块：建单元、挂成树 ---------- */
  const bands = [];
  BAND_ORDER.forEach(band=>{
    const ids = Array.from(info.keys()).filter(id=>info.get(id).band===band);
    if(!ids.length) return;
    const order = new Map(ids.map((id,i)=>[id,i]));
    const hasPar = id=>parIn(id,band).length>0;
    const unitOf = new Map(), units = [];
    const mk = ()=>{ const u = {band, members:[], children:[], parent:null, lead:null, gen:0, key:'', kind:'unit'}; units.push(u); return u; };

    ids.filter(hasPar).forEach(id=>{ const u = mk(); u.members.push(id); unitOf.set(id,u); });
    ids.filter(id=>!hasPar(id)).forEach(id=>{            // 无父母的嫁入/娶入者：跟着有父母的配偶
      const s = Array.from(sp.get(id)||[]).find(x=>info.get(x).band===band && hasPar(x));
      if(s){ const u = unitOf.get(s); u.members.push(id); unitOf.set(id,u); }
    });
    ids.filter(id=>!unitOf.has(id)).forEach(id=>{        // 其余无父母者：互为配偶的并成一个单元
      if(unitOf.has(id)) return;
      const u = mk(), stack = [id];
      while(stack.length){
        const x = stack.pop(); if(unitOf.has(x)) continue;
        unitOf.set(x,u); u.members.push(x);
        (sp.get(x)||[]).forEach(y=>{ if(!unitOf.has(y) && info.get(y).band===band && !hasPar(y)) stack.push(y); });
      }
    });
    units.forEach(u=>{
      u.lead = u.members[0]; u.gen = info.get(u.lead).gen; u.key = u.lead;
      u.members.sort((a,b)=>rank(a)-rank(b) || order.get(a)-order.get(b));   // 男上女下
      u.h = u.members.length*ROW - CGAP;
    });
    units.forEach(u=>{
      if(!hasPar(u.lead)) return;
      const pu = parIn(u.lead,band).map(pid=>unitOf.get(pid)).find(x=>x && x!==u);
      if(pu){ u.parent = pu; pu.children.push(u); }
    });
    // 防环：从根出发访问，访问不到的（互为祖先）拆下来当根
    const seen = new Set(), roots = [];
    const visit = u=>{ if(seen.has(u)) return; seen.add(u); u.children.forEach(visit); };
    units.filter(u=>!u.parent).forEach(u=>{ roots.push(u); visit(u); });
    units.forEach(u=>{
      if(seen.has(u)) return;
      if(u.parent){ u.parent.children = u.parent.children.filter(c=>c!==u); u.parent = null; }
      roots.push(u); visit(u);
    });

    const onLine = u=>{ if(u._line===undefined) u._line = u.members.some(m=>lineage.has(m)) || u.children.some(onLine); return u._line; };
    const cmpUnit = (a,b)=>{
      const la = onLine(a), lb = onLine(b);
      if(la!==lb && (band==='p' || band==='m')) return (band==='p') ? (la?1:-1) : (la?-1:1);
      return cmpAge(a.lead,b.lead);
    };
    units.forEach(u=>u.children.sort(cmpUnit));
    roots.sort((a,b)=>{
      const la = onLine(a), lb = onLine(b);
      if(la!==lb && (band==='p' || band==='m')) return (band==='p') ? (la?1:-1) : (la?-1:1);
      return (a.gen-b.gen) || cmpAge(a.lead,b.lead);
    });

    // 折叠：非直系、非「我」这一区块的旁支，子孙太多就收成「+N人」
    const cnt = u=>u.members.length + u.children.reduce((s,c)=>s+cnt(c),0);
    units.forEach(u=>{
      const desc = u.children.reduce((s,c)=>s+cnt(c),0);
      u.canCollapse = band!=='self' && !onLine(u) && desc>THRESH;
      u.desc = desc;
    });
    bands.push({band, roots, units, unitOf});
  });

  /* ---------- 2. 把单元和折叠钮变成「盒子」，纵向排版 ---------- */
  const boxesOf = u=>{   // u 此刻实际显示的子盒子
    if(u.canCollapse && !expanded.has(u.key)) return [{kind:'pill', unit:u, n:u.desc, gen:u.gen+1, h:PILL_H, children:[]}];
    const kids = u.children.slice();
    if(u.canCollapse) kids.push({kind:'chip', unit:u, gen:u.gen+1, h:PILL_H, children:[]});
    return kids;
  };
  const kidsOf = b=> b.kind==='unit' ? (b._kids || (b._kids = boxesOf(b))) : [];
  const subH = b=>{
    if(b._sub===undefined){
      const own = b.h + PADY, blk = kidsOf(b).reduce((s,c)=>s+subH(c),0);
      b._sub = Math.max(own, blk);
    }
    return b._sub;
  };
  const place = (b,y0)=>{
    const avail = subH(b), kids = kidsOf(b), blk = kids.reduce((s,c)=>s+subH(c),0);
    let y = y0 + (avail-blk)/2;
    kids.forEach(c=>{ place(c,y); y += subH(c); });
    b.cy = kids.length ? (kids[0].cy + kids[kids.length-1].cy)/2 : y0 + avail/2;
    return avail;
  };

  let y = HEAD_H;
  const bandBoxes = [];
  bands.forEach(B=>{
    const top = y;
    B.roots.forEach(r=>{ y += place(r,y); });
    if(y-top < 80) y = top + 80;   // 竖排的区块名至少要放得下
    bandBoxes.push({label: BAND_LABEL[B.band], y: top, h: y-top});
    y += BAND_GAP;
  });
  const height = y - BAND_GAP + 20;

  /* ---------- 3. 列 ---------- */
  const allBoxes = [];
  const collect = b=>{ allBoxes.push(b); kidsOf(b).forEach(collect); };
  bands.forEach(B=>B.roots.forEach(collect));
  const gens = Array.from(new Set(allBoxes.map(b=>b.kind==='unit' ? b.gen : b.gen))).sort((a,b)=>a-b);
  const colOf = new Map(gens.map((g,i)=>[g,i]));

  const nodes = [], pills = [], nodeById = new Map();
  allBoxes.forEach(b=>{
    b.col = colOf.get(b.gen);
    if(b.kind==='unit'){
      const top = b.cy - b.h/2;
      b.members.forEach((id,i)=>{
        const v = info.get(id), n = {id, col:b.col, y: top + i*ROW, w:CW, h:CH, title:v.title, band:b.band, me:id===viewerId, line:lineage.has(id), unit:b};
        nodes.push(n); nodeById.set(id,n);
      });
    }else{
      const n = {id: (b.kind==='pill'?'pill:':'chip:') + b.unit.key, col:b.col, y: b.cy - b.h/2, w:PILL_W, h:b.h, kind:b.kind, n:b.n, key:b.unit.key, unit:b.unit};
      pills.push(n); nodeById.set(n.id,n);
    }
  });

  /* ---------- 4. 连线分组（总线） ---------- */
  const groups = new Map();
  const addTo = (key, parents, child)=>{
    let g = groups.get(key);
    if(!g){ g = {parents, children:[]}; groups.set(key,g); }
    if(!g.children.includes(child)) g.children.push(child);
  };
  nodes.forEach(n=>{
    const ps = parIn(n.id).filter(pid=>nodeById.has(pid)).sort();
    if(ps.length) addTo(ps.join('|'), ps, n.id);
  });
  pills.forEach(pl=>{
    const u = pl.unit;
    let ps = u.members.filter(m=>Array.from(info.values()).some(v=>(v.p.parents||[]).includes(m)));
    if(!ps.length) ps = [u.lead];
    // 折叠钮并入其第一个显示子女所在的组，没有就单独成组
    const first = u.children.map(c=>c.lead).find(id=>nodeById.has(id));
    let target = null;
    if(first) groups.forEach(g=>{ if(g.children.includes(first)) target = g; });
    if(target) target.children.push(pl.id); else addTo('pill|'+u.key, ps, pl.id);
  });

  /* ---------- 5. 缝隙槽位 + 列 x 坐标 ---------- */
  const ncol = gens.length;
  const gl = Array.from(groups.values()).map(g=>{
    const ps = g.parents.map(id=>nodeById.get(id)), cs = g.children.map(id=>nodeById.get(id));
    const pc = Math.max(...ps.map(n=>n.col)), cc = Math.min(...cs.map(n=>n.col));
    g.gap = cc>pc ? cc-1 : pc;
    const ys = ps.concat(cs).map(n=>n.y + n.h/2);
    g.y0 = Math.min(...ys); g.y1 = Math.max(...ys);
    g.ps = ps; g.cs = cs;
    return g;
  });
  const slotsInGap = new Array(ncol+1).fill(0);
  gl.slice().sort((a,b)=>(a.gap-b.gap) || (a.y0-b.y0)).forEach(g=>{
    const taken = gl.filter(o=>o!==g && o.gap===g.gap && o.slot!==undefined && !(o.y1 < g.y0-4 || o.y0 > g.y1+4)).map(o=>o.slot);
    let s = 0; while(taken.includes(s)) s++;
    g.slot = s; slotsInGap[g.gap] = Math.max(slotsInGap[g.gap], s+1);
  });
  const colX = [];
  let x = PADL;
  for(let i=0;i<ncol;i++){ colX[i] = x; x += CW + GAP_BASE + Math.max(0, slotsInGap[i]-1)*SLOT_W; }
  const width = colX[ncol-1] + CW + PADR + (slotsInGap[ncol-1] ? 20 : 0);
  nodes.concat(pills).forEach(n=>{ n.x = colX[n.col]; });

  const links = [];
  gl.forEach(g=>{
    const bx = colX[g.gap] + CW + 13 + g.slot*SLOT_W;
    let d = '';
    g.ps.forEach(n=>{ d += `M${n.x+n.w},${n.y+n.h/2}H${bx}`; });
    g.cs.forEach(n=>{ d += `M${bx},${n.y+n.h/2}H${n.x}`; });
    d += `M${bx},${g.y0}V${g.y1}`;
    links.push({d, cls:'bus'});
  });
  bands.forEach(B=>B.units.forEach(u=>{                 // 夫妻之间的短竖线
    for(let i=0;i+1<u.members.length;i++){
      const a = nodeById.get(u.members[i]), b = nodeById.get(u.members[i+1]);
      if(a && b) links.push({d:`M${a.x+22},${a.y+a.h}V${b.y}`, cls:'sp'});
    }
  }));

  const heads = gens.map((g,i)=>({x:colX[i], w:CW, text:genLabel(g), gen:g}));
  return {nodes, pills, links, heads, bands:bandBoxes, width, height, skipped, shown:nodes.length};
}


/* ---------- 把布局结果变成 HTML 字符串（纯字符串，便于测试；所有文字都经 esc 转义） ---------- */
function renderHtml(L, ctx){
  const esc = ctx.escapeHtml;
  const parts = [`<div class="kt-stage" style="width:${L.width}px;height:${L.height}px">`];
  parts.push(`<svg class="kt-lines" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">`);
  L.links.forEach(l=>parts.push(`<path class="kt-${l.cls}" d="${l.d}"/>`));
  parts.push('</svg>');
  parts.push(`<div class="kt-title"><b>亲戚称呼图表</b><span>${esc(ctx.subtitle||'')}</span></div>`);
  L.heads.forEach(h=>{
    const note = ctx.headNote ? ctx.headNote(h.gen) : '';   // 例如派字：「父系·方·134世」
    parts.push(`<div class="kt-head" style="left:${h.x}px;width:${h.w}px">${esc(h.text)}${note?`<small>${esc(note)}</small>`:''}</div>`);
  });
  L.bands.forEach(b=>parts.push(`<div class="kt-band" style="top:${b.y}px;height:${b.h}px">${Array.from(b.label).map(c=>`<i>${esc(c)}</i>`).join('')}</div>`));
  L.nodes.forEach(n=>{
    const p = ctx.personById(n.id); if(!p) return;
    const g = p.gender==='F' ? 'f' : p.gender==='M' ? 'm' : 'o';
    const src = ctx.photoSrc(p);
    const av = src ? `<img src="${esc(src)}" alt="">` : ctx.surnameChar(p.name);
    const cls = 'kt-card g-' + g + (n.me ? ' me' : '') + (ctx.isDeceased(p) ? ' dead' : '');
    parts.push(`<div class="${cls}" data-id="${esc(n.id)}" title="${esc(ctx.chain(n.id))}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px"><div class="kt-av">${av}</div><div class="kt-tx"><b${n.title.length>=7?' class="xl"':n.title.length>=6?' class="lg"':''}>${esc(n.title)}</b><span>${esc(p.name||'')}</span></div></div>`);
  });
  L.pills.forEach(n=>{
    const label = n.kind==='pill' ? '+' + n.n + '人' : '收起';
    parts.push(`<button type="button" class="kt-pill ${n.kind}" data-pill="${esc(n.key)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">${esc(label)}</button>`);
  });
  parts.push('</div>');
  return parts.join('');
}

/* ---------- v8.50 关系图（网络图）----------
   只用家谱里已有的数据：父母→子女（亲生 / 继 / 养 / 干，来自 person.parentTypes）和夫妻，不新增任何资料字段。
   人物范围和树状一致（kinMap 里有称谓的人）。布局是确定性的力导向：同一份数据每次排出来都一样，
   「我」固定在中央，长辈整体偏上、晚辈偏下（弱引力），再做防重叠、让线绕开不相干的人。
   v8.51：夫妻双方都是某个孩子的（同类型）父母时，画成「夫妻线中点 → 孩子」一条线（hub），不再是两条长箭头。 */
const NET_TYPE = {
  bio:  {c:'#6b8f4e', n:'亲生'},
  sp:   {c:'#d0463c', n:'夫妻'},
  step: {c:'#4a84c8', n:'继亲'},
  adopt:{c:'#e09a1f', n:'养亲'},
  god:  {c:'#8b5cc4', n:'干亲'}
};
const NET_ORDER = ['bio','sp','step','adopt','god'];
const NET_NW = 92, NET_NH = 78;          // 一个人（头像+称谓+名字）占的格子，防重叠用

function pcLabel(pg, cg, type){
  const pre = ({step:'继', adopt:'养', god:'干'})[type] || '';
  if((pg!=='M' && pg!=='F') || (cg!=='M' && cg!=='F')) return pre + '亲子';
  return pre + (pg==='M' ? '父' : '母') + (cg==='M' ? '子' : '女');
}

function networkLayout(people, kinMap, viewerId, opts){
  opts = opts || {};
  const byId = new Map(people.map(p=>[p.id,p]));
  const info = new Map(); let skipped = 0;
  if(kinMap) kinMap.forEach((k,id)=>{
    const p = byId.get(id); if(!p) return;
    if(!k.title && id!==viewerId){ skipped++; return; }
    info.set(id, {p, gen:(k.place && k.place.gen) || 0, title:k.title || '我'});
  });
  const empty = {nodes:[], edges:[], types:[], width:0, height:0, skipped, shown:0, total:0, hidden:0, hops:0};
  if(!info.has(viewerId)) return empty;
  const ids = Array.from(info.keys());

  /* 1. 边：父母→子女、夫妻（去重；父母是 a，子女是 b） */
  const all = [], seen = new Set();
  const pushE = (e,key)=>{ if(seen.has(key)) return; seen.add(key); all.push(e); };
  ids.forEach(id=>{
    const p = info.get(id).p;
    (p.parents||[]).forEach(pid=>{
      if(pid===id || !info.has(pid)) return;
      const raw = (p.parentTypes||{})[pid], type = (raw==='step'||raw==='adopt'||raw==='god') ? raw : 'bio';
      pushE({a:pid, b:id, type, kind:'pc', label:pcLabel(info.get(pid).p.gender, p.gender, type)}, 'c|'+pid+'|'+id);
    });
    (p.spouses||[]).forEach(sid=>{
      if(sid===id || !info.has(sid)) return;
      const a = id<sid ? id : sid, b = id<sid ? sid : id;
      pushE({a, b, type:'sp', kind:'sp', label:'夫妻'}, 's|'+a+'|'+b);
    });
  });

  /* 2. 离「我」几步（把边当无向图做广度优先），按范围截取 */
  const adj = new Map(ids.map(i=>[i,[]]));
  all.forEach(e=>{ adj.get(e.a).push(e.b); adj.get(e.b).push(e.a); });
  const hop = new Map([[viewerId,0]]), par = new Map(), order = [viewerId];
  for(let q=0;q<order.length;q++){
    const u = order[q];
    adj.get(u).forEach(v=>{ if(!hop.has(v)){ hop.set(v, hop.get(u)+1); par.set(v,u); order.push(v); } });
  }
  const hops = (opts.hops==null) ? (ids.length<=36 ? 0 : 2) : opts.hops;      // 0 = 全部；人少就默认全显示
  const vis = ids.filter(id=> hops===0 || (hop.has(id) && hop.get(id)<=hops));
  const visSet = new Set(vis);
  const single = all.filter(e=>visSet.has(e.a) && visSet.has(e.b));
  /* v8.51: 夫妻同为某孩子的同类型父母 → 合成一条「夫妻中点 → 孩子」的 hub 线 */
  const spPair = new Set(single.filter(e=>e.kind==='sp').map(e=>e.a+'|'+e.b));
  const isCouple = (x,y)=> spPair.has(x<y ? x+'|'+y : y+'|'+x);
  const byChild = new Map();
  single.forEach(e=>{ if(e.kind!=='pc') return; if(!byChild.has(e.b)) byChild.set(e.b,[]); byChild.get(e.b).push(e); });
  const merged = new Set(), hubs = [];
  byChild.forEach((list,child)=>{
    const used = new Set();
    for(let i=0;i<list.length;i++){
      if(used.has(i)) continue;
      for(let j=i+1;j<list.length;j++){
        if(used.has(j) || list[i].type!==list[j].type || !isCouple(list[i].a, list[j].a)) continue;
        used.add(i); used.add(j);
        const t = list[i].type, cg = info.get(child).p.gender, pre = ({step:'继', adopt:'养', god:'干'})[t] || '';
        hubs.push({a:list[i].a, b:child, pa:list[i].a, pb:list[j].a, type:t, kind:'hub', label: pre + (cg==='M' ? '子' : cg==='F' ? '女' : '子女')});
        merged.add(list[i]); merged.add(list[j]);
        break;
      }
    }
  });
  const edges = single.filter(e=>!merged.has(e)).concat(hubs);
  const grp = new Map();                                                       // 同一对人之间有多条边（如配偶同时是父母）：错开成弧线
  edges.forEach(e=>{ if(e.kind==='hub') return; const k = e.a<e.b ? e.a+'|'+e.b : e.b+'|'+e.a; if(!grp.has(k)) grp.set(k,[]); grp.get(k).push(e); });
  grp.forEach(list=>{ if(list.length>1) list.forEach((e,i)=>{ e.off = (i-(list.length-1)/2)*28 * (e.a<e.b ? 1 : -1); }); });

  /* 3. 初始位置：按步数分环，同一环里按各自「上一步」的角度排，亲人起步就挨着 */
  let maxHop = 0; hop.forEach(h=>{ if(h>maxHop) maxHop = h; });
  const lvl = id=> hop.has(id) ? hop.get(id) : maxHop+1;
  const idx = new Map(vis.map((id,i)=>[id,i]));
  const n = vis.length, vi = idx.get(viewerId);
  const X = new Float64Array(n), Y = new Float64Array(n), VX = new Float64Array(n), VY = new Float64Array(n);
  const ang = new Map([[viewerId,0]]), levels = new Map();
  vis.forEach(id=>{ if(id===viewerId) return; const l = lvl(id); if(!levels.has(l)) levels.set(l,[]); levels.get(l).push(id); });
  Array.from(levels.keys()).sort((a,b)=>a-b).forEach(l=>{
    const list = levels.get(l), pa = id=> ang.has(par.get(id)) ? ang.get(par.get(id)) : 0;
    list.sort((a,b)=> (pa(a)-pa(b)) || (idx.get(a)-idx.get(b)));
    list.forEach((id,i)=>{
      const a = 2*Math.PI*(i+0.5)/list.length + l*0.5, r = l*170;
      ang.set(id,a); X[idx.get(id)] = Math.cos(a)*r; Y[idx.get(id)] = Math.sin(a)*r;
    });
  });

  /* 4. 力导向（确定性：没有随机数） */
  const E = [], H = [], S = [];                     // E 弹簧 [a,b,长度,力度]；H 孩子靠近父母中点；S 线段（让别的人绕开）
  edges.forEach(e=>{
    if(e.kind==='hub'){
      const c = idx.get(e.b), p = idx.get(e.pa), q = idx.get(e.pb);
      E.push([c,p,150,0.05],[c,q,150,0.05]); H.push([c,p,q]); S.push({h:true, c, p, q, a:-1, b:-1});
    }else{
      const a = idx.get(e.a), b = idx.get(e.b);
      E.push([a,b, e.type==='sp' ? 95 : 150, e.type==='sp' ? 0.09 : 0.05]); S.push({h:false, a, b, c:-1, p:-1, q:-1});
    }
  });
  const gen = vis.map(id=>info.get(id).gen);
  const jit = (i,j)=>[((i*7+j*3)%5)-2 || 1, ((i*3+j*7)%5)-2 || 1];
  const collide = ()=>{
    for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
      let dx = X[i]-X[j], dy = Y[i]-Y[j];
      if(Math.abs(dx)>=NET_NW || Math.abs(dy)>=NET_NH) continue;
      let dist = Math.hypot(dx,dy);
      if(dist<1e-6){ const t = jit(i,j); dx = t[0]; dy = t[1]; dist = Math.hypot(dx,dy); }
      const ux = dx/dist, uy = dy/dist, need = 1/Math.hypot(ux/NET_NW, uy/NET_NH);
      if(dist>=need) continue;
      const push = (need-dist)*0.55;
      if(i===vi){ X[j] -= ux*push*2; Y[j] -= uy*push*2; }
      else if(j===vi){ X[i] += ux*push*2; Y[i] += uy*push*2; }
      else { X[i] += ux*push; Y[i] += uy*push; X[j] -= ux*push; Y[j] -= uy*push; }
    }
  };
  const AV = 36;                                    // 线离不相干的人至少这么远
  const avoid = ()=>{
    for(const s of S){
      let x1, y1, x2, y2;
      if(s.h){ x1 = (X[s.p]+X[s.q])/2; y1 = (Y[s.p]+Y[s.q])/2; x2 = X[s.c]; y2 = Y[s.c]; }
      else { x1 = X[s.a]; y1 = Y[s.a]; x2 = X[s.b]; y2 = Y[s.b]; }
      const dx = x2-x1, dy = y2-y1, l2 = dx*dx+dy*dy; if(l2<1) continue;
      const l = Math.sqrt(l2);
      for(let k=0;k<n;k++){
        if(k===vi || k===s.a || k===s.b || k===s.c || k===s.p || k===s.q) continue;
        const t = ((X[k]-x1)*dx + (Y[k]-y1)*dy)/l2; if(t<=0.04 || t>=0.96) continue;
        const ddx = X[k]-(x1+t*dx), ddy = Y[k]-(y1+t*dy), d = Math.hypot(ddx,ddy); if(d>=AV) continue;
        const ux = d<1e-6 ? -dy/l : ddx/d, uy = d<1e-6 ? dx/l : ddy/d, push = (AV-d)*0.35;
        X[k] += ux*push; Y[k] += uy*push;
      }
    }
  };
  const ITER = 420;
  for(let it=0; it<ITER; it++){
    const alpha = Math.max(0.04, 1 - it/ITER);
    for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
      let dx = X[i]-X[j], dy = Y[i]-Y[j], d2 = dx*dx+dy*dy;
      if(d2<1){ const t = jit(i,j); dx = t[0]; dy = t[1]; d2 = dx*dx+dy*dy; }
      if(d2>360000) continue;
      const d = Math.sqrt(d2), f = 30000/d2*alpha, fx = dx/d*f, fy = dy/d*f;
      VX[i] += fx; VY[i] += fy; VX[j] -= fx; VY[j] -= fy;
    }
    E.forEach(([a,b,L,k])=>{
      const dx = X[b]-X[a], dy = Y[b]-Y[a], d = Math.hypot(dx,dy) || 1, f = (d-L)*k, fx = dx/d*f, fy = dy/d*f;
      VX[a] += fx; VY[a] += fy; VX[b] -= fx; VY[b] -= fy;
    });
    H.forEach(([c,p,q])=>{                           // 孩子往父母中点的正下方靠，线就不会斜得很远
      const gx = (X[p]+X[q])/2 - X[c];
      VX[c] += gx*0.03; VX[p] -= gx*0.015; VX[q] -= gx*0.015;
    });
    for(let i=0;i<n;i++){ VY[i] += (gen[i]*120 - Y[i])*0.01; VX[i] -= X[i]*0.004; }
    for(let i=0;i<n;i++){
      if(i===vi){ X[i] = 0; Y[i] = 0; VX[i] = 0; VY[i] = 0; continue; }
      VX[i] *= 0.78; VY[i] *= 0.78;
      X[i] += Math.max(-35, Math.min(35, VX[i])); Y[i] += Math.max(-35, Math.min(35, VY[i]));
    }
    if(it>ITER*0.4){ avoid(); collide(); }
  }
  for(let k=0;k<150;k++){ avoid(); collide(); }

  /* 5. 平移到画布里，留出上面的标题和图例 */
  const PADL = 44, PADR = 44, TOPPAD = 96, PADB = 44;
  let minL = Infinity, maxR = -Infinity, minT = Infinity, maxB = -Infinity;
  vis.forEach((id,i)=>{
    const r = id===viewerId ? 30 : 23;
    minL = Math.min(minL, X[i]-NET_NW/2); maxR = Math.max(maxR, X[i]+NET_NW/2);
    minT = Math.min(minT, Y[i]-r); maxB = Math.max(maxB, Y[i]+r+34);
  });
  const ox = PADL - minL, oy = TOPPAD - minT;
  const nodes = vis.map((id,i)=>({id, x:Math.round(X[i]+ox), y:Math.round(Y[i]+oy), me:id===viewerId, title:info.get(id).title, gen:gen[i], hop:hop.has(id) ? hop.get(id) : -1}));
  return {
    nodes, edges, hops, skipped, shown:nodes.length, total:ids.length, hidden:ids.length-vis.length,
    types: NET_ORDER.filter(t=>edges.some(e=>e.type===t)),
    width: Math.max(520, Math.ceil(maxR+ox+PADR)), height: Math.ceil(maxB+oy+PADB)
  };
}

/* 每条边的路径 / 箭头 / 文字位置（拖动人物时只重算这一块） */
function netEdgeGeoms(L){
  const m = new Map(L.nodes.map(n=>[n.id,n])), f = v=>Math.round(v*10)/10;
  return L.edges.map(e=>{
    let A = m.get(e.a), B = m.get(e.b), ra;
    if(e.kind==='hub'){                              // 起点 = 夫妻两人连线的中点
      const P = m.get(e.pa), Q = m.get(e.pb); if(!P || !Q || !B) return null;
      A = {x:(P.x+Q.x)/2, y:(P.y+Q.y)/2, me:false}; ra = -2;
    }else{ if(!A || !B) return null; ra = A.me ? 30 : 23; }
    const rb = B.me ? 30 : 23;
    const dx = B.x-A.x, dy = B.y-A.y, len = Math.hypot(dx,dy) || 1, off = e.off || 0;
    const cx = (A.x+B.x)/2 - dy/len*off*2, cy = (A.y+B.y)/2 + dx/len*off*2;     // 控制点（无偏移时就是中点）
    const unit = (px,py,tx,ty)=>{ const l = Math.hypot(tx-px,ty-py) || 1; return [(tx-px)/l, (ty-py)/l]; };
    const ua = unit(A.x,A.y,cx,cy), ub = unit(B.x,B.y,cx,cy);
    const sx = A.x+ua[0]*(ra+2), sy = A.y+ua[1]*(ra+2), ex = B.x+ub[0]*(rb+3), ey = B.y+ub[1]*(rb+3);
    const d = off ? `M${f(sx)},${f(sy)}Q${f(cx)},${f(cy)} ${f(ex)},${f(ey)}` : `M${f(sx)},${f(sy)}L${f(ex)},${f(ey)}`;
    const lx = off ? sx*0.25+cx*0.5+ex*0.25 : (sx+ex)/2, ly = off ? sy*0.25+cy*0.5+ey*0.25 : (sy+ey)/2;
    let head = '';
    if(e.kind==='pc' || e.kind==='hub'){                                         // 箭头：父母 → 子女
      const t = unit(cx,cy,ex,ey), bx = ex-t[0]*10, by = ey-t[1]*10, px = -t[1]*4.5, py = t[0]*4.5;
      head = `${f(ex)},${f(ey)} ${f(bx+px)},${f(by+py)} ${f(bx-px)},${f(by-py)}`;
    }
    return {d, head, lx, ly};
  });
}
/* 选中某人后：和 TA 有关的线保持原样，其余变淡；hub 线算「夫妻两人 + 孩子」都相关 */
function netTouch(e, sel){ return e.kind==='hub' ? (sel===e.pa || sel===e.pb || sel===e.b) : (sel===e.a || sel===e.b); }
function netNeighbors(L, sel){
  const s = new Set([sel]);
  L.edges.forEach(e=>{ if(netTouch(e, sel)){ s.add(e.a); s.add(e.b); if(e.pb) s.add(e.pb); } });
  return s;
}
function netLinesHtml(L, hide, sel){
  const G = netEdgeGeoms(L), out = [], hubs = new Map(), m = new Map(L.nodes.map(n=>[n.id,n]));
  L.edges.forEach((e,i)=>{
    const g = G[i]; if(!g || (hide && hide.has(e.type))) return;
    const c = NET_TYPE[e.type].c, on = !sel || netTouch(e, sel);
    out.push(`<path d="${g.d}" fill="none" stroke="${c}" stroke-width="${(e.kind==='sp' ? 3 : 1.8) + (sel && on ? 0.7 : 0)}" stroke-linecap="round" stroke-opacity="${on ? (sel ? 1 : .9) : .12}"/>`);
    if(g.head) out.push(`<polygon points="${g.head}" fill="${c}" fill-opacity="${on ? 1 : .12}"/>`);
    if(e.kind==='hub'){
      const k = e.pa < e.pb ? e.pa+'|'+e.pb : e.pb+'|'+e.pa, P = m.get(e.pa), Q = m.get(e.pb);
      if(!hubs.has(k)) hubs.set(k, {x:(P.x+Q.x)/2, y:(P.y+Q.y)/2, on:false});
      if(on) hubs.get(k).on = true;
    }
  });
  hubs.forEach(h=>out.push(`<circle cx="${Math.round(h.x*10)/10}" cy="${Math.round(h.y*10)/10}" r="3.8" fill="${NET_TYPE.sp.c}" fill-opacity="${h.on ? 1 : .12}"/>`));
  return out.join('');
}
function netLabelsHtml(L, hide, on, esc, sel){
  if(!on && !sel) return '';
  const G = netEdgeGeoms(L), out = [];
  L.edges.forEach((e,i)=>{
    const g = G[i]; if(!g || (hide && hide.has(e.type))) return;
    if(sel ? !netTouch(e, sel) : !on) return;       // 选中了人：只显示和 TA 有关的关系名，不管「关系名」开关
    const w = Math.round(Array.from(e.label).length*10.5 + 8);
    out.push(`<span class="kn-el" style="left:${Math.round(g.lx-w/2)}px;top:${Math.round(g.ly-7)}px;width:${w}px;color:${NET_TYPE[e.type].c}">${esc(e.label)}</span>`);
  });
  return out.join('');
}
function renderNetHtml(L, ctx, opts){
  opts = opts || {};
  const esc = ctx.escapeHtml, hide = opts.hide || new Set();
  const sel = (opts.sel && L.nodes.some(n=>n.id===opts.sel)) ? opts.sel : null, nb = sel ? netNeighbors(L, sel) : null;
  const parts = [`<div class="kt-stage" style="width:${L.width}px;height:${L.height}px">`];
  parts.push(`<svg class="kt-lines" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">${netLinesHtml(L, hide, sel)}</svg>`);
  parts.push(`<div class="kn-labels">${netLabelsHtml(L, hide, opts.labels, esc, sel)}</div>`);
  parts.push(`<div class="kt-title"><b>亲戚关系图</b><span>${esc(ctx.subtitle||'')}</span></div>`);
  parts.push(`<div class="kn-lg">${L.types.filter(t=>!hide.has(t)).map(t=>`<span><i style="background:${NET_TYPE[t].c}"></i>${NET_TYPE[t].n}</span>`).join('')}</div>`);
  L.nodes.forEach(n=>{
    const p = ctx.personById(n.id); if(!p) return;
    const g = p.gender==='F' ? 'f' : p.gender==='M' ? 'm' : 'o', av = n.me ? 60 : 46;
    const src = ctx.photoSrc(p), inner = src ? `<img src="${esc(src)}" alt="">` : ctx.surnameChar(p.name);
    const cls = 'kn-node g-' + g + (n.me ? ' me' : '') + (ctx.isDeceased(p) ? ' dead' : '') + (sel && n.id===sel ? ' sel' : '') + (sel && !nb.has(n.id) ? ' dim' : '');
    parts.push(`<div class="${cls}" data-id="${esc(n.id)}" title="${esc(ctx.chain(n.id))}" style="left:${n.x-NET_NW/2}px;top:${n.y-av/2}px;width:${NET_NW}px"><div class="kn-av" style="width:${av}px;height:${av}px">${inner}</div><b class="kn-t">${esc(n.title)}</b><span class="kn-n">${esc(p.name||'')}</span></div>`);
  });
  parts.push('</div>');
  return parts.join('');
}

/* ---------- 弹窗界面：表格 / 树状 / 关系图 切换、缩放、折叠展开、存图 ----------
   这一段会碰 DOM，但不依赖 app.js 里的任何全局变量：所有外部能力都从 env 传进来，方便在测试页里单独跑。
   env: {state(), gridHtml(), ctx, viewGet(), viewSet(v), loadHtml2Canvas(), toast(msg), pick(id), fileName(view)} */
function show(ov, env){
  let expanded = new Set(), scale = 1;
  const SCALES = [0.5, 0.65, 0.8, 1, 1.25, 1.5];
  const esc = env.ctx.escapeHtml;
  // 关系图的临时状态（只在这次打开期间有效，不存盘；拖动后的位置也只保留到关闭）
  const net = {hops:null, labels:null, hide:new Set(), L:null, key:null, sel:null};
  let drag = null, suppress = false;

  function netLayoutNow(st){
    const key = net.hops==null ? 'auto' : String(net.hops);
    if(!net.L || net.key!==key){ net.L = networkLayout(st.people, st.kinMap, st.viewerId, {hops: net.hops==null ? undefined : net.hops}); net.key = key; }
    return net.L;
  }

  function render(){
    const st = env.state(), view = env.viewGet();
    const old = ov.querySelector('.kt-wrap, .kc-scroll');
    const keep = old ? {l: old.scrollLeft, t: old.scrollTop} : null;
    let body = '', foot = '', tools = '';
    const zoomTools = `<button type="button" class="kc-tool" data-kc="zoomout" title="缩小">－</button><button type="button" class="kc-tool" data-kc="zoomin" title="放大">＋</button><button type="button" class="kc-tool" data-kc="shot" title="保存为图片">存图</button>`;
    const skipNote = n=> n ? `另有 ${n} 位关系较远或资料不全（缺性别、长幼等），未列入。` : '';
    if(view==='tree'){
      const L = layout(st.people, st.kinMap, st.viewerId, {expanded});
      const ctx = Object.assign({}, env.ctx, {
        chain: id=>((st.kinMap.get(id)||{}).chain)||'',
        subtitle: '以「'+st.viewerName+'」为我 · '+st.dname
      });
      body = `<div class="kt-wrap"><div class="kt-sizer" style="width:${Math.round(L.width*scale)}px;height:${Math.round(L.height*scale)}px">${renderHtml(L, ctx)}</div></div>`;
      if(L.skipped) foot = `<div class="kc-foot">${skipNote(L.skipped)}</div>`;
      tools = zoomTools;
    }else if(view==='net'){
      const L = netLayoutNow(st);
      if(net.labels==null) net.labels = L.edges.length<=40;      // 边太多时默认先不显示文字，免得糊成一团
      if(net.sel && !L.nodes.some(n=>n.id===net.sel)) net.sel = null;
      const selNode = net.sel ? L.nodes.find(n=>n.id===net.sel) : null, selP = selNode ? env.ctx.personById(net.sel) : null;
      const ctx = Object.assign({}, env.ctx, {
        chain: id=>((st.kinMap.get(id)||{}).chain)||'',
        subtitle: '以「'+st.viewerName+'」为我 · '+st.dname
      });
      const chips = NET_ORDER.filter(t=>L.types.includes(t)).map(t=>`<button type="button" class="kn-chip${net.hide.has(t)?' off':''}" data-knt="${t}" title="显示 / 隐藏这类线"><i style="background:${NET_TYPE[t].c}"></i>${NET_TYPE[t].n}</button>`).join('');
      const bar = `<div class="kn-bar">${chips}<button type="button" class="kn-chip${net.labels?'':' off'}" data-kno="labels" title="线上的关系文字">关系名</button><button type="button" class="kn-chip" data-kno="hops" title="只显示离「我」几步以内的人">范围：${L.hops===0?'全部':L.hops+'步内'}</button>${selNode && selP ? `<span class="kn-selinfo">已选 <b>${esc(selNode.title)}</b> ${esc(selP.name||'')}<button type="button" class="kc-tool" data-kno="go">跳到 TA</button><button type="button" class="kc-tool" data-kno="clear">取消</button></span>` : ''}</div>`;
      body = L.nodes.length
        ? bar + `<div class="kt-wrap"><div class="kt-sizer" style="width:${Math.round(L.width*scale)}px;height:${Math.round(L.height*scale)}px">${renderNetHtml(L, ctx, {hide:net.hide, labels:net.labels, sel:net.sel})}</div></div>`
        : `<div class="kc-foot">没有可以显示的关系。</div>`;
      const notes = [skipNote(L.skipped), L.hidden ? `另有 ${L.hidden} 位不在「${L.hops}步内」，点「范围」可以看更多。` : '', L.nodes.length ? '点一下人物看 TA 的关系（再点一下取消），可拖动人物挪位置，「跳到 TA」回到家谱。' : ''].filter(Boolean);
      foot = notes.length ? `<div class="kc-foot">${notes.join(' ')}</div>` : '';
      tools = zoomTools;
    }else{
      const g = env.gridHtml();
      body = g.html; foot = g.skipped ? `<div class="kc-foot">${skipNote(g.skipped)}</div>` : '';
    }
    ov.innerHTML = `<div class="kc-box">
      <div class="kc-head"><div><b>亲戚图表</b> · 以「${esc(st.viewerName)}」为我 · ${esc(st.dname)}</div>
        <div class="kc-ctl"><div class="kc-seg"><button type="button" data-kcv="grid" class="${view==='grid'?'on':''}">表格</button><button type="button" data-kcv="tree" class="${view==='tree'?'on':''}">树状</button><button type="button" data-kcv="net" class="${view==='net'?'on':''}">关系图</button></div>${tools}<button type="button" class="btn btn-ghost" data-kc="close">关闭</button></div></div>
      ${body}${foot}</div>`;
    const stage = ov.querySelector('.kt-stage');
    if(stage) stage.style.transform = 'scale('+scale+')';
    if(keep){ const nw = ov.querySelector('.kt-wrap, .kc-scroll'); if(nw){ nw.scrollLeft = keep.l; nw.scrollTop = keep.t; } }
    ov.style.display = 'flex';
  }

  async function shot(){
    const stage = ov.querySelector('.kt-stage'); if(!stage) return;
    env.toast('正在生成图片…');
    const prev = stage.style.transform;
    try{
      await env.loadHtml2Canvas();
      stage.style.transform = 'none';
      await new Promise(r=>setTimeout(r,60));
      const w = stage.offsetWidth, h = stage.offsetHeight;
      const out = await window.html2canvas(stage, {
        backgroundColor:'#fbf7f0', scale: Math.min(2, window.devicePixelRatio||1), useCORS:true, logging:false,
        width:w, height:h, windowWidth: Math.max(window.innerWidth, w+40), windowHeight: Math.max(window.innerHeight, h+40),
        onclone: (doc)=>{   // 克隆里把外层的滚动/固定定位/限高都去掉，保证整张图都画出来
          const st = doc.querySelector('.kt-stage'); if(!st) return;
          st.style.transform = 'none';
          let n = st.parentElement;
          while(n && n!==doc.body){
            n.style.overflow = 'visible'; n.style.maxWidth = 'none'; n.style.maxHeight = 'none';
            if(!n.classList.contains('kin-chart')){ n.style.width = 'auto'; n.style.height = 'auto'; }
            else { n.style.position = 'absolute'; n.style.left = '0'; n.style.top = '0'; n.style.right = 'auto'; n.style.bottom = 'auto'; n.style.display = 'block'; }
            n = n.parentElement;
          }
        }
      });
      const blob = await new Promise(res=>out.toBlob(res,'image/png'));
      if(!blob) throw new Error('empty');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = env.fileName(env.viewGet());
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
      env.toast('图片已保存');
      return blob;
    }catch(err){
      console.error(err); env.toast('生成图片失败，请重试');
    }finally{ stage.style.transform = prev; }
  }

  ov.onclick = e=>{
    const t = e.target.closest ? e.target.closest('[data-kcv],[data-kc],[data-knt],[data-kno],.kt-card,.kn-node,.kc-item,.kt-pill') : null;
    if(!t || !ov.contains(t)){                                   // 点画布空白处：取消选中
      if(net.sel && !suppress && e.target.closest && e.target.closest('.kt-wrap')){ net.sel = null; render(); }
      return;
    }
    if(t.dataset.kcv){ env.viewSet(t.dataset.kcv); render(); return; }
    if(t.dataset.knt){ const k = t.dataset.knt; if(net.hide.has(k)) net.hide.delete(k); else net.hide.add(k); render(); return; }
    if(t.dataset.kno==='labels'){ net.labels = !net.labels; render(); return; }
    if(t.dataset.kno==='clear'){ net.sel = null; render(); return; }
    if(t.dataset.kno==='go'){ const id = net.sel; if(id){ ov.style.display = 'none'; env.pick(id); } return; }
    if(t.dataset.kno==='hops'){
      const seq = [1,2,3,0], cur = net.L ? net.L.hops : 0;
      net.hops = seq[(seq.indexOf(cur)+1) % seq.length]; net.L = null; render(); return;
    }
    const act = t.dataset.kc;
    if(act==='close'){ ov.style.display = 'none'; return; }
    if(act==='zoomin' || act==='zoomout'){
      const i = SCALES.indexOf(scale), j = Math.max(0, Math.min(SCALES.length-1, i + (act==='zoomin' ? 1 : -1)));
      scale = SCALES[j]; render(); return;
    }
    if(act==='shot'){ shot(); return; }
    if(t.classList.contains('kt-pill')){ const k = t.dataset.pill; if(expanded.has(k)) expanded.delete(k); else expanded.add(k); render(); return; }
    if(t.classList.contains('kn-node')){                         // 关系图：点人物 = 选中 / 取消选中（不再直接跳走）
      if(suppress) return;                                       // 刚拖完人物，别当成点击
      net.sel = net.sel===t.dataset.id ? null : t.dataset.id; render(); return;
    }
    const id = t.dataset.id;
    if(id){ ov.style.display = 'none'; env.pick(id); }
  };

  /* 关系图：拖动人物（鼠标 / 手指通用）。点一下仍然是跳到 TA，移动超过几像素才算拖动。 */
  ov.onpointerdown = e=>{
    const nd = e.target.closest ? e.target.closest('.kn-node') : null;
    if(!nd || !ov.contains(nd) || !net.L || (e.button!=null && e.button>0)) return;
    const n = net.L.nodes.find(x=>x.id===nd.dataset.id); if(!n) return;
    drag = {n, el:nd, sx:e.clientX, sy:e.clientY, ox:n.x, oy:n.y, moved:false, pid:e.pointerId};
    try{ nd.setPointerCapture(e.pointerId); }catch(_){}
  };
  ov.onpointermove = e=>{
    if(!drag || e.pointerId!==drag.pid) return;
    const dx = e.clientX-drag.sx, dy = e.clientY-drag.sy;
    if(!drag.moved && Math.hypot(dx,dy)<5) return;
    drag.moved = true;
    const L = net.L, n = drag.n, av = n.me ? 60 : 46;
    n.x = Math.round(Math.max(NET_NW/2+4, Math.min(L.width-NET_NW/2-4, drag.ox + dx/scale)));
    n.y = Math.round(Math.max(100, Math.min(L.height-70, drag.oy + dy/scale)));
    drag.el.style.left = (n.x-NET_NW/2)+'px'; drag.el.style.top = (n.y-av/2)+'px';
    const svg = ov.querySelector('.kt-lines'), lab = ov.querySelector('.kn-labels');
    if(svg) svg.innerHTML = netLinesHtml(L, net.hide, net.sel);
    if(lab) lab.innerHTML = netLabelsHtml(L, net.hide, net.labels, esc, net.sel);
  };
  const endDrag = e=>{
    if(!drag || (e && e.pointerId!==drag.pid)) return;
    if(drag.moved){ suppress = true; setTimeout(()=>{ suppress = false; }, 0); }
    drag = null;
  };
  ov.onpointerup = endDrag; ov.onpointercancel = endDrag;

  render();
  return {render, shot};
}

const api = {layout, renderHtml, networkLayout, renderNetHtml, netEdgeGeoms, netNeighbors, pcLabel, show, BAND_LABEL, NET_TYPE, genLabel};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.KinTree = api;
})(typeof window!=='undefined' ? window : globalThis);
