// 刻意写得很乱的家庭：多代、旁支、再婚继母、干爹、无性别、绝嗣、大支系
let n=0; const P=[]; const id={};
function add(key,name,gender,o={}){ id[key]='p'+(++n); P.push(Object.assign({id:id[key],name,gender,parents:[],spouses:[],birth:''},o,{_k:key})); }
const get=k=>P.find(p=>p._k===k);
function par(child,...ps){ const c=get(child); ps.forEach(k=>c.parents.push(id[k])); }
function wed(a,b){ get(a).spouses.push(id[b]); get(b).spouses.push(id[a]); }
// 祖辈
add('zgf','曾祖父','M',{birth:'1900'}); add('zgm','曾祖母','F'); wed('zgf','zgm');
add('gf','祖父','M',{birth:'1925'}); par('gf','zgf','zgm');
add('gm','祖母','F'); wed('gf','gm');
add('da','大爷','M',{birth:'1920'}); par('da','zgf','zgm'); add('daw','大奶奶','F'); wed('da','daw');
add('dak','堂伯叔','M',{birth:'1948'}); par('dak','da','daw'); add('dakw','堂婶','F'); wed('dak','dakw');
add('dakk','表姑丈x','M',{birth:'1975'}); par('dakk','dak','dakw');
add('gu','姑奶奶','F',{birth:'1930'}); par('gu','zgf','zgm'); add('guh','姑爷','M'); wed('gu','guh');
// 父辈
add('bofu','伯父','M',{birth:'1950'}); par('bofu','gf','gm'); add('bomu','伯母','F'); wed('bofu','bomu');
['堂兄','堂姐'].forEach((nm,i)=>{ add('bk'+i,nm,i?'F':'M',{birth:''+(1975+i)}); par('bk'+i,'bofu','bomu'); });
add('bk0w','堂嫂','F'); wed('bk0','bk0w'); add('bkk','堂侄','M',{birth:'2000'}); par('bkk','bk0','bk0w');
add('shu','叔叔','M',{birth:'1953'}); par('shu','gf','gm'); add('shuw','婶婶','F'); wed('shu','shuw');   // 绝嗣
add('gum','姑妈','F',{birth:'1956'}); par('gum','gf','gm'); add('guz','姑丈','M'); wed('gum','guz');
add('gk','表哥','M',{birth:'1982'}); par('gk','gum','guz');
add('dad','爸爸','M',{birth:'1958'}); par('dad','gf','gm');
add('mom','妈妈','F',{birth:'1960'});
add('mgf','外祖父','M'); add('mgm','外祖母','F'); wed('mgf','mgm'); par('mom','mgf','mgm');
add('zmf','外曾祖父','M'); add('zmm','外曾祖母','F'); wed('zmf','zmm'); par('mgf','zmf','zmm');
add('jiu','舅舅','M',{birth:'1955'}); par('jiu','mgf','mgm'); add('jiuw','舅妈','F'); wed('jiu','jiuw');
// 舅舅有一大支（测试折叠）
for(let i=0;i<4;i++){ add('jk'+i,'表'+(i+1),i%2?'F':'M',{birth:''+(1980+i)}); par('jk'+i,'jiu','jiuw'); add('jk'+i+'w','表配'+(i+1),i%2?'M':'F'); wed('jk'+i,'jk'+i+'w');
  for(let j=0;j<2;j++){ add('jkk'+i+j,'表侄'+i+j,'M',{birth:''+(2005+j)}); par('jkk'+i+j,'jk'+i,'jk'+i+'w'); } }
add('yi','姨妈','F',{birth:'1963'}); par('yi','mgf','mgm'); add('yiz','姨丈','M'); wed('yi','yiz');
add('yk','表姐','F',{birth:'1988'}); par('yk','yi','yiz');
// 继母（再婚）+ 继母带来的孩子 + 干爹
add('step','继母','F'); wed('dad','step'); add('stepson','继兄','M',{birth:'1985'}); par('stepson','step');
add('god','干爹','M'); get('me')||0;
// 我和兄弟姐妹
add('bro','哥哥','M',{birth:'1983'}); par('bro','dad','mom'); add('browf','嫂嫂','F'); wed('bro','browf');
add('bro1','侄儿','M',{birth:'2010'}); par('bro1','bro','browf'); add('bro2','侄女','F',{birth:'2012'}); par('bro2','bro','browf');
add('me','我','M',{birth:'1986'}); par('me','dad','mom');
add('sis','妹妹','F',{birth:'1990'}); par('sis','dad','mom'); add('sish','妹夫','M'); wed('sis','sish');
add('sk','外甥','M',{birth:'2018'}); par('sk','sis','sish');
add('nog','弟弟?','',{birth:'1993'}); par('nog','dad','mom');           // 无性别 → 脚注
add('wife','妻子','F'); wed('me','wife');
add('s1','儿子','M',{birth:'2015'}); par('s1','me','wife'); add('s2','女儿','F',{birth:'2018'}); par('s2','me','wife');
add('s1w','儿媳','F'); wed('s1','s1w'); add('gs','孙子','M',{birth:'2040'}); par('gs','s1','s1w');
add('fil','岳父','M'); add('mil','岳母','F'); wed('fil','mil'); par('wife','fil','mil');
add('bil','小舅子','M',{birth:'1990'}); par('bil','fil','mil');
// 干爹关系
get('me').parents.push(id['god']); get('me').parentTypes={[id['god']]:'god'};
P.forEach(p=>{ delete p._k; });
module.exports={people:P, viewer:id['me']};
