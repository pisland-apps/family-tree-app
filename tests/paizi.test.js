// 派字测试：node tests/paizi.test.js
const P = require('../paizi.js');
let bad = 0; const eq = (a,b,m)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ console.log('✗',m,'期望',JSON.stringify(b),'得到',JSON.stringify(a)); bad++; } };
const mk = (id,name,g,o={})=>Object.assign({id,name,gender:g,parents:[],spouses:[]},o);

// 1. 解析
eq(P.parseSeq('有兆昌 家,适\n世|鲁 扬/国'), ['有','兆','昌','家','适','世|鲁','扬|国'], 'parseSeq');
eq(P.parseSeq('ab|cd 世|'), ['世'], '非单字的写法被丢掉');
eq(P.parseSeq('').length, 0, '空');
// 2. 预设：方 = 坚公 134 世 = 入琼 30 世；奕 = 136；137 世两种写法
const cfg0 = P.sanitize(P.PRESET_BAIYAN);
eq(P.charsAt(cfg0,134), ['方'], '134 世'); eq(P.charsAt(cfg0,132), ['廷'], '132 世'); eq(P.charsAt(cfg0,136), ['奕'], '136 世');
eq(P.charsAt(cfg0,137), ['世'], '137 世照原表只写世'); eq(P.charsAt(cfg0,140), ['成'], '140 世成'); eq(P.charsAt(cfg0,141), ['宗'], '141 世'); eq(P.charsAt(cfg0,157), null, '超出字谱'); eq(P.charsAt(cfg0,120), null, '早于字谱');
eq(P.PRESET_BAIYAN.seq.length, 36, '121 – 156 世共 36 代');
// 3. 一个家：廷(祖父) 日(父) 方(我，锚点)；叔叔；姑姑；堂弟；我的儿子升、女儿；外家；妻子；继父养子
const P_ = [
  mk('gf','林廷X','M'), mk('gm','祖母','F',{spouses:['gf']}),
  mk('dad','林日X','M',{parents:['gf','gm']}), mk('mom','母亲','F',{spouses:['dad']}),
  mk('un','林日Y','M',{parents:['gf','gm']}), mk('aunt','林日姑','F',{parents:['gf','gm']}), mk('auntSon','姑的儿子','M',{parents:['aunt']}),
  mk('me','林方Z','M',{parents:['dad','mom']}), mk('cousin','堂弟','M',{parents:['un']}),
  mk('wife','妻子','F',{spouses:['me']}), mk('son','林升W','M',{parents:['me','wife']}), mk('dau','林升女','F',{parents:['me','wife']}), mk('dauKid','外孙','M',{parents:['dau']}),
  mk('mgf','外祖父','M'), mk('uncleM','舅舅','M'),
  mk('step','继父','M',{}), mk('stepSon','继子','M',{parents:['step','mom'],parentTypes:{step:'step'}}),
  mk('adopted','养子','M',{parents:['me'],parentTypes:{me:'adopt'}}),
];
P_[3].parents=['mgf']; P_[3].spouses=['dad']; P_[14].parents=['mgf'];   // 母亲、舅舅是外祖父的孩子
const cfg = P.sanitize(Object.assign({}, P.PRESET_BAIYAN, {anchorId:'me', anchorShi:134}));
const m = P.compute(P_, cfg); const d = id=>P.describe(P_.find(p=>p.id===id), cfg, m);
eq(d('me').shi, 134, '我 134'); eq(d('me').ru, 30, '我 入琼 30'); eq(d('me').chars, ['方'], '我 方'); eq(d('me').hit, true, '名字里有方');
eq(d('dad').chars, ['日'], '父亲 日'); eq(d('gf').chars, ['廷'], '祖父 廷'); eq(d('son').chars, ['升'], '儿子 升');
eq(d('un').shi, 133, '叔叔和父亲同一世'); eq(d('cousin').shi, 134, '堂弟和我同一世'); eq(d('cousin').line, true, '堂弟在父系'); eq(d('cousin').hit, false, '堂弟名字里没有方（只提示）');
eq(d('aunt').line, true, '姑姑本人在父系'); eq(d('auntSon').line, false, '姑姑的儿子不在父系');
eq(d('mom').line, false, '母亲不在父系'); eq(d('wife').line, false, '妻子不在父系'); eq(d('uncleM').line, false, '舅舅不在父系'); eq(d('mgf').line, false, '外祖父不在父系');
eq(d('dauKid').line, false, '女儿的孩子不在父系'); eq(d('dau').line, true, '女儿本人算');
eq(d('adopted').line, false, '养子不算'); eq(d('stepSon').line, false, '继子不算');
eq(d('wife').shi, 134, '配偶同一世');
// 4. 没有锚点 / 锚点被删 / 环形数据不卡死
eq(P.compute(P_, P.sanitize(P.PRESET_BAIYAN)).size, 0, '没设锚点 → 空');
eq(P.compute(P_, Object.assign({}, cfg, {anchorId:'nobody'})).size, 0, '锚点不存在 → 空');
const cyc = [mk('a','a','M',{parents:['b']}), mk('b','b','M',{parents:['a']})];
eq(P.compute(cyc, Object.assign({}, cfg, {anchorId:'a'})).size, 2, '环不卡死');
// 5. 清洗：不可信输入
eq(P.sanitize({seq:['<b>']}), null, '非单字被拒'); eq(P.sanitize({seq:['甲','<b>','乙']}), null, '中间有脏项整份拒绝（不能悄悄错位）'); eq(P.sanitize({seq:new Array(201).fill('甲')}), null, '太长被拒'); eq(P.sanitize(null), null, 'null');
const s = P.sanitize({seq:['甲','乙'], start1:-5, start2:3, sys2:'', anchorShi:'x', label:'x'.repeat(50)});
eq([s.start1, s.start2, s.anchorShi, s.label.length], [1, null, null, 12], '范围和长度被收紧');
// 6. 全部预设：能通过清洗，坚公世代对得上扫描件
P.PRESETS.forEach(p=>eq(!!P.sanitize(p), true, '预设可用 '+p.id));
const pr = id=>P.sanitize(P.PRESETS.find(p=>p.id===id));
eq(P.charsAt(pr('guanding'),123), ['日'], '观定派 123 世「日」'); eq(P.charsAt(pr('guanding'),145), ['腾'], '观定派 145 世「腾」'); eq(P.charsAt(pr('guanding'),146), ['芳'], '观定派 146 世「芳」');
eq(P.charsAt(pr('xixi'),141), ['宗'], '溪西 141 宗'); eq(P.charsAt(pr('xixi'),124), ['其','文'], '溪西 124 两写法');
eq(P.charsAt(pr('yu'),122), ['赞'], '裕公 24 世 = 坚公 122'); eq(P.charsAt(pr('xiaoshan'),143), ['名'], '肖山公第 20 世「名」= 坚公 143'); eq(P.charsAt(pr('qichang'),138), ['华'], '奇昌公第 15 世「华」= 坚公 138');
eq(P.PRESETS.find(p=>p.id==='xiaoshan').seq.length, 19, '肖山 2–20 世共 19 代'); eq(P.PRESETS.find(p=>p.id==='guanding').seq.length, 24, '观定 24 代');
eq(P.charsAt(cfg0,125), ['远'], '125 世「远」（家中口传五言诗）');
console.log(bad ? '失败 '+bad : '全部通过'); process.exitCode = bad ? 1 : 0;
