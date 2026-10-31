/* paizi.js — 辈分字谱（派字）：纯函数，不碰 DOM，可在 node 里直接测试
   思路：
   1. 字谱 cfg = {label, seq, sys1, start1, sys2, start2, anchorId, anchorShi}
      seq 是一串字，一个元素一代；同一代有几种说法的写成 "世"（例如白延派和统一派字不一致的那几代）。
      start1 是 seq[0] 对应的第几世（如 坚公 121 世），start2 是另一套世代编号（如 入琼 17 世，可没有）。
   2. 不给每个人单独存派字：只存「某个人 = 第几世」这一个锚点，其余人的世代靠父母 / 子女 / 配偶关系数出来
      （父母 −1、子女 +1、配偶 0），所以挪动家谱里的人不会让派字过期。
   3. 派字只对「父系」有意义：从锚点沿父亲一路往上找祖先，再从这些祖先往下找儿子、儿子的儿子……
      （女儿只算一代、不再往下；嫁进来的人、母亲一方、继 / 养 / 干亲都不算），其他人不显示派字。 */
(function(root){
'use strict';

const MAX_SEQ = 200;

// 白延派（照片里那份，坚公 121 世「有」= 入琼 17 世）。
// 坚公 137 – 140 世（入琼 33 – 36）：原表白延派一栏只写「世 扬 名 成」（「鲁 国 礼 启」是溪西派一栏的字）。
// 表尾备注另称各支从 137 世起统一用「鲁 国 礼 启 宗」，备注自己写着「待查考证实」。这里照原表；若家里实际用的是后者，在字序里把那几代改成「世|鲁」这样的并列写法即可。
const PRESET_BAIYAN = {
  label: '白延派', sys1: '坚公', start1: 121, sys2: '入琼', start2: 17,
  seq: ['有','兆','昌','家','运','仁','人','邦','之','英','熙','廷','日','方','升','奕',
        '世','扬','名','成','宗','殷','家','仁','传','嗣','盛','德','骏','业','存','子','孙','永','继','绪']
};

const PRESETS = [
  {id:"baiyan", label:"白延派", sys1:'坚公', start1:121, sys2:"入琼", start2:17, note:"你家这一支;坚公 137–140 世照原表只写「世扬名成」(表尾备注另称统一用「鲁国礼启宗」,待查考)",
   seq:["有", "兆", "昌", "家", "运", "仁", "人", "邦", "之", "英", "熙", "廷", "日", "方", "升", "奕", "世", "扬", "名", "成", "宗", "殷", "家", "仁", "传", "嗣", "盛", "德", "骏", "业", "存", "子", "孙", "永", "继", "绪"]},
  {id:"xixi", label:"溪西派", sys1:'坚公', start1:117, sys2:"入琼", start2:13, note:"通公原字「文士用世时」起;124–128 世有第二行「文章华国诗」并列;141 世「宗」与白延派合流",
   seq:["文", "士", "用", "世", "时", "大", "行", "其|文", "所|章", "学|华", "开|国", "天|诗", "树", "鸿", "猷", "明", "道", "师", "先", "觉", "鲁", "国", "礼", "启", "宗", "殷", "家", "仁", "传", "嗣", "盛", "德", "骏", "业", "存", "子", "孙", "永", "继", "绪"]},
  {id:"guanding", label:"观定派", sys1:'坚公', start1:123, sys2:"入琼", start2:19, note:"从坚公 123 世「日」起,共 24 代,至「芳」(146 世)止",
   seq:["日", "钦", "中", "而", "翰", "有", "大", "振", "会", "集", "书", "典", "华", "国", "文", "章", "传", "家", "忠", "厚", "兰", "桂", "腾", "芳"]},
  {id:"yu", label:"裕公派", sys1:'坚公', start1:122, sys2:"裕公", start2:24, note:"坚公 = 裕公世 + 98;26、27 世各有两个并列字(国/绍、家/子);第 23 世原表写作「(有昌)(允秀)」(两组括号两字,不像单个派字),未收",
   seq:["赞", "建", "国|绍", "家|子", "升", "士", "启", "克", "绍", "诗", "书", "志", "芳", "声", "贻", "禄", "位", "高", "魁", "道", "义", "源", "盛", "德", "勋", "名", "嗣", "英", "才", "世", "泽", "新", "振", "起", "升", "平", "威"]},
  {id:"xiaoshan", label:"肖山公派", sys1:'坚公', start1:125, sys2:"肖山公", start2:2, note:"肖山公本人为第 1 世(坚公 124);此处从第 2 世「长」起",
   seq:["长", "文", "风", "苗", "其", "仁", "启", "世", "英", "传", "家", "兴", "大", "业", "经", "国", "显", "芳", "名"]},
  {id:"qichang", label:"奇昌公派", sys1:'坚公', start1:125, sys2:"奇昌公", start2:2, note:"奇昌公本人为第 1 世(坚公 124);此处从第 2 世「超」起。原表备注写「奇昌公 4 代」,与表内「1 世 = 坚公 124」不一致,待查",
   seq:["超", "兴", "桂", "明", "道", "立", "德", "举", "善", "进", "良", "显", "宗", "华"]}
];

/* 异体 / 通用字：取名时常用的写法和字谱不一样（字谱写「方」，实际取名用「坊」；字谱写「升」，大多数人用「昇」）。
   每一组里的字互相视为同一个字，只用在「名字里有没有派字」的比对上，不改字谱本身。
   后半是常见的简繁对应（字谱按简体存，名字多半是繁体），只收字谱里会出现的字。 */
const VARIANT_GROUPS = [
  '方坊', '升昇陞', '熙熈煕', '启啓啟', '运運', '扬揚', '传傳', '继繼', '绪緒', '孙孫', '骏駿', '业業', '国國', '礼禮', '鲁魯',
  '书書', '诗詩', '贻貽', '禄祿', '义義', '勋勳', '泽澤', '赞贊', '绍紹', '声聲', '时時', '学學', '开開', '华華', '鸿鴻',
  '师師', '觉覺', '钦欽', '会會', '兰蘭', '腾騰', '长長', '风風', '兴興', '经經', '显顯', '进進', '举舉', '后後',
].filter(Boolean);
const VARIANT_OF = new Map();
VARIANT_GROUPS.forEach(g=>{ const cs = Array.from(g); cs.forEach(c=>VARIANT_OF.set(c, cs)); });
const variantsOf = c => VARIANT_OF.get(c) || [c];
const sameChar = (a,b) => a===b || variantsOf(a).indexOf(b)>=0;

const isChar = s => typeof s==='string' && Array.from(s).length===1;
const isInt = (n,a,b) => Number.isInteger(n) && n>=a && n<=b;

/* 把用户粘贴的文字解析成 seq：空格 / 逗号 / 顿号 / 换行分隔；一整串连着写的字会拆成单字；"世" 表示同一代的两种写法 */
function parseSeq(text){
  const out = [];
  String(text||'').split(/[\s,，、;；]+/).filter(Boolean).forEach(tok=>{
    if(tok.indexOf('|')>=0 || tok.indexOf('｜')>=0 || tok.indexOf('/')>=0){
      const alts = tok.split(/[|｜/]/).filter(Boolean);
      if(alts.length && alts.every(isChar)) out.push(Array.from(new Set(alts)).join('|'));
    }else Array.from(tok).forEach(c=>{ if(/\S/.test(c)) out.push(c); });
  });
  return out.slice(0, MAX_SEQ);
}

/* 导入 / 读取时清洗配置（数据可能来自别人的 JSON，不可信） */
function sanitize(raw){
  if(!raw || typeof raw!=='object') return null;
  // 字序里只要有一项不合格就整份拒绝：悄悄丢掉一项，后面所有世代都会错位一格
  if(!Array.isArray(raw.seq) || !raw.seq.length || raw.seq.length>MAX_SEQ) return null;
  const seq = raw.seq.map(x=>String(x));
  if(!seq.every(x=>{ const a = x.split('|'); return a.length>=1 && a.length<=4 && a.every(isChar); })) return null;
  const str = (s,n)=>typeof s==='string' ? s.trim().slice(0,n) : '';
  const cfg = {
    label: str(raw.label,12), seq,
    sys1: str(raw.sys1,6) || '世', start1: isInt(raw.start1,1,9999) ? raw.start1 : 1,
    sys2: str(raw.sys2,6), start2: isInt(raw.start2,1,9999) ? raw.start2 : null,
    anchorId: typeof raw.anchorId==='string' ? raw.anchorId.slice(0,80) : '',
    anchorShi: isInt(raw.anchorShi,1,9999) ? raw.anchorShi : null
  };
  if(!cfg.sys2) cfg.start2 = null;
  return cfg;
}

/* 第 shi 世的派字（数组，可能有几种写法）；字谱里没有这一世返回 null */
function charsAt(cfg, shi){
  if(!cfg || !Number.isInteger(shi)) return null;
  const s = cfg.seq[shi - cfg.start1];
  return s ? s.split('|') : null;
}
function shiList(cfg){
  return cfg.seq.map((s,i)=>({shi: cfg.start1+i, chars: s.split('|')}));
}

/* 算出每个人是第几世、是不是父系。返回 Map(id → {shi, line}) —— 只含和锚点连得上的人 */
function compute(people, cfg){
  const res = new Map();
  if(!cfg || !cfg.anchorId || cfg.anchorShi==null) return res;
  const byId = new Map(people.map(p=>[p.id,p]));
  const anchor = byId.get(cfg.anchorId);
  if(!anchor) return res;
  const kids = new Map();
  people.forEach(p=>(p.parents||[]).forEach(pid=>{ if(!kids.has(pid)) kids.set(pid,[]); kids.get(pid).push(p.id); }));

  // 1. 世代：广度优先，父母 −1、子女 +1、配偶 0（数据前后矛盾时先走到的为准）
  const off = new Map([[anchor.id, 0]]); const q = [anchor.id];
  while(q.length){
    const id = q.shift(), p = byId.get(id), o = off.get(id);
    const nxt = [];
    (p.parents||[]).forEach(x=>nxt.push([x,-1]));
    (kids.get(id)||[]).forEach(x=>nxt.push([x,1]));
    (p.spouses||[]).forEach(x=>nxt.push([x,0]));
    nxt.forEach(([x,d])=>{ if(byId.has(x) && !off.has(x)){ off.set(x, o+d); q.push(x); } });
  }

  // 2. 父系：锚点 → 父亲 → 父亲的父亲…；再从这些祖先往下找儿子（女儿只算一代）。只认没标「继 / 养 / 干」的亲生关系
  const bio = (child, pid)=>{ const t = (child.parentTypes||{})[pid]; return !t; };
  const fatherOf = p=>(p.parents||[]).map(x=>byId.get(x)).find(f=>f && f.gender==='M' && bio(p,f.id));
  const line = new Set(); const ancestors = []; const seen = new Set();
  for(let a = anchor; a && !seen.has(a.id); a = fatherOf(a)){ seen.add(a.id); ancestors.push(a); }
  const down = p=>{
    if(line.has(p.id)) return; line.add(p.id);
    if(p.gender!=='M') return;
    (kids.get(p.id)||[]).forEach(cid=>{ const c = byId.get(cid); if(c && bio(c,p.id)) down(c); });
  };
  ancestors.forEach(down);

  off.forEach((o,id)=>res.set(id, {shi: cfg.anchorShi + o, line: line.has(id)}));
  return res;
}

/* 给详情面板用：这个人的世代、派字、名字里有没有 */
function describe(person, cfg, map){
  const r = map && map.get(person.id);
  if(!r) return null;
  const chars = charsAt(cfg, r.shi);
  const ru = (cfg.start2!=null) ? r.shi - cfg.start1 + cfg.start2 : null;
  const name = String(person.name||'');
  // 名字里出现的字 = 派字本身或它的异体；found 是名字里实际用的那个字（和派字不同时界面上会标出来）
  let found = null;
  if(chars && name) for(const c of chars){ const v = variantsOf(c).find(x=>name.indexOf(x)>=0); if(v){ found = v; break; } }
  return {shi: r.shi, ru, chars, line: r.line, hit: (chars && name) ? !!found : null, found};
}

const api = {PRESETS, PRESET_BAIYAN, parseSeq, sanitize, charsAt, shiList, compute, describe, variantsOf, sameChar};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.Paizi = api;
})(typeof window!=='undefined' ? window : globalThis);
