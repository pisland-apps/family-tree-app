const K=require('../kinship.js');
let id=0; const P=[]; const by={};
function add(k,name,g,birth,parents=[],order){ by[k]={id:k,name,gender:g,birth:String(birth),parents:parents.map(x=>by[x].id),spouses:[],birthOrder:order}; P.push(by[k]); }
function wed(a,b){ by[a].spouses.push(by[b].id); by[b].spouses.push(by[a].id); }
add('gf','祖父','M',1930); add('gm','祖母','F',1932); wed('gf','gm');
add('fa','爸爸','M',1960,['gf','gm'],2); add('bo','伯父','M',1957,['gf','gm'],1); add('un','叔叔','M',1964,['gf','gm'],3); add('au','姑妈','F',1962,['gf','gm'],4);
add('auh','姑丈','M',1960); wed('au','auh'); add('bw','伯母','F',1958); wed('bo','bw');
add('mgf','外祖父','M',1935); add('mgm','外祖母','F',1936); wed('mgf','mgm');
add('mo','妈妈','F',1962,['mgf','mgm']); wed('fa','mo'); add('mb','舅舅','M',1958,['mgf','mgm']); add('ms','姨妈','F',1965,['mgf','mgm']);
add('me','我','M',1990,['fa','mo'],2); add('br','哥哥','M',1987,['fa','mo'],1); add('si','妹妹','F',1993,['fa','mo'],3); add('brw','嫂子','F',1988); wed('br','brw'); add('nep','侄子','M',2015,['br','brw']);
add('c1','堂弟','M',1992,['bo','bw']); add('c2','姑表姐','F',1985,['au','auh']); add('c3','舅表妹','F',1995,['mb']); add('c4','堂哥？同龄','M',1990,['bo','bw']);
add('wi','妻子','F',1991); wed('me','wi'); add('wf','岳父','M',1960); add('wm','岳母','F',1962); wed('wf','wm'); by.wi.parents=['wf','wm']; add('wb','小舅子','M',1995,['wf','wm']);
add('ge','祖母的弟','M',1940); by.gm.parents=['ggx']; 
add('ggx','曾祖','M',1900); by.gm.parents=['ggx']; by.ge.parents=['ggx'];
add('unk','性别未填','O',1970,['gf','gm'],5);
add('kid','儿子','M',2020,['me','wi']);
const r=K.compute(P,'me'); const exp={fa:'父亲',mo:'母亲',gf:'祖父',gm:'祖母',mgf:'外祖父',mgm:'外祖母',bo:'伯父',un:'叔叔',au:'姑妈',auh:'姑丈',bw:'伯母',mb:'舅舅',ms:'姨妈',br:'哥哥',si:'妹妹',brw:'嫂嫂',nep:'侄子',c1:'堂弟',c2:'表姐',c3:'表妹',wi:'妻子',wf:'岳父',wm:'岳母',wb:'小舅子',ge:'舅爷',kid:'儿子'};
let bad=0; for(const k in exp){ const g=r.get(by[k].id); const t=g&&g.title; const want=exp[k]; if(t!==want && !(k==='fa'&&t==='父亲')){ if(want==='妻子'&&!t){} console.log('✗',k,'期望',want,'得到',t,g&&g.hint); bad++; } }
['c4','unk','wi'].forEach(k=>{const g=r.get(by[k].id);console.log(k,g.title,'|',g.hint,'|',g.chain)});
console.log('链:',r.get(by.auh.id).chain);
console.log('环:',K.detectCycles(P).length);
by.gf.parents=['me']; console.log('制造环后:',K.detectCycles(P).length);
// 回归：同父异母，1995 的次女应是姐姐；同父母且排行与年份矛盾要提示
add('hs','异母姐','F',1985,['fa'],2); by.me.birthOrder=1;
const r2=K.compute(P,'me'); console.log('异母姐:',r2.get('hs').title); if(r2.get('hs').title!=='姐姐') bad++;
add('fs','同胞矛盾','F',1985,['fa','mo'],2); const r3=K.compute(P,'me'); console.log('矛盾:',r3.get('fs').title,r3.get('fs').hint); if(r3.get('fs').title) bad++;
// 回归：宜霓同时挂在妈妈和舅舅夫妇名下（折线路径不能抢走标准路径）
add('mbw','舅妈','F',1962); wed('mb','mbw'); by.c3.parents=['mb','mbw'];
add('xb','舅表哥','M',1985,['mb','mbw'],1); add('xs','舅表妹2','F',2000,['mb','mbw'],3);
add('odd','宜霓','F',1995,['mo','mbw'],2);
const r4=K.compute(P,'me'); const g4=k=>r4.get(by[k].id).title; console.log('舅妈/表哥/表妹:',g4('mbw'),g4('xb'),g4('xs'),g4('odd'));
if(g4('mbw')!=='舅妈'||g4('xb')!=='表哥'||g4('xs')!=='表妹') bad++;
// 新增：祖辈兄弟姐妹的子女及配偶、连襟、妯娌、亲家
add('ggf','曾祖父','M',1900); by.gf.parents=['ggf']; add('gb','伯祖父','M',1925,['ggf']); add('gbw','伯祖母','F',1927); wed('gb','gbw');
add('gbc','堂伯','M',1955,['gb','gbw']); add('gbcw','堂伯母','F',1957); wed('gbc','gbcw');
add('gbd','表姑妈','F',1958,['gb','gbw']); add('gbdh','表姑丈','M',1956); wed('gbd','gbdh');
add('gec','表叔','M',1962,['ge']); add('gecw','表婶','F',1963); wed('gec','gecw');
add('ws','妻妹','F',1993,['wf','wm']); add('wsh','连襟','M',1990); wed('ws','wsh');
add('kw','儿媳','F',2021); wed('kid','kw'); add('kwf','亲家公','M',1990); by.kw.parents=['kwf'];
const r5=K.compute(P,'me'); const g5=k=>r5.get(by[k].id).title;
const exp5={gb:'伯祖父',gbw:'伯祖母',gbc:'堂伯',gbcw:'堂伯母',gbd:'表姑妈',gbdh:'表姑丈',gec:'表叔',gecw:'表婶',ws:'小姨子',wsh:'连襟',kw:'儿媳',kwf:'亲家公'};
for(const q in exp5) if(g5(q)!==exp5[q]){ console.log('✗',q,exp5[q],g5(q)); bad++; }
const r6=K.compute(P,'wi'); const g6=k=>r6.get(by[k].id).title; console.log('妻子视角 嫂嫂/大伯子:',g6('brw'),g6('br'));
if(g6('brw')!=='妯娌'||g6('br')!=='大伯子') bad++;
console.log(bad?`失败 ${bad}`:'全部通过');
// 无出生年份：长幼未知给"甲/乙"，不依赖长幼的照常
P.forEach(p=>{ p.birth=''; p.birthOrder=undefined; });
const r7=K.compute(P,'me'); const g7=k=>r7.get(by[k].id).title;
const nb={fa:'父亲',au:'姑妈',mb:'舅舅',bo:'伯父/叔叔',br:'哥哥/弟弟',c1:'堂哥/弟',c2:'表姐/妹',bw:'伯母/婶婶',brw:'嫂嫂/弟媳',wb:'大舅子/小舅子',gbc:'堂伯/叔',gb:'伯祖父/叔祖父'};
let bad2=0; for(const q in nb) if(g7(q)!==nb[q]){ console.log('✗ 无年份',q,nb[q],g7(q)); bad2++; }
console.log(bad2?'无年份失败 '+bad2:'无年份用例通过');

// 远房兄弟姐妹：祖辈兄弟姐妹的孙辈
P.forEach(p=>{ if(by.me===p) p.birth='1990'; });
add('rc','远房','M',1985,['gbd','gbdh']); add('rcw','远房嫂','F',1986); wed('rc','rcw'); add('rc2','远房堂','M',1992,['gbc','gbcw']);
const r8=K.compute(P,'me'); console.log('远房:',r8.get('rc').title,r8.get('rcw').title,r8.get('rc2').title);
if(r8.get('rc').title!=='远房表哥'||r8.get('rc2').title!=='远房堂弟'||r8.get('rcw').title!=='远房表嫂') process.exitCode=1;

// 客家话 + 继养标记
const rh=K.compute(P,'me',{dialect:'hakka_sb'}); const gh=k=>rh.get(by[k].id).title;
console.log('客家话:',gh('fa'),gh('mo'),gh('mgf'),gh('bo'),gh('mb'),gh('mbw'),gh('br'),gh('c1'));
if(gh('fa')!=='阿爸'||gh('mgf')!=='家公'||gh('bo')!=='阿伯/叔'||gh('mbw')!=='阿妗'||gh('br')!=='阿哥/老太') process.exitCode=1;
by.mo.parentTypes=undefined; by.me.parentTypes={mo:'step'}; const rs=K.compute(P,'me'); console.log('继母:',rs.get('mo').title); if(rs.get('mo').title!=='继母') process.exitCode=1;

by.me.parentTypes=undefined;
const rc=K.compute(P,'me',{dialect:'hakka_sb',custom:{'外祖父':'公公'}}); console.log('自定义:',rc.get('mgf').title,'| 弟弟/备选:',K.compute(P,'me',{dialect:'hakka_sb'}).get('mgf').alts);
if(rc.get('mgf').title!=='公公') process.exitCode=1;

by.rc.birth=''; by.me.birth='';
const r9=K.compute(P,'me'); console.log('远房:',r9.get('rc').title,'|',r9.get('rcw').title);
if(r9.get('rc').title!=='远房表哥/弟') process.exitCode=1;

// 同年同辈：手动指定谁大
{ const A={id:'A',name:'A',gender:'M',birth:'2000',parents:['f','m'],spouses:[]}, B={id:'B',name:'B',gender:'M',birth:'2000',parents:['f','m'],spouses:[]},
  f={id:'f',name:'f',gender:'M',parents:[],spouses:['m']}, m={id:'m',name:'m',gender:'F',parents:[],spouses:['f']};
  const Q=[A,B,f,m]; let r=K.compute(Q,'A').get('B'); console.log('同年:',r.title,r.ageQ);
  if(r.title!=='哥哥/弟弟'||!r.ageQ) process.exitCode=1;
  B.elder=['A']; r=K.compute(Q,'A').get('B'); console.log('指定B大:',r.title,r.ageQ); if(r.title!=='哥哥'||r.ageQ) process.exitCode=1;
  B.elder=undefined; A.elder=['B']; r=K.compute(Q,'A').get('B'); if(r.title!=='弟弟') process.exitCode=1; }

// v8.26 干亲（god）：干爹 / 干妈 / 干儿子 / 干女儿，客家话契爺 / 契娘 / 契仔 / 契女，（干亲）后缀，养仍是（继/养）
{ const mk=(id,name,g,birth,parents=[])=>({id,name,gender:g,birth:String(birth),parents,spouses:[]});
  const gp=mk('gp','干爹之父','M',1930), gd=mk('gd','干爹','M',1960,['gp']), gm=mk('gm','干妈','F',1962),
        s=mk('s','干爹亲生子','M',1992,['gd']), a=mk('a','我','M',1990,['gd','gm']), da=mk('da','干女儿','F',1995,['gd']);
  gd.spouses=['gm']; gm.spouses=['gd'];
  a.parentTypes={gd:'god',gm:'god'}; da.parentTypes={gd:'god'};
  const Q=[gp,gd,gm,s,a,da]; const T=(r,id)=>r.get(id).title;
  let r=K.compute(Q,'a');
  console.log('干亲:',T(r,'gd'),T(r,'gm'),T(r,'gp'),T(r,'s'));
  if(T(r,'gd')!=='干爹'||T(r,'gm')!=='干妈') process.exitCode=1;
  if(!/（干亲）$/.test(T(r,'gp'))||!/（干亲）$/.test(T(r,'s'))||/继\/养/.test(T(r,'gp'))) process.exitCode=1;
  r=K.compute(Q,'gd'); console.log('干爹视角:',T(r,'a'),T(r,'da'));
  if(T(r,'a')!=='干儿子'||T(r,'da')!=='干女儿') process.exitCode=1;
  r=K.compute(Q,'a',{dialect:'hakka_sb'}); console.log('客家话干亲:',T(r,'gd'),T(r,'gm'));
  if(T(r,'gd')!=='契爺'||T(r,'gm')!=='契娘') process.exitCode=1;
  r=K.compute(Q,'gd',{dialect:'hakka_sb'}); console.log('客家话干儿女:',T(r,'a'),T(r,'da'));
  if(T(r,'a')!=='契仔'||T(r,'da')!=='契女') process.exitCode=1;
  r=K.compute(Q,'a',{dialect:'hakka_sb',custom:{'干爹':'契爸'}}); if(T(r,'gd')!=='契爸') process.exitCode=1;
  a.parentTypes={gd:'adopt'}; r=K.compute(Q,'a'); console.log('养仍是:',T(r,'gd'),T(r,'gp'));
  if(T(r,'gd')!=='养父'||!/（继\/养）$/.test(T(r,'gp'))) process.exitCode=1; }
