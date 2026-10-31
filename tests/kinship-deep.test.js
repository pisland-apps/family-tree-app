// v8.48: 通用生成器 + 兜底。blood 路径 = 上 a 代、下 b 代；除末位外全为男性（可用 opts 改某一位性别）
const K=require('../kinship.js');
function run(a,b,{lastG='M',gen={},old=0}={}){
  const P=[]; const mk=(id,g,gn)=>{ const p={id,name:id,gender:g,birth:String(2000-25*gn),parents:[],spouses:[]}; P.push(p); return p; };
  const ups=[mk('me','M',0)]; for(let i=1;i<=a;i++) ups.push(mk('u'+i,gen['u'+i]||'M',i));
  for(let i=0;i<a;i++) ups[i].parents=[ups[i+1].id];
  let prev=ups[a], last=null;
  for(let i=1;i<=b;i++){ const g=(i===b)?lastG:(gen['d'+i]||'M'); const n=mk('d'+i,g,a-i); if(i===b&&old) n.birth=String(+n.birth-old); n.parents=[prev.id]; prev=n; last=n; }
  const r=K.compute(P,'me').get(last?last.id:'u'+a);
  return r?r.title:r;
}
let bad=0;
function eq(a,b,want,opts){ const got=run(a,b,opts); if(got!==want){ console.log('✗',`上${a}下${b}`,'期望',want,'得到',got); bad++; } }
// 直系
eq(5,0,'远祖父'); eq(6,0,'远祖母',{gen:{u6:'F'}}); eq(0,5,'来孙'); eq(0,5,'来孙女',{lastG:'F'});
eq(0,6,'昆孙'); eq(0,9,'耳孙'); eq(0,10,'远孙'); eq(0,7,'外仍孙',{gen:{d1:'F'}});
// 旁系晚辈
eq(1,2,'侄子'); eq(1,3,'侄孙'); eq(1,4,'侄曾孙'); eq(1,5,'侄玄孙'); eq(1,6,'侄来孙女',{lastG:'F'});
eq(2,3,'堂侄子'); eq(2,3,'堂外甥女',{lastG:'F',gen:{d2:'F'}}); eq(2,4,'堂侄孙'); eq(2,4,'堂外甥孙女',{lastG:'F',gen:{d2:'F'}});
eq(3,4,'远房堂侄子'); eq(3,4,'远房堂外甥女',{lastG:'F',gen:{d3:'F'}}); eq(3,4,'远房表侄子',{gen:{d1:'F'}}); eq(3,5,'远房堂侄孙');
// 同辈
eq(3,3,'远房堂哥',{old:3}); eq(4,4,'远房堂姐（同高祖）',{lastG:'F',old:3}); eq(5,5,'远房堂姐（同上5代祖）',{lastG:'F',old:3});
eq(4,5,'远房堂侄子（同高祖）');
// 旁系长辈
eq(3,2,'堂伯',{old:3}); eq(4,3,'远房堂伯（同高祖）',{old:3}); eq(4,3,'远房堂姑妈（同高祖）',{lastG:'F'}); eq(3,2,'堂姑妈',{lastG:'F'}); eq(3,2,'表姑妈',{lastG:'F',gen:{d1:'F'}});
eq(4,2,'堂伯祖',{old:3}); eq(5,3,'远房堂伯祖（同上5代祖）',{old:3}); eq(5,3,'远房堂祖姑（同上5代祖）',{lastG:'F'});
// 兜底
eq(5,1,'远亲（共同祖先在上5代，下1代）'); eq(6,2,'远亲（共同祖先在上6代，下2代）'); eq(1,12,'远亲（共同祖先在上1代，下12代）');
eq(8,8,'远房堂姐（同上8代祖）',{lastG:'F',old:3});
console.log(bad?('失败 '+bad):'v8.48 深层称谓用例通过');
process.exit(bad?1:0);
