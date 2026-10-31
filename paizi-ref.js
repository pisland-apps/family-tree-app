
const D=[{"id": "baiyan", "label": "白延派", "seq": ["有", "兆", "昌", "家", "适", "仁", "人", "邦", "之", "英", "熙", "廷", "日", "方", "升", "奕", "世|鲁", "扬|国", "名|礼", "成|启", "宗", "殷", "家", "仁", "传", "嗣", "盛", "德", "骏", "业", "存", "子", "孙", "永", "继", "绪"], "start1": 121, "sys2": "入琼", "start2": 17, "note": "你家这一支;坚公 137–140 世与溪西「鲁国礼启」并列,待原谱核实"}, {"id": "xixi", "label": "溪西派", "seq": ["文", "士", "用", "世", "时", "大", "行", "其|文", "所|章", "学|华", "开|国", "天|诗", "树", "鸿", "猷", "明", "道", "师", "先", "觉", "鲁", "国", "礼", "启", "宗", "殷", "家", "仁", "传", "嗣", "盛", "德", "骏", "业", "存", "子", "孙", "永", "继", "绪"], "start1": 117, "sys2": "入琼", "start2": 13, "note": "通公原字「文士用世时」起;124–128 世有第二行「文章华国诗」并列;141 世「宗」与白延派合流"}, {"id": "guanding", "label": "观定派", "seq": ["日", "钦", "中", "而", "翰", "有", "大", "振", "会", "集", "书", "典", "华", "国", "文", "章", "传", "家", "忠", "厚", "兰", "桂", "腾", "芳"], "start1": 123, "sys2": "入琼", "start2": 19, "note": "从坚公 123 世「日」起,共 24 代,至「芳」(146 世)止"}, {"id": "yu", "label": "裕公派", "seq": ["赞", "建", "国|绍", "家|子", "升", "士", "启", "克", "绍", "诗", "书", "志", "芳", "声", "贻", "禄", "位", "高", "魁", "道", "义", "源", "盛", "德", "勋", "名", "嗣", "英", "才", "世", "泽", "新", "振", "起", "升", "平", "威"], "start1": 122, "sys2": "裕公", "start2": 24, "note": "坚公 = 裕公世 + 98;26、27 世各有两个并列字(国/绍、家/子);第 23 世「(有昌)(允秀)」原表括号写法不清,未收"}, {"id": "xiaoshan", "label": "肖山公派", "seq": ["长", "文", "风", "苗", "其", "仁", "启", "世", "英", "传", "家", "兴", "大", "业", "经", "国", "显", "芳", "名"], "start1": 125, "sys2": "肖山公", "start2": 2, "note": "肖山公本人为第 1 世(坚公 124);此处从第 2 世「长」起"}, {"id": "qichang", "label": "奇昌公派", "seq": ["超", "兴", "桂", "明", "道", "立", "德", "举", "善", "进", "良", "显", "宗", "华"], "start1": 125, "sys2": "奇昌公", "start2": 2, "note": "奇昌公本人为第 1 世(坚公 124);此处从第 2 世「超」起。原表备注写「奇昌公 4 代」,与表内「1 世 = 坚公 124」不一致,待查"}], $=id=>document.getElementById(id), by=Object.fromEntries(D.map(p=>[p.id,p]));
const alt=(p,s)=>{const i=s-p.start1;return i>=0&&i<p.seq.length?p.seq[i].split('|'):null};
const cell=(p,s)=>{const a=alt(p,s);return a?`<td class="${a.length>1?'c alt':'c'}" data-p="${p.id}">${a.join('<small>|</small>')}</td>`:'<td></td>'};
const rows=[];for(let s=117;s<=158;s++)rows.push(s);
$('main').tBodies[0].innerHTML=rows.map(s=>{
 const x=(s===141)?' style="color:#c00"':'';
 return `<tr data-s="${s}"><td class="n">${s}</td><td class="n">${s-104}</td>${['baiyan','xixi','guanding'].map(i=>cell(by[i],s).replace('<td ','<td'+x+' ')).join('')}</tr>`}).join('');
$('side').innerHTML=['yu','xiaoshan','qichang'].map(i=>{const p=by[i];
 return `<div><b>${p.label}</b><div class="mut">${p.note}</div><div class="scroll mini"><table><thead><tr><th>坚公世</th><th>${p.sys2}世</th><th>派字</th></tr></thead><tbody>${p.seq.map((c,k)=>`<tr data-s="${p.start1+k}"><td class="n">${p.start1+k}</td><td class="n">${p.start2+k}</td><td class="c" data-p="${i}">${c.split('|').join('<small>|</small>')}</td></tr>`).join('')}</tbody></table></div></div>`}).join('');
$('pai').innerHTML='<option value="">(选择)</option>'+D.map(p=>`<option value="${p.id}">${p.label}</option>`).join('');
function q(){
 document.querySelectorAll('.on').forEach(e=>e.classList.remove('on'));document.querySelectorAll('.hit').forEach(e=>e.classList.remove('hit'));
 const id=$('pai').value,c=$('ch').value.trim(),s=parseInt($('shi').value,10),r=$('res');
 if(!id){r.textContent='请先选择派别。';return}
 const p=by[id];let hits=[];
 if(c){p.seq.forEach((a,k)=>{if(a.split('|').includes(c))hits.push(p.start1+k)});
  if(!hits.length){r.textContent=`「${c}」不在${p.label}的字序里(可能是个人名字,或属于别的派)。`;return}
  r.innerHTML=hits.map(h=>`「${c}」= ${p.label} <b>坚公第 ${h} 世</b> · ${p.sys2}第 ${h-p.start1+p.start2} 世${p.sys2==='入琼'?'':' · 入琼第 '+(h-104)+' 世'}`).join('<br>')}
 else if(s){const a=alt(p,s);if(!a){r.textContent=`${p.label}的字序没有坚公第 ${s} 世。`;return}hits=[s];
  r.innerHTML=`坚公第 ${s} 世 = ${p.sys2}第 ${s-p.start1+p.start2} 世 · ${p.label}字辈:<b>${a.join(' / ')}</b>${a.length>1?'(两种写法,以实际为准)':''}`}
 else{r.textContent='输入一个字或世代。';return}
 hits.forEach(h=>{document.querySelectorAll(`tr[data-s="${h}"]`).forEach(t=>t.classList.add('on'));
  document.querySelectorAll(`tr[data-s="${h}"] td[data-p="${id}"]`).forEach(t=>t.classList.add('hit'))});
 const f=document.querySelector('tr.on');if(f)f.scrollIntoView({block:'center',behavior:'smooth'});
}
['pai','ch','shi'].forEach(i=>$(i).addEventListener('input',q));
$('pai').value='baiyan';
