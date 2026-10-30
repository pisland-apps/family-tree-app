/* kintree.js — 亲戚图表「树状」视图的布局计算（纯函数，不碰 DOM，可在 node 里直接测试）
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
  const PADL = 30, PADR = 24, HEAD_H = 58, BAND_GAP = 20;
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

  const heads = gens.map((g,i)=>({x:colX[i], w:CW, text:genLabel(g)}));
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
  L.heads.forEach(h=>parts.push(`<div class="kt-head" style="left:${h.x}px;width:${h.w}px">${esc(h.text)}</div>`));
  L.bands.forEach(b=>parts.push(`<div class="kt-band" style="top:${b.y}px;height:${b.h}px"><span>${esc(b.label)}</span></div>`));
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

/* ---------- 弹窗界面：表格 / 树状 切换、缩放、折叠展开、存图 ----------
   这一段会碰 DOM，但不依赖 app.js 里的任何全局变量：所有外部能力都从 env 传进来，方便在测试页里单独跑。
   env: {state(), gridHtml(), ctx, viewGet(), viewSet(v), loadHtml2Canvas(), toast(msg), pick(id), fileName()} */
function show(ov, env){
  let expanded = new Set(), scale = 1;
  const SCALES = [0.5, 0.65, 0.8, 1, 1.25, 1.5];
  const esc = env.ctx.escapeHtml;

  function render(){
    const st = env.state(), view = env.viewGet();
    const old = ov.querySelector('.kt-wrap, .kc-scroll');
    const keep = old ? {l: old.scrollLeft, t: old.scrollTop} : null;
    let body = '', foot = '', tools = '';
    if(view==='tree'){
      const L = layout(st.people, st.kinMap, st.viewerId, {expanded});
      const ctx = Object.assign({}, env.ctx, {
        chain: id=>((st.kinMap.get(id)||{}).chain)||'',
        subtitle: '以「'+st.viewerName+'」为我 · '+st.dname
      });
      body = `<div class="kt-wrap"><div class="kt-sizer" style="width:${Math.round(L.width*scale)}px;height:${Math.round(L.height*scale)}px">${renderHtml(L, ctx)}</div></div>`;
      if(L.skipped) foot = `<div class="kc-foot">另有 ${L.skipped} 位关系较远或资料不全（缺性别、长幼等），未列入。</div>`;
      tools = `<button type="button" class="kc-tool" data-kc="zoomout" title="缩小">－</button><button type="button" class="kc-tool" data-kc="zoomin" title="放大">＋</button><button type="button" class="kc-tool" data-kc="shot" title="保存为图片">存图</button>`;
    }else{
      const g = env.gridHtml();
      body = g.html; foot = g.skipped ? `<div class="kc-foot">另有 ${g.skipped} 位关系较远或资料不全（缺性别、长幼等），未列入。</div>` : '';
    }
    ov.innerHTML = `<div class="kc-box">
      <div class="kc-head"><div><b>亲戚图表</b> · 以「${esc(st.viewerName)}」为我 · ${esc(st.dname)}</div>
        <div class="kc-ctl"><div class="kc-seg"><button type="button" data-kcv="grid" class="${view==='grid'?'on':''}">表格</button><button type="button" data-kcv="tree" class="${view==='tree'?'on':''}">树状</button></div>${tools}<button type="button" class="btn btn-ghost" data-kc="close">关闭</button></div></div>
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
      a.href = URL.createObjectURL(blob); a.download = env.fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
      env.toast('图片已保存');
      return blob;
    }catch(err){
      console.error(err); env.toast('生成图片失败，请重试');
    }finally{ stage.style.transform = prev; }
  }

  ov.onclick = e=>{
    const t = e.target.closest ? e.target.closest('[data-kcv],[data-kc],.kt-card,.kc-item,.kt-pill') : null;
    if(!t || !ov.contains(t)) return;
    if(t.dataset.kcv){ env.viewSet(t.dataset.kcv); render(); return; }
    const act = t.dataset.kc;
    if(act==='close'){ ov.style.display = 'none'; return; }
    if(act==='zoomin' || act==='zoomout'){
      const i = SCALES.indexOf(scale), j = Math.max(0, Math.min(SCALES.length-1, i + (act==='zoomin' ? 1 : -1)));
      scale = SCALES[j]; render(); return;
    }
    if(act==='shot'){ shot(); return; }
    if(t.classList.contains('kt-pill')){ const k = t.dataset.pill; if(expanded.has(k)) expanded.delete(k); else expanded.add(k); render(); return; }
    const id = t.dataset.id;
    if(id){ ov.style.display = 'none'; env.pick(id); }
  };
  render();
  return {render, shot};
}

const api = {layout, renderHtml, show, BAND_LABEL, genLabel};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.KinTree = api;
})(typeof window!=='undefined' ? window : globalThis);
