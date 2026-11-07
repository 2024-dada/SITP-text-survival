/* Pure browser world; all non-measured mechanisms are scenario assumptions. */
(function(G){'use strict';
 const D=G.ISLAND_DATA,H=3600000,EPOCH=Date.UTC(2027,4,1,9),clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
 function rnd(seed,key){let n=(seed>>>0)||1;for(const c of key)n=Math.imul(n^c.charCodeAt(0),16777619)>>>0;n^=n>>>16;return(n>>>0)/4294967296;}
 function inside(p,poly=D.ring){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){let a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
 function edgeDist(p){let best=Infinity;for(let i=0;i<D.ring.length;i++){let a=D.ring[i],b=D.ring[(i+1)%D.ring.length],dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),0,1);best=Math.min(best,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}return best;}
 function terrain(p){if(!inside(p))return 0;let sum=0,weight=0;for(const [x,y,z]of D.dem){const r=Math.hypot(x-p[0],y-p[1]);if(r<.1)return z;let w=1/Math.pow(r,2);sum+=w*z;weight+=w;}return sum/weight*Math.min(1,edgeDist(p)/35);}
 const zoneIndex=new Map(D.zones.map(z=>[Math.floor(z.center[0]/20)+':'+Math.floor(z.center[1]/20),z]));
 function zone(p){let z=zoneIndex.get(Math.floor(p[0]/20)+':'+Math.floor(p[1]/20));return z&&inside(p,z.polygon)?z:D.zones.find(z=>inside(p,z.polygon))||null;}
 function sun(date){let day=Math.floor((date-Date.UTC(date.getUTCFullYear(),0,0))/86400000),decl=23.44*Math.sin(2*Math.PI*(day-81)/365)*Math.PI/180,lat=D.origin.latitude*Math.PI/180,h=(date.getUTCHours()-12)*15*Math.PI/180,alt=Math.asin(Math.sin(lat)*Math.sin(decl)+Math.cos(lat)*Math.cos(decl)*Math.cos(h));let az=(Math.atan2(Math.sin(h),Math.cos(h)*Math.sin(lat)-Math.tan(decl)*Math.cos(lat))*180/Math.PI+180)%360;return{alt:alt*180/Math.PI,az};}
 const byDay=new Map(D.weather.map(r=>[r[0].slice(5),r]));
 function uncachedWeather(hour,seed){const date=new Date(EPOCH+hour*H),y=date.getUTCFullYear(),m=date.getUTCMonth(),day=date.getUTCDate(),days=new Date(Date.UTC(y,m+1,0)).getUTCDate(),shift=y===2027?0:Math.floor(rnd(seed,`rain-shift:${y}:${m}`)*5)-2,refDay=((day-1+shift)%days+days)%days+1,key=`${String(m+1).padStart(2,'0')}-${String(refDay).padStart(2,'0')}`;let row=byDay.get(key)||byDay.get('02-28'),phase=(date.getUTCHours()-14)*Math.PI/12,yearFactor=y===2027?1:.8+rnd(seed,`rain-scale:${y}`)*.4,mm=date.getUTCHours()>=row[6]&&date.getUTCHours()<row[6]+row[7]?row[3]/row[7]*yearFactor:0,cloud=mm>0?.92:rnd(seed,`cloud:${y}:${m}:${day}:${Math.floor(date.getUTCHours()/4)}`)*.7;
 let s=sun(date),tide=.5*Math.cos(2*Math.PI*hour/12.416667),season=[11,0,1].includes(m)?'湿季盛期':[2,3,4].includes(m)?'湿转干过渡':[5,6,7].includes(m)?'干季阶段':'干转湿过渡';return{date,rain:mm,temperature:(row[4]+row[5])/2+(row[4]-row[5])/2*Math.cos(phase),cloud,sun:s,tide,daylight:s.alt>0,label:mm>5?'较强降雨':mm>0?'降雨':cloud>.5?'多云':'晴间多云',season,yearFactor};}
 const weatherCache=new Map();
 function baseWeather(hour,seed){let h=Math.floor(hour),key=seed+':'+h;if(!weatherCache.has(key)){if(weatherCache.size>4096)weatherCache.clear();weatherCache.set(key,uncachedWeather(h,seed));}return weatherCache.get(key);}
 // A slow east-to-west rain-band translation; speed is a scenario setting, not measured wind.
 const RAIN_CROSSING_HOURS=2;
 function weather(hour,seed,p){let cached=baseWeather(hour,seed),w={...cached,date:new Date(EPOCH+hour*H)};if(!p)return w;let delay=clamp((D.bounds[2]-p[0])/(D.bounds[2]-D.bounds[0]),0,1)*RAIN_CROSSING_HOURS;
 let rain=0;for(let i=0;i<4;i++)rain+=baseWeather(hour-delay-i*.125,seed).rain/4;
 let approaching=baseWeather(hour-delay+.5,seed).rain>0;let cloud=rain>0?.94:approaching?Math.max(.78,w.cloud):Math.min(w.cloud,.7);
 return{...w,rain,cloud,label:rain>5?'局地较强降雨':rain>0?'局地降雨':approaching?'雨云接近':'当地无雨',rainDelay:delay};}
 const ECOLOGY_CONFIG={
  habitats:{
   browse:{name:'山羊可食植被折算量',stock:12000,capacity:22000,annualRegrowth:15000,usable:.55,condition:.9,unit:'kg干物质'},
   birdFood:{name:'陆鸟食源折算量',stock:4800,capacity:8000,annualRegrowth:5000,usable:.6,condition:.9,unit:'kg食源折算'},
   reefFood:{name:'礁岸微藻与有机食源折算量',stock:110,capacity:220,annualRegrowth:100,usable:.65,condition:.9,unit:'kg食源折算'},
   fishFood:{name:'鱼类基础食源折算量',stock:4500,capacity:8000,annualRegrowth:5000,usable:.65,condition:.9,unit:'kg食源折算'},
   crabFood:{name:'小型甲壳类食源折算量',stock:550,capacity:900,annualRegrowth:950,usable:.6,condition:.9,unit:'kg食源折算'}
  },
  species:{
   R04:{habitat:'browse',name:'山羊',stage1:90,stage2:210,maturity:300,intake:.36,recruits:.32,adultMortality:.08,youngMortality:.26,juvenileMortality:.12,subadultMortality:.08},
   R08:{habitat:'birdFood',name:'陆鸟合并观察群体',stage1:21,stage2:90,maturity:150,intake:.008,recruits:.45,adultMortality:.15,youngMortality:.38,juvenileMortality:.2,subadultMortality:.12},
   R06:{habitat:'reefFood',name:'普通小型海岸贝类',stage1:30,stage2:120,maturity:240,intake:.00008,recruits:.4,adultMortality:.15,youngMortality:.5,juvenileMortality:.28,subadultMortality:.16},
   R05:{habitat:'fishFood',name:'近海鱼类混合生物量',stage1:30,stage2:180,maturity:365,intake:.02,recruits:.42,adultMortality:.16,youngMortality:.5,juvenileMortality:.28,subadultMortality:.18,step:.1},
   R07:{habitat:'crabFood',name:'近岸小型甲壳类',stage1:30,stage2:90,maturity:180,intake:.001,recruits:.42,adultMortality:.16,youngMortality:.42,juvenileMortality:.24,subadultMortality:.15}
  },
  seasons:{'湿季盛期':1.15,'湿转干过渡':1,'干季阶段':.72,'干转湿过渡':.9}
 };
 function initialEcology(){return{dayRainMm:0,dayTemperature:0,dayHours:0,rainHistory:Array(30).fill(1.5),lastDaily:{rainMm:0,temperature:25,growth:{},consumption:{},foodAdequacy:{}},monthly:Object.fromEntries(Object.keys(ECOLOGY_CONFIG.species).map(r=>[r,{births:0,matured:0,deaths:0}])),habitats:Object.fromEntries(Object.entries(ECOLOGY_CONFIG.habitats).map(([k,v])=>[k,{stock:v.stock,condition:v.condition}])),carrying:Object.fromEntries(Object.keys(ECOLOGY_CONFIG.species).map(r=>[r,0]))};}
 function create(seed=42){return{version:'observation-v4',seed,hour:0,collector:false,water:{W01:.5,W02:0},selected:[D.sites[0].east_m,D.sites[0].north_m],sites:D.sites.map(p=>({id:p.id,wet:p.initial_wetness??.35,pools:p.stocks.map(a=>({...a,amount:a.initial,credit:0,young:[],deathCredit:0,decay:0}))})),ledger:{rain_L:0,evaporated_L:0,overflow_L:0,harvest:{}},ecology:initialEcology(),log:[]};}
 function event(s,text){s.log.push({hour:s.hour,text});if(s.log.length>100)s.log.shift();}
 const siteConfig=new Map(D.sites.map(a=>[a.id,a]));
 const ecoWeatherPoints=[[0,0],[-100,80],[100,80],[0,-180]];
 function currentDay(s){return Math.floor((s.hour+9)/24);}
 function rainFactor(ecology){let h=ecology.rainHistory||[],mean=h.length?h.reduce((v,n)=>v+n,0)/h.length:1.5;return clamp(.55+mean/4,.65,1.2);}
 function populationStages(s,rid,day=currentDay(s)){
  let out={young:0,juvenile:0,subadult:0,adult:0,total:0,equivalent:0};const cfg=ECOLOGY_CONFIG.species[rid];
  for(const site of s.sites)for(const a of site.pools)if(a.resource===rid){out.adult+=a.amount;out.total+=a.amount;for(const c of a.young||[]){let n=c[1],age=day-(Number.isFinite(c[3])?c[3]:c[0]-cfg.maturity);age=Math.max(0,age);let stage=age<cfg.stage1?'young':age<cfg.stage2?'juvenile':age<cfg.maturity?'subadult':'subadult';out[stage]+=n;out.total+=n;}}
  out.equivalent=out.adult+out.young*.18+out.juvenile*.5+out.subadult*.8;return out;
 }
 function hardPopulationCap(s,rid){let n=0;for(const p of s.sites)for(const a of p.pools)if(a.resource===rid)n+=a.capacity;return n;}
 function seasonProductivity(hour,seed){return ECOLOGY_CONFIG.seasons[weather(hour,seed).season]||.82;}
 function ecologicalCarrying(s,rid,day=currentDay(s)){
  const cfg=ECOLOGY_CONFIG.species[rid],base=ECOLOGY_CONFIG.habitats[cfg.habitat],h=s.ecology.habitats[cfg.habitat],land=['browse','birdFood'].includes(cfg.habitat),season=land?seasonProductivity(s.hour,s.seed):1,rain=land?rainFactor(s.ecology):1,stockFactor=.55+.45*Math.sqrt(clamp(h.stock/base.capacity,0,1));
  const k=Math.max(0,base.annualRegrowth*season*rain*h.condition*base.usable*stockFactor/(cfg.intake*365));return rid==='R05'?Math.floor(k*10)/10:Math.floor(k);
 }
 function updateEcosystem(s,day){
  const eco=s.ecology,days=Math.max(.25,eco.dayHours/24),rainMm=eco.dayHours?eco.dayRainMm/days:0,temp=eco.dayHours?eco.dayTemperature/eco.dayHours:25;
  eco.rainHistory.push(rainMm);if(eco.rainHistory.length>30)eco.rainHistory.shift();const rFactor=rainFactor(eco),season=seasonProductivity(s.hour,s.seed),rids=Object.keys(ECOLOGY_CONFIG.species),structures=Object.fromEntries(rids.map(r=>[r,populationStages(s,r,day)])),growth={},consumption={},adequacy={};
  for(const [key,base]of Object.entries(ECOLOGY_CONFIG.habitats)){
   const rid=Object.keys(ECOLOGY_CONFIG.species).find(r=>ECOLOGY_CONFIG.species[r].habitat===key),cfg=ECOLOGY_CONFIG.species[rid],h=eco.habitats[key],land=['browse','birdFood'].includes(key),dailyGrowth=base.annualRegrowth/365*(land?season*rFactor:1)*h.condition*(land?clamp(1-Math.max(0,temp-29)*.025,.72,1):1),demand=structures[rid].equivalent*cfg.intake*days;
   const before=h.stock;h.stock=Math.min(base.capacity,h.stock+dailyGrowth*days);let eaten=Math.min(h.stock,demand);h.stock=Math.max(0,h.stock-eaten);let enough=demand>0?eaten/demand:1;
   const safeGrowth=Math.max(.01,dailyGrowth*base.usable),pressure=demand/days/safeGrowth;h.condition=clamp(h.condition+(1-pressure)*.00035*days,.35,1);
   growth[key]=Math.max(0,h.stock-before+eaten);consumption[key]=eaten;adequacy[rid]=clamp(enough,0,1);
  }
  const matured={},births={},deaths={};
  for(const site of s.sites)for(const a of site.pools){const cfg=ECOLOGY_CONFIG.species[a.resource];if(!cfg)continue;let keep=[];
   for(const c of a.young){let matureDay=c[0],n=c[1],credit=c[2]||0,birthDay=Number.isFinite(c[3])?c[3]:matureDay-cfg.maturity;if(matureDay<=day){a.amount+=n;matured[a.resource]=(matured[a.resource]||0)+n;continue;}
    let age=Math.max(0,day-birthDay),mort=age<cfg.stage1?cfg.youngMortality:age<cfg.stage2?cfg.juvenileMortality:cfg.subadultMortality,shortage=1-(adequacy[a.resource]??1),quantum=cfg.step||1;credit+=n*Math.min(.95,mort+shortage*.7)/365*days;let lost=Math.min(n,Math.floor(credit/quantum)*quantum);n-=lost;credit-=lost;if(lost)deaths[a.resource]=(deaths[a.resource]||0)+lost;if(n>0)keep.push([matureDay,n,credit,birthDay]);
   }
   a.young=keep;let short=1-(adequacy[a.resource]??1),quantum=cfg.step||1;a.deathCredit+=a.amount*Math.min(.95,cfg.adultMortality+short*.5)/365*days;let dead=Math.min(a.amount,Math.floor(a.deathCredit/quantum)*quantum);a.deathCredit-=dead;a.amount-=dead;if(dead)deaths[a.resource]=(deaths[a.resource]||0)+dead;
  }
  const caps=Object.fromEntries(rids.map(r=>[r,ecologicalCarrying(s,r,day)]));
  for(const site of s.sites)for(const a of site.pools){const cfg=ECOLOGY_CONFIG.species[a.resource];if(!cfg)continue;let stages=populationStages(s,a.resource,day),all=stages.total,cap=caps[a.resource],free=Math.max(0,a.capacity-a.amount-a.young.reduce((v,c)=>v+c[1],0));let density=cap>0?clamp(1-.88*all/cap,.12,1):0,food=adequacy[a.resource]??1;let rate=stages.adult>=2?stages.adult*cfg.recruits/365*days*density*food:0;a.credit+=rate;let quantum=cfg.step||1,born=Math.min(free,Math.floor(a.credit/quantum)*quantum);if(free>0)a.credit-=born;else a.credit=0;if(born){let bd=day;a.young.push([day+cfg.maturity,born,0,bd]);births[a.resource]=(births[a.resource]||0)+born;}
  }
  for(const rid of rids){const m=eco.monthly[rid];m.births+=births[rid]||0;m.matured+=matured[rid]||0;m.deaths+=deaths[rid]||0;}
  eco.carrying=caps;eco.lastDaily={rainMm,temperature:temp,growth,consumption,foodAdequacy:adequacy};
  for(const rid of rids)if(day%30===0){let m=eco.monthly[rid],st=populationStages(s,rid,day),label=ECOLOGY_CONFIG.species[rid].name,decimals=rid==='R05'?1:0;if(m.births||m.matured||m.deaths)event(s,`${label}生态月报：新增幼体 ${m.births.toFixed(decimals)}、成熟 ${m.matured.toFixed(decimals)}、自然损失 ${m.deaths.toFixed(decimals)}；当前幼体 ${st.young.toFixed(decimals)}、亚成体 ${(st.juvenile+st.subadult).toFixed(decimals)}、成体 ${st.adult.toFixed(decimals)}（模拟）`);m.births=0;m.matured=0;m.deaths=0;}
  eco.dayRainMm=0;eco.dayTemperature=0;eco.dayHours=0;
 }
 function tick(s,n=1){if(!Number.isInteger(n*4)||n<.25||n>24*366*5)throw Error('单次推进15分钟至5年');for(let h=0;h<n*4;h++){const dt=.25;
  let rainTotal=0,tempTotal=0;for(const p of ecoWeatherPoints){const w=weather(s.hour+dt/2,s.seed,p);rainTotal+=w.rain/ecoWeatherPoints.length;tempTotal+=w.temperature/ecoWeatherPoints.length;}s.ecology.dayRainMm+=rainTotal*dt;s.ecology.dayTemperature+=tempTotal*dt;s.ecology.dayHours+=dt;
  for(const k of ['W01','W02']){if(k==='W02'&&!s.collector)continue;let point=siteConfig.get(k==='W01'?'08':'01'),w=weather(s.hour+dt/2,s.seed,[point.east_m,point.north_m]);let c=D.water[k],loss=Math.min(s.water[k],w.rain?0:c.loss_base_L_per_day/24*dt*clamp(w.temperature/26,.5,1.5)),incoming=w.rain*dt*c.rain_L_per_mm,raw=s.water[k]-loss+incoming,spill=Math.max(0,raw-c.capacity_L);s.water[k]=clamp(raw-spill,0,c.capacity_L);s.ledger.rain_L+=incoming;s.ledger.evaporated_L+=loss;s.ledger.overflow_L+=spill;}
   for(const site of s.sites){let point=siteConfig.get(site.id),w=weather(s.hour+dt/2,s.seed,[point.east_m,point.north_m]);site.wet=clamp(site.wet+(w.rain?.5:-.05)*dt,0,1);for(const a of site.pools){if(ECOLOGY_CONFIG.species[a.resource])continue;let input=a.daily_input/24*dt;
    if(a.resource==='R03'){a.decay+=a.amount*.025/24*dt;let lost=Math.min(a.amount,Math.floor(a.decay));a.decay-=lost;a.amount-=lost;}
    if(['个','只'].includes(a.unit)){a.credit+=input;input=Math.floor(a.credit);a.credit-=input;}a.amount=Math.min(a.capacity,a.amount+input);if(a.amount===a.capacity)a.credit=0;
  }}s.hour+=dt;
  if((s.hour+9)%24===0){
   const day=Math.floor((s.hour+9)/24);updateEcosystem(s,day);
  }
 }return s;}
 function harvest(s,siteId,rid){let p=s.sites.find(x=>x.id===siteId),a=p?.pools.find(x=>x.resource===rid);if(!a||rid==='R08')throw Error('该对象不可试采');if(['R05','R06','R07'].includes(rid)){let w=weather(s.hour,s.seed);if(!w.daylight||w.tide>0)throw Error('当前模拟潮位或昼夜不允许岸边采集');}let q=Math.min(a.amount,['个','只'].includes(a.unit)?1:.5);if(q<=0)throw Error('库存已耗尽');a.amount-=q;s.ledger.harvest[rid]=(s.ledger.harvest[rid]||0)+q;event(s,`${siteId} 试采 ${D.pools[rid].name} ${q} ${a.unit}；仅是研究者扰动，不代表人物动作`);return q;}
 function totals(s){let out={};for(const p of s.sites)for(const a of p.pools){let o=out[a.resource]||(out[a.resource]={amount:0,capacity:0,unit:a.unit});o.amount+=a.amount+(ECOLOGY_CONFIG.species[a.resource]?a.young.reduce((v,c)=>v+c[1],0):0);o.capacity+=a.capacity;}return out;}
 function ecologySummary(s){const day=currentDay(s),items=[];for(const rid of ['R04','R08','R05','R06','R07']){const cfg=ECOLOGY_CONFIG.species[rid],base=ECOLOGY_CONFIG.habitats[cfg.habitat],h=s.ecology.habitats[cfg.habitat],st=populationStages(s,rid,day);items.push({rid,name:cfg.name,foodName:base.name,stock:h.stock,foodCapacity:base.capacity,condition:h.condition,carrying:ecologicalCarrying(s,rid,day),hardCap:hardPopulationCap(s,rid),populationUnit:D.pools[rid].unit,...st,growth:s.ecology.lastDaily.growth[cfg.habitat]||0,consumption:s.ecology.lastDaily.consumption[cfg.habitat]||0,unit:base.unit,foodAdequacy:s.ecology.lastDaily.foodAdequacy[rid]??1});}return items;}
 function validate(x){
  const legacy=x?.version==='observation-v3';
  if(!x||(!legacy&&x.version!=='observation-v4')||!Number.isInteger(x.hour*4)||x.hour<0||x.hour>24*366*100||!Number.isInteger(x.seed)||!Array.isArray(x.sites)||x.sites.length!==D.sites.length||typeof x.collector!=='boolean')throw Error('存档格式或版本不匹配');
  for(let i=0;i<D.sites.length;i++){
   let p=x.sites[i],base=D.sites[i];
   if(!p||p.id!==base.id||!Number.isFinite(p.wet)||p.wet<0||p.wet>1||!Array.isArray(p.pools)||p.pools.length!==base.stocks.length)throw Error('资源点不合法');
   for(let j=0;j<p.pools.length;j++){
    let a=p.pools[j],b=base.stocks[j];
    const oldAnimalCapacity=legacy&&((a?.resource==='R04'&&a.capacity===8)||(a?.resource==='R08'&&a.capacity===12));
    if(!a||a.resource!==b.resource||a.daily_input!==b.daily_input||!Number.isFinite(a.capacity)||a.capacity<0||(a.capacity!==b.capacity&&!oldAnimalCapacity)||!Number.isFinite(a.amount)||a.amount<0||a.amount>a.capacity||!Number.isFinite(a.credit)||a.credit<0||!Array.isArray(a.young))throw Error('资源值不合法');
    for(const c of a.young){const fractional=a.resource==='R05';if(!Array.isArray(c)||c.length<(legacy?2:4)||!Number.isInteger(c[0])||(!fractional&&!Number.isInteger(c[1]))||!Number.isFinite(c[1])||c[1]<0||c[0]<0||(!legacy&&(!Number.isFinite(c[2])||c[2]<0||!Number.isInteger(c[3]))))throw Error('幼体数据不合法');}
    if(a.amount+a.young.reduce((v,k)=>v+k[1],0)>a.capacity)throw Error('种群超过容量');
    if(a.capacity<b.capacity)a.capacity=b.capacity;
   }
  }
  for(const p of x.sites)for(const a of p.pools){if(!['credit','deathCredit','decay'].every(k=>Number.isFinite(a[k])&&a[k]>=0)||!['kg','个','只'].includes(a.unit))throw Error('资源累积值不合法');}
  for(const k of ['W01','W02'])if(!Number.isFinite(x.water?.[k])||x.water[k]<0||x.water[k]>D.water[k].capacity_L)throw Error('水量不合法');
  if(!Array.isArray(x.selected)||x.selected.length!==2||!x.selected.every(Number.isFinite)||!inside(x.selected))throw Error('观察位置不合法');
  if(!Array.isArray(x.log)||x.log.length>100||x.log.some(e=>!Number.isInteger(e.hour*4)||e.hour<0||typeof e.text!=='string')||!x.ledger||!['rain_L','evaporated_L','overflow_L'].every(k=>Number.isFinite(x.ledger[k])&&x.ledger[k]>=0)||!x.ledger.harvest||Object.values(x.ledger.harvest).some(v=>!Number.isFinite(v)||v<0))throw Error('日志或账本不合法');
  if(legacy){for(const site of x.sites)for(const a of site.pools)if(ECOLOGY_CONFIG.species[a.resource]){let oldDelay=a.resource==='R08'?180:365;a.young=a.young.map(c=>[c[0],c[1],0,c[0]-oldDelay]);if(['R05','R07'].includes(a.resource))a.credit=0;}x.version='observation-v4';x.ecology=initialEcology();event(x,'v3存档已迁移至v4：现有种群、资源与时间保留；生态食源从迁移时的模拟基线建立，旧存档没有可恢复的历史取食记录。');}
  if(!x.ecology||!Array.isArray(x.ecology.rainHistory)||x.ecology.rainHistory.length>30||x.ecology.rainHistory.some(v=>!Number.isFinite(v)||v<0)||!x.ecology.habitats||!x.ecology.lastDaily||!x.ecology.monthly)throw Error('生态状态不合法');
  for(const [k,v]of Object.entries(ECOLOGY_CONFIG.habitats)){let h=x.ecology.habitats[k];if(!h||!Number.isFinite(h.stock)||h.stock<0||h.stock>v.capacity||!Number.isFinite(h.condition)||h.condition<.35||h.condition>1)throw Error('食源状态不合法');}
  for(const rid of Object.keys(ECOLOGY_CONFIG.species))if(!x.ecology.monthly[rid]||!['births','matured','deaths'].every(k=>Number.isFinite(x.ecology.monthly[rid][k])&&x.ecology.monthly[rid][k]>=0))throw Error('生态记录不合法');
  for(const k of ['dayRainMm','dayTemperature','dayHours'])if(!Number.isFinite(x.ecology[k])||x.ecology[k]<0)throw Error('天气累计值不合法');
  return x;
 }
 G.IslandModel={D,create,tick,weather,harvest,totals,ecologySummary,inside,terrain,zone,edgeDist,validate,rnd,event,RAIN_CROSSING_HOURS};
})(globalThis);
