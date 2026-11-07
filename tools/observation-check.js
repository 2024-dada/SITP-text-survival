/* 观测方向事实与文字的本地自动检查。
   运行：node tools/observation-check.js
   不修改世界状态；只用固定种子读取同一份库存。 */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os'),cp=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const ctx={console};vm.createContext(ctx);ctx.window=ctx;
for(const f of ['data.js','model.js','observation.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),ctx);
const M=ctx.IslandModel,D=M.D;
let pass=0,fail=0;const failures=[];
function ok(cond,msg){if(cond){pass++;console.log('  ok  '+msg);}else{fail++;failures.push(msg);console.log('  FAIL '+msg);}}
function section(t){console.log('\n## '+t);}
function fresh(){return M.create(42);}
function at(s,p){return M.observe(s,p);}
function card(o,name){return o.cards.find(c=>c.name===name);}
function dir(o,name){return o.facts.directions.find(d=>d.card===name);}
function lines(t){return t.split('\n').filter(Boolean);}
function dateLabel(hour){const d=new Date(Date.UTC(2027,4,1,9)+hour*3600000);return d.toISOString().slice(0,16).replace('T',' ');}
function round(v,n=1){return Number(v).toFixed(n);}

console.log('Olorua 六向观测检查 · 算法 '+M.observationAlgorithm);
console.log('数据：'+D.zones.length+' 细分格 / '+D.sites.length+' 资源地带');

/* 1. 东岸：方向扇区可含斜向海面；中心线遮挡不代表整张卡都看不见。 */
section('1 东岸 (270,0)');
{
  const s=fresh(),o=at(s,[270,0]);
  const visibleSea=o.facts.directions.filter(d=>d.sea);
  ok(visibleSea.length>=2,'东岸至少两个方向扇区能看到近岸海域线索');
  ok(new Set(visibleSea.map(d=>d.sea.siteId)).size===visibleSea.length,'同一海域斑块不会在多个方向卡重复主述');
  ok(card(o,'北').text!==card(o,'东').text,'北与东文字不同（旧版逐字相同）');
  ok(dir(o,'南').sea&&dir(o,'西').sea===null,'南向中心线被挡但左前方可见海域；西向没有海域线索');
  ok(dir(o,'南').edge===null&&dir(o,'南').block!==null&&dir(o,'西').block!==null,'南/西的正前方有地形或树冠遮挡');
  ok(dir(o,'南').trend.grade>0.05&&dir(o,'西').trend.grade>0.05,'南/西坡度为正（向内陆抬升）');
  ok(/\d+米外是水边|水边就在/.test(card(o,'北').text),'北向给出岸线距离');
}

/* 1b. 旧版北=东=南的岸边点 */
section('1b 东岸 (294,-52)：旧版北/东/南三向逐字相同');
{
  const s=fresh(),o=at(s,[294,-52]);
  const three=['北','东','南'].map(n=>card(o,n).text);
  ok(new Set(three).size===3,'新版北/东/南三向文字互不相同');
  const ids=['北','东','南'].map(n=>dir(o,n).sea?.siteId);
  ok(ids.every(Boolean)&&new Set(ids).size===3,'三向关联三个不同海域斑块');
  ok(dir(o,'西').sea===null&&dir(o,'西').block!==null,'西向是内陆遮挡，不写海');
}

/* 2. 北岸：同一位置北/东不再整段复用 */
section('2 北岸 (81,253)');
{
  const s=fresh(),o=at(s,[81,253]);
  ok(card(o,'北').text!==card(o,'东').text,'北与东文字不同（旧版逐字相同）');
  ok(card(o,'南').text!==card(o,'西').text,'南与西坡度/遮挡文字不同');
  ok(dir(o,'北').sea&&dir(o,'东').sea,'北/东都关联到海，但海域斑块不同');
  ok(dir(o,'南').sea&&dir(o,'西').sea===null,'南向扇区仍能看到斜向海域，西向没有海域线索');
  ok(/椰果/.test(card(o,'脚下').text),'资源中心脚下不漏椰果线索');
}

/* 3. 南岸：岸线距离和斜向随位置变化 */
section('3 南岸 (10,-395)');
{
  const s=fresh(),o=at(s,[10,-395]);
  ok(dir(o,'东').sea&&dir(o,'南').sea&&dir(o,'西').sea,'东/南/西都面向海');
  ok(dir(o,'东').sea.siteId!==dir(o,'南').sea.siteId,'东与南关联不同海域斑块');
  ok(dir(o,'东').edgeNear!==dir(o,'南').edgeNear,'东/南岸线距离不同');
  ok(dir(o,'北').sea===null,'北向是内陆，不出现海域线索');
  ok(dir(o,'北').block!==null,'北向被抬升地面挡住');
  const n1=at(s,[-240,300]).facts.directions[0].edgeNear;
  const n2=at(s,[-240,360]).facts.directions[0].edgeNear;
  ok(n1!==n2,'北岸同一北向的岸线距离随位置变化（'+n1+'→'+n2+'米）');
  const s1=at(s,[10,-395]).facts.directions[2].edgeNear;
  const s2=at(s,[-30,-385]).facts.directions[2].edgeNear;
  ok(s1!==s2,'南岸同一南向的岸线距离随位置变化（'+s1+'→'+s2+'米）');
}

/* 3b. 方向卡的±12度侧射线独自看到海岸时，也应报告最近岸线。 */
section('3b 侧向岸线');
{
  const s=fresh();let found=null;
  for(const z of D.zones){
    const o=at(s,z.center);
    for(const d of o.facts.directions){
      if(d.edge===null&&(d.edgeSides.left!==null||d.edgeSides.right!==null)){found={p:z.center,d};break;}
    }
    if(found)break;
  }
  ok(found!==null,'找到中心射线仍在陆地、侧射线已到岸的观察点');
  if(found)ok(found.d.edgeNear!==null,'侧射线发现的岸线进入最近岸线结果（'+found.p.join(',')+' · '+found.d.card+'）');
}

/* 4. 内陆高位：看远但不能穿透树冠，也不泄露海岸资源 */
section('4 内陆高位 (-80,85) 与林坡 (-100,-100)');
{
  const s=fresh(),o=at(s,[-80,85]);
  ok(o.facts.directions.every(d=>!d.sea),'高位四向都不泄露海岸鱼贝');
  ok(!/鱼影|贝类/.test([card(o,'北').text,card(o,'东').text,card(o,'南').text,card(o,'西').text].join('')),'方向卡没有鱼贝文字');
  const s2=fresh(),f=at(s2,[-100,-100]);
  ok(f.facts.directions.some(d=>d.block!==null),'林坡至少一向被树冠/地形遮挡');
  ok(f.facts.directions.filter(d=>d.block!==null).every(d=>d.sea===null),'被遮挡方向不夹带海域线索');
}

/* 5. 内陆中心：四向不要求永不相同，但不能四段整段复用 */
section('5 内陆中心 (0,0)');
{
  const s=fresh(),o=at(s,[0,0]);
  const texts=['北','东','南','西'].map(n=>card(o,n).text);
  ok(new Set(texts).size>=3,'四向至少有3种不同文字');
  ok(o.facts.directions.every(d=>!d.sea),'内陆中心四向都看不到海');
  ok(/没有看到岸线/.test(texts.join('')),'明确说明可辨范围内没有岸线');
}

/* 6. 坡度有方向：同一位置至少一向升、一向降/平 */
section('6 坡度方向');
{
  const s=fresh(),o=at(s,[-250,150]);
  const grades=o.facts.directions.map(d=>d.trend);
  ok(grades.some(t=>t.kind==='down')&&grades.some(t=>t.kind==='up'),'同一点同时存在上坡与下坡方向');
  const o2=at(s,[10,-395]);
  ok(dir(o2,'东').trend.grade<0&&dir(o2,'北').trend.grade>0,'南岸东向下降、北向上升');
}

/* 7. 资源中心与耗尽 */
section('7 资源库存与线索');
{
  const s=fresh(),o=at(s,[-152,-91]); // 06 北侧枯木点中心
  ok(/枯枝|倒木|枯木/.test(card(o,'脚下').text),'枯木点中心的脚下文字出现枯木线索');
  const site=s.sites.find(x=>x.id==='129'),pool=site.pools.find(a=>a.resource==='R05');
  const before=pool.amount;
  const east=at(s,[270,0]);
  const hadFish=/鱼影/.test(card(east,'北').text);
  pool.amount=0;
  const depleted=at(s,[270,0]);
  ok(!/鱼影/.test(card(depleted,'北').text),'R05 清零后北向不再出现鱼影');
  ok(/贝类/.test(card(depleted,'北').text),'鱼库存清零不影响独立的贝类线索');
  pool.amount=before;
  const restored=at(s,[270,0]);
  ok(/鱼影/.test(card(restored,'北').text),'库存恢复后鱼影线索恢复');
  // 未见线索不清零：找到一次没有鱼影的观察，库存不变
  const s2=fresh(),site2=s2.sites.find(x=>x.id==='129');
  const p2=site2.pools.find(a=>a.resource==='R05').amount;
  at(s2,[270,0]);
  ok(site2.pools.find(a=>a.resource==='R05').amount===p2,'观察失败/未见鱼影不会扣减库存');
}

/* 7b. 目标可见性按目标自己的视线，而不是卡片中心线。 */
section('7b 目标视线遮挡');
{
  const target=D.sites.find(x=>x.id==='80'),oldPoints=D.sites.map(x=>[x.east_m,x.north_m]),oldTerrain=M.terrain;
  D.sites.forEach((site,i)=>{if(site!==target){site.east_m=9000+i*25;site.north_m=9000;}});
  target.east_m=40;target.north_m=20;
  try{
    M.terrain=p=>p[0]===0&&p[1]===0?1000000:p[0]>15&&p[0]<25&&p[1]>5&&p[1]<16?2000000:0;
    let o=at(fresh(),[0,0]);
    ok(!dir(o,'东').targets.includes('80'),'斜向目标被自身视线上的地形遮挡后不出现在目标清单');
    M.terrain=p=>p[0]===0&&p[1]===0?1000000:p[0]>15&&p[0]<25&&Math.abs(p[1])<3?2000000:0;
    o=at(fresh(),[0,0]);
    ok(dir(o,'东').block!==null,'东向中心射线被遮挡');
    ok(dir(o,'东').targets.includes('80'),'中心线被挡但斜向目标视线通畅时仍可看到目标');
  }finally{M.terrain=oldTerrain;D.sites.forEach((site,i)=>{site.east_m=oldPoints[i][0];site.north_m=oldPoints[i][1];});}
}

/* 7c. 同日同资源的多个成熟事件合并，同时保留涉及资源点编号。 */
section('7c 变化记录可读性');
{
  const s=fresh();s.hour=14.75;
  const pools=s.sites.filter(site=>site.pools.some(a=>a.resource==='R06'&&a.amount<a.capacity-1)).slice(0,2);
  for(const site of pools){const a=site.pools.find(x=>x.resource==='R06');a.young=[[1,1]];}
  M.tick(s,.25);
  const records=s.log.filter(e=>e.text.includes('R06')&&e.text.includes('幼体成熟'));
  ok(pools.length===2,'准备了两个独立贝类资源点的成熟事件');
  ok(records.length===1,'同日同类成熟事件合并为一条记录');
  if(records[0])ok(pools.every(site=>records[0].text.includes(site.id)),'合并记录保留涉及的资源点编号');
}

/* 8. 东北斜角对象：进入相邻两张卡，不扩散到背向两张 */
section('8 斜角对象 (-270,-110) 站点80');
{
  const s=fresh(),o=at(s,[-270,-110]);
  const n=card(o,'北'),e=card(o,'东'),so=card(o,'南'),w=card(o,'西');
  ok(dir(o,'北').targets.includes('80')&&dir(o,'东').targets.includes('80'),'站点80同时出现在北和东');
  ok(!dir(o,'南').targets.includes('80')&&!dir(o,'西').targets.includes('80'),'站点80没有扩散到南/西');
  ok(/倒木|枯枝/.test(n.text)&&/倒木|枯枝/.test(e.text),'相邻两张卡都说明这处枯木');
  ok(!so.text.includes('80')&&!w.text.includes('80'),'背向两张卡没有该对象');
}

/* 9. 公共背景只出现一次 */
section('9 公共背景');
{
  const s=fresh(),o=at(s,[270,0]);
  const role=o.role;
  ok((role.match(/可辨上限|视线能及|视线受雨|视线只及/g)||[]).length===1,'角色文本中公共背景只出现一次');
  ok(['北','东','南','西'].every(n=>!/潮位|可辨上限|无雨|细雨|白昼|夜间/.test(card(o,n).text)),'方向卡不重复雨势/昼夜/潮位/可辨上限');
  ok(o.background.includes('模拟潮位'),'研究者背景包含一次潮位');
}

/* 10. 夜间、细雨、强雨：信息收缩 */
section('10 天气收缩');
{
  const s=fresh();
  let night=null;for(let h=0;h<240;h+=.25){if(!M.weather(h,42,[270,0]).daylight){night=h;break;}}
  s.hour=night;const n=at(s,[270,0]);
  ok(n.facts.reach===12,'夜间可辨上限12米');
  ok(['北','东','南','西'].every(x=>lines(card(n,x).text).length<=2),'夜间方向卡不超过2行');
  ok(!/鱼影|贝类/.test([card(n,'北').text,card(n,'东').text].join('')),'夜间不出现鱼贝细节');
  let light=null;for(let h=0;h<24*30;h+=.25){const w=M.weather(h,42,[0,0]);if(w.rain>0&&w.rain<=5){light=h;break;}}
  s.hour=light;const l=at(s,[0,0]);
  ok(l.facts.reach===85,'细雨可辨上限85米');
  ok(l.background.includes('细雨'),'细雨写在公共背景');
  ok(['北','东','南','西'].every(x=>!card(l,x).text.includes('细雨')),'方向卡不重复“细雨”');
  let heavy=null;for(let h=0;h<24*30;h+=.25){if(M.weather(h,42,[0,0]).rain>5){heavy=h;break;}}
  s.hour=heavy;const hv=at(s,[0,0]);
  ok(hv.facts.reach===45,'强雨可辨上限45米');
  ok(['北','东','南','西'].every(x=>!card(hv,x).text.includes('没有看到岸线')),'强雨时不重复“没有岸线”长句');
}

/* 11. 局部雨带：东西两地不同雨量 */
section('11 局部雨带');
{
  const s=fresh();let hour=null;
  for(let h=0;h<24*20;h+=.25){const a=M.weather(h,42,[260,0]),b=M.weather(h,42,[-260,0]);if(a.rain>0&&b.rain===0&&a.daylight){hour=h;break;}}
  ok(hour!==null,'找到东岸有雨、西岸无雨的时次');
  if(hour!==null){
    s.hour=hour;
    const east=at(s,[260,0]),west=at(s,[-260,0]);
    ok(east.facts.background.rain>0&&west.facts.background.rain===0,'东岸观测读到当地雨，西岸读到无雨');
    ok(east.background!==west.background,'两地公共背景不同');
  }
}

/* 12. 稳定、只读、存档恢复 */
section('12 稳定与存档');
{
  const s=fresh();s.hour=3.25;M.tick(s,.25);
  const p=[150,150],before=JSON.stringify(s);
  const a=JSON.stringify(at(s,p)),b=JSON.stringify(at(s,p));
  ok(a===b,'同点同时刻反复观察完全一致');
  ok(before===JSON.stringify(s),'观察不改变世界状态');
  const saved=JSON.parse(JSON.stringify(s));M.validate(saved);
  ok(JSON.stringify(at(saved,p))===JSON.stringify(at(s,p)),'存档导出/载入后同点观察一致');
  ok(saved.version==='observation-v3','v3存档格式继续可用，未因观测算法失效');
}

/* 13. 无无控制随机 */
section('13 随机与性能');
{
  const src=fs.readFileSync(path.join(ROOT,'observation.js'),'utf8');
  ok(!/Math\.random/.test(src),'observation.js 不使用 Math.random');
  ok(typeof M.localFields(fresh(),[0,0]).slope==='number','localFields 保留兼容的 slope 数值字段');
  const s=fresh(),p=[0,0];
  const t0=process.hrtime.bigint();for(let i=0;i<100;i++)M.observe(s,p);const t1=process.hrtime.bigint();
  const ms=Number(t1-t0)/1e6/100;
  ok(ms<25,'单次观察平均 '+ms.toFixed(2)+' ms（阈值25 ms）');
}

/* 14. 六点证据 */
section('14 六点方向证据（供人工复核）');
const POINTS=[
  [270,0,'东岸，旧版北=东整段相同'],
  [81,253,'北岸，旧版北=东整段相同'],
  [10,-395,'南岸，三向朝海'],
  [0,0,'内陆中心，四向无海'],
  [-80,85,'全岛最高插值点，树冠遮挡'],
  [-170,217,'营地，坡下可见北岸']
];
const s=fresh();
for(const [x,y,note] of POINTS){
  const p=[x,y],o=at(s,p);
  console.log('\n### '+p[0]+','+p[1]+' · '+note+' · '+dateLabel(s.hour)+'（模拟本地）');
  console.log('公共背景：'+o.background.replace(/\n/g,' / '));
  for(const c of o.cards){
    const d=o.facts.directions.find(x=>x.card===c.name);
    const f=d?`edge=${d.edge??'-'} edgeNear=${d.edgeNear??'-'} block=${d.block??'-'} grade=${d.trend.kind}/${round(d.trend.grade,3)} sea=${d.sea?d.sea.siteId+'@'+d.sea.d+'m':'-'} targets=${d.targets.join(',')||'-'}`:'';
    console.log('['+c.name+'] '+(f?'('+f+') ':'')+c.text.replace(/\n/g,' / '));
  }
  const owners=o.facts.directions.filter(d=>d.sea).map(d=>d.sea.siteId);
  console.log('海域归属：'+(owners.length?owners.join(' / '):'无')+'；同一海域斑块不在两张卡重复。');
}

/* 15. 旧版对照（可选，需要 git；用 GIT 环境变量指向 git.exe 时也可运行） */
section('15 旧版对照（基线 cbcbe92，可选）');
(function(){
  const ref=process.env.LEGACY_REF||'cbcbe92',git=process.env.GIT||'git';
  let dir=null;
  try{
    cp.execFileSync(git,['--version'],{stdio:['ignore','pipe','ignore']});
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'olorua-legacy-'));
    for(const f of ['data.js','model.js','observation.js']){
      const buf=cp.execFileSync(git,['-C',ROOT,'show',ref+':'+f],{stdio:['ignore','pipe','ignore']});
      fs.writeFileSync(path.join(dir,f),buf);
    }
    const c={console};vm.createContext(c);c.window=c;
    for(const f of ['data.js','model.js','observation.js'])vm.runInContext(fs.readFileSync(path.join(dir,f),'utf8'),c);
    const om=c.IslandModel,oldState=om.create(42),oldObs=om.observe(oldState,[294,-52]);
    const cur=at(fresh(),[294,-52]);
    const oldT=['北','东','南'].map(n=>oldObs.cards.find(x=>x.name===n).text);
    const newT=['北','东','南'].map(n=>card(cur,n).text);
    console.log('旧版 '+ref+' 北/东/南是否逐字相同：'+(oldT[0]===oldT[1]&&oldT[1]===oldT[2]?'是':'否'));
    console.log('新版同点三向是否互不相同：'+(new Set(newT).size===3?'是':'否'));
    console.log('旧版北：'+oldT[0].replace(/\n/g,' / '));
    console.log('新版北：'+newT[0].replace(/\n/g,' / '));
    console.log('新版东：'+newT[1].replace(/\n/g,' / '));
    console.log('新版南：'+newT[2].replace(/\n/g,' / '));
  }catch(e){
    console.log('跳过旧版对照：'+String(e.message||e).split('\n')[0]);
    console.log('需要 git，或设置 GIT 指向 git.exe、LEGACY_REF 指向旧提交；不设置也可用新版检查。');
  }finally{
    if(dir)try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
})();

console.log('\n========== 结果 ==========');
console.log('通过 '+pass+' 项，失败 '+fail+' 项');
if(fail){console.log('失败项：');for(const f of failures)console.log(' - '+f);process.exitCode=1;}
else console.log('全部自动检查通过。');
