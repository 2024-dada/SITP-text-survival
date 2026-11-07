'use strict';
const M=IslandModel,D=M.D,$=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
let state=M.create(),position=state.selected.slice(),locked=false,timer=null,toastTimer=null,lastMove=0,mapPan=null,suppressMapClick=false;
function svg(tag,attrs,text){let n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;return n;}
function path(poly){return poly.map((p,i)=>(i?'L':'M')+p[0]+','+(-p[1])).join(' ')+'Z';}
function toast(text){$('toast').textContent=text;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',4000);}
function dateLabel(date){return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')} ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;}
function drawBase(){
 $('coast').setAttribute('d',path(D.ring));$('clipPath').setAttribute('d',path(D.ring));
 for(const z of D.zones){let p=svg('path',{d:path(z.polygon),fill:({shore:'#d9d3ad',woodland:'#a9c49c',scrub:'#c5cca3'})[z.biome],stroke:'#82976b','stroke-width':.7,'stroke-dasharray':'2 3'});$('regions').append(p);let x=z.polygon.reduce((s,p)=>s+p[0],0)/z.polygon.length,y=z.polygon.reduce((s,p)=>s+p[1],0)/z.polygon.length;if(z.area_m2>3000)$('zoneLabels').append(svg('text',{x,y:-y,'font-size':11,fill:'#57764f','text-anchor':'middle','opacity':'.65'},z.id));}
 // Contours use the same interpolated terrain as the observation engine.
 for(let x=-330;x<330;x+=12)for(let y=-450;y<450;y+=12){if(!M.inside([x,y]))continue;let a=M.terrain([x,y]),b=M.terrain([x+12,y]),c=M.terrain([x,y+12]);for(let level=10;level<=50;level+=10){if((a<level)!==(b<level)){let px=x+12*(level-a)/(b-a);$('contours').append(svg('path',{d:`M${px},${-y}v-8`,stroke:'#799565','stroke-width':.8,opacity:.45}));}if((a<level)!==(c<level)){let py=y+12*(level-a)/(c-a);$('contours').append(svg('path',{d:`M${x},${-py}h8`,stroke:'#799565','stroke-width':.8,opacity:.45}));}}}
 for(const s of D.sites){let g=svg('g',{transform:`translate(${s.east_m},${-s.north_m})`});g.append(svg('circle',{r:Number(s.id)>14?3.5:10,fill:['08','14'].includes(s.id)?'#337b8c':'#38634a',stroke:'#fffef9','stroke-width':2}));if(Number(s.id)<=14)g.append(svg('text',{y:3.6,'text-anchor':'middle','font-size':9,fill:'white'},s.id));$('resources').append(g);}
}

function drawRain(){let layer=$('localRain');layer.replaceChildren();for(let x=D.bounds[0];x<D.bounds[2];x+=25){let w=M.weather(state.hour,state.seed,[x+12.5,0]);if(w.rain<=0&&w.cloud<.78)continue;layer.append(svg('rect',{x,y:-600,width:25,height:1200,fill:w.rain>0?'#4582a8':'#7d8b99',opacity:w.rain>0?Math.min(.48,.15+w.rain*.025):.12}));} }
function render(){const w=M.weather(state.hour,state.seed,position),obs=M.observe(state,position);$('date').textContent=dateLabel(w.date);$('season').textContent=w.season+' · '+w.label;$('currentWeather').textContent=`${w.temperature.toFixed(1)} ℃ / ${w.rain.toFixed(1)} mm·h⁻¹ / ${w.daylight?'白昼':'夜间'}`;$('rainLayer').setAttribute('opacity',0);drawRain();$('nightLayer').setAttribute('opacity',w.daylight?0:.45);$('viewStatus').textContent=locked?'点击已固定 · 时间仍在演化':'随鼠标预览';$('unlock').textContent=locked?'恢复鼠标预览':'鼠标预览';$('marker').setAttribute('transform',`translate(${position[0]},${-position[1]})`);$('position').textContent=`1 m 模拟格 · E ${position[0]} / N ${position[1]} m · 高程插值 ${M.terrain(position).toFixed(1)} m`;
 $('background').textContent=obs.background||'';$('cards').replaceChildren();for(const c of obs.cards){let card=document.createElement('article');card.className='viewCard'+(['上方','脚下'].includes(c.name)?' vertical':'');let h=document.createElement('h3'),small=document.createElement('span'),p=document.createElement('p');h.textContent=c.name;small.textContent=c.reach?`可辨上限约 ${c.reach} m`:'垂直观察';h.append(small);p.textContent=c.text;card.append(h,p);$('cards').append(card);}
 $('roleText').textContent=(obs.frame||'')+'\n\n'+obs.role;$('regionTitle').textContent=obs.zone?obs.zone.id+' · '+obs.zone.name:'陆地区域';$('localInfo').textContent=obs.valid?`此处属于${obs.zone?.name||'岸缘'}，20米细分格面积约 ${obs.zone?.area_m2||0} m²。树冠覆盖约 ${Math.round((obs.local?.canopy||0)*100)}%，地表湿润指数 ${Math.round((obs.local?.wet||0)*100)}。观测算法 ${obs.algorithm||'obs-dir-v4'}：按方向分别采样近/中/远景、坡度、岸线与视线遮挡。仅研究者可见，均为模拟值；1米内插不代表实测。按方向键可逐米移动固定观察点。`:'将鼠标放在陆地上。';
 $('nearby').replaceChildren();let near=D.sites.filter(s=>Math.hypot(s.east_m-position[0],s.north_m-position[1])<45).sort((a,b)=>Math.hypot(a.east_m-position[0],a.north_m-position[1])-Math.hypot(b.east_m-position[0],b.north_m-position[1]));for(const s of near){let div=document.createElement('div');div.className='target';let head=document.createElement('strong');head.textContent=s.id+' · '+s.name;div.append(head);let local=state.sites.find(p=>p.id===s.id);for(const a of local.pools){let row=document.createElement('div');row.textContent=`${D.pools[a.resource].name}：${a.amount.toFixed(a.unit==='kg'?1:0)} / ${a.capacity} ${a.unit}`;div.append(row);if(a.resource!=='R08'){let b=document.createElement('button');b.textContent='研究试采';b.onclick=()=>{try{M.harvest(state,s.id,a.resource);render();}catch(e){toast(e.message);}};div.append(b);}}
 if(s.id==='08'){let r=document.createElement('p');r.textContent=`岩池 ${state.water.W01.toFixed(2)} / 1 L（原水）`;div.append(r);}if(s.id==='01'){let r=document.createElement('p');r.textContent=state.collector?`集雨器 ${state.water.W02.toFixed(2)} / 10 L`:'集雨器尚未建成';div.append(r);}$('nearby').append(div);}
 if(!near.length){let p=document.createElement('small');p.textContent='45米内没有已配置的资源地带；景物仍由局部地形与植被生成。';$('nearby').append(p);}
 $('collector').disabled=state.collector;$('collector').textContent=state.collector?'集雨器已存在':'在营地设置集雨器';
 $('forecast').replaceChildren();for(let i=0;i<24;i++){let f=M.weather(state.hour+i,state.seed,position),a=document.createElement('article');a.className=i===0?'now':'';for(const [cls,text]of [['time',i===0?'现在':String(f.date.getUTCHours()).padStart(2,'0')+':'+String(f.date.getUTCMinutes()).padStart(2,'0')],['icon',f.rain?'☂':!f.daylight?'☾':f.cloud>.5?'☁':'☀'],['temp',f.temperature.toFixed(0)+'°'],['rain',f.rain.toFixed(1)+' mm/h'],['label',f.label]]){let n=document.createElement('div');n.className=cls;n.textContent=text;a.append(n);}$('forecast').append(a);}
 $('waterStats').replaceChildren();for(const [name,value]of [['岩池 W01',state.water.W01.toFixed(2)+' L'],['集雨 W02',state.collector?state.water.W02.toFixed(2)+' L':'未建'],['潮位 · 模拟',w.tide.toFixed(2)+' m']]){let box=document.createElement('div'),label=document.createElement('small'),v=document.createElement('strong');label.textContent=name;v.textContent=value;box.append(label,v);$('waterStats').append(box);}
 $('ecoStats').replaceChildren();for(const e of M.ecologySummary(state)){let card=document.createElement('article'),title=document.createElement('h3'),stock=document.createElement('p'),stages=document.createElement('p'),capacity=document.createElement('p'),meter=document.createElement('div'),fill=document.createElement('i'),foodDp=e.rid==='R06'||e.rid==='R05'?1:0,popDp=e.populationUnit==='kg'?1:0;card.className='ecoCard';title.textContent=e.name;stock.textContent=`${e.foodName}：${e.stock.toFixed(foodDp)} / ${e.foodCapacity} ${e.unit}；最近结算恢复 ${e.growth.toFixed(foodDp)}、取食 ${e.consumption.toFixed(foodDp)} ${e.unit}`;stages.textContent=`族群总量 ${e.total.toFixed(popDp)} ${e.populationUnit}：幼体 ${e.young.toFixed(popDp)} · 青年/稚体 ${e.juvenile.toFixed(popDp)} · 亚成体 ${e.subadult.toFixed(popDp)} · 成体/繁殖阶段 ${e.adult.toFixed(popDp)}`;capacity.textContent=`食源推算承载量约 ${e.carrying.toFixed(popDp)} ${e.populationUnit} · 场景硬上限 ${e.hardCap} ${e.populationUnit} · 栖地状态 ${Math.round(e.condition*100)}%`;meter.className='ecoMeter';fill.style.width=100*e.condition+'%';meter.append(fill);card.append(title,stock,stages,capacity,meter);$('ecoStats').append(card);}
 let table=document.createElement('table');table.innerHTML='<thead><tr><th>资源</th><th>现有 / 场景上限</th><th>库存比例</th></tr></thead>';let tbody=document.createElement('tbody');for(const [rid,a]of Object.entries(M.totals(state))){let tr=document.createElement('tr'),name=document.createElement('td'),n=document.createElement('td'),bar=document.createElement('td'),track=document.createElement('div'),fill=document.createElement('i');name.textContent=D.pools[rid].name;n.textContent=`${a.amount.toFixed(a.unit==='kg'?1:0)} / ${a.capacity} ${a.unit}`;track.className='bar';fill.style.width=100*a.amount/a.capacity+'%';track.append(fill);bar.append(track);tr.append(name,n,bar);tbody.append(tr);}table.append(tbody);$('stockTable').replaceChildren(table);
 $('events').replaceChildren();let entries=state.log.slice().reverse();if(!entries.length)entries=[{hour:state.hour,text:'世界已初始化。推进时间会演化自然状态；研究试采后会记录扰动。'}];for(const e of entries){let p=document.createElement('p'),t=document.createElement('small');t.textContent=dateLabel(M.weather(e.hour,state.seed).date)+' · ';p.append(t,document.createTextNode(e.text));$('events').append(p);}}
function pause(){if(timer){clearInterval(timer);timer=null;}$('play').textContent='▶ 自动';}
function step(n){M.tick(state,n);state.selected=position.slice();render();}
// Camera only: zoom never modifies world time, selected position or inventories.
const fullMapView={x:-380,y:-525,width:820,height:1030};
const mapPanZoomThreshold=1.05,mapDragThreshold=3;
function mapCoordinates(e){let pt=$('map').createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform($('map').getScreenCTM().inverse());}
function mapCoordinatesWith(e,matrix){let pt=$('map').createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform(matrix);}
function mapPoint(e){let pt=mapCoordinates(e);return[Math.floor(pt.x),Math.floor(-pt.y)];}
function mapZoom(){return fullMapView.width/$('map').viewBox.baseVal.width;}
function updateMapCursor(){$('map').classList.toggle('panReady',mapZoom()>mapPanZoomThreshold);}
function finishMapPan(e,cancelled=false){if(!mapPan)return;const pan=mapPan,map=$('map');mapPan=null;map.classList.remove('mapPanning');if(map.hasPointerCapture(pan.pointerId))map.releasePointerCapture(pan.pointerId);suppressMapClick=!cancelled&&pan.dragged;if(!cancelled&&pan.dragged&&!locked&&e){const p=mapPoint(e);if(M.inside(p)){position=p;state.selected=p.slice();render();}}}
function resetMapView(){if(mapPan)finishMapPan(null,true);$('map').setAttribute('viewBox',`${fullMapView.x} ${fullMapView.y} ${fullMapView.width} ${fullMapView.height}`);$('zoomLevel').textContent='1.0×';updateMapCursor();}
$('map').addEventListener('wheel',e=>{
 if(e.ctrlKey)return; // Preserve the browser's Ctrl+wheel accessibility zoom.
 e.preventDefault();
 if(mapPan)return;
 const map=$('map'),v=map.viewBox.baseVal,anchor=mapCoordinates(e);
 const unit=e.deltaMode===1?16:e.deltaMode===2?map.clientHeight:1;
 const delta=Math.max(-120,Math.min(120,e.deltaY*unit));
 const width=Math.max(fullMapView.width/12,Math.min(fullMapView.width,v.width*Math.exp(delta*.002)));
 if(Math.abs(width-v.width)<.000001)return;
 if(width>=fullMapView.width){resetMapView();return;}
 const ratio=width/v.width,x=anchor.x+(v.x-anchor.x)*ratio,y=anchor.y+(v.y-anchor.y)*ratio;
 map.setAttribute('viewBox',`${x} ${y} ${width} ${v.height*ratio}`);
 $('zoomLevel').textContent=(fullMapView.width/width).toFixed(1)+'×';
 updateMapCursor();
},{passive:false});
$('resetView').onclick=resetMapView;
$('map').addEventListener('pointerdown',e=>{
 suppressMapClick=false;
 if(e.pointerType!=='mouse'||e.button!==0||mapZoom()<=mapPanZoomThreshold)return;
 const map=$('map'),v=map.viewBox.baseVal,inverse=map.getScreenCTM().inverse();
 mapPan={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,origin:mapCoordinatesWith(e,inverse),inverse,view:{x:v.x,y:v.y,width:v.width,height:v.height},dragged:false};
 map.setPointerCapture(e.pointerId);
});
$('map').addEventListener('pointermove',e=>{
 if(mapPan&&mapPan.pointerId===e.pointerId){
  const pan=mapPan,dx=e.clientX-pan.startX,dy=e.clientY-pan.startY;
  if(!pan.dragged&&Math.hypot(dx,dy)<mapDragThreshold)return;
  pan.dragged=true;$('map').classList.add('mapPanning');
  const point=mapCoordinatesWith(e,pan.inverse),view=pan.view;
  const x=Math.max(fullMapView.x,Math.min(fullMapView.x+fullMapView.width-view.width,view.x-(point.x-pan.origin.x)));
  const y=Math.max(fullMapView.y,Math.min(fullMapView.y+fullMapView.height-view.height,view.y-(point.y-pan.origin.y)));
  $('map').setAttribute('viewBox',`${x} ${y} ${view.width} ${view.height}`);
  return;
 }
 if(locked||performance.now()-lastMove<60)return;lastMove=performance.now();let p=mapPoint(e);if(M.inside(p)){position=p;state.selected=p.slice();render();}
});
$('map').addEventListener('pointerup',e=>finishMapPan(e));
$('map').addEventListener('pointercancel',e=>finishMapPan(e,true));
$('map').addEventListener('lostpointercapture',e=>{if(mapPan&&mapPan.pointerId===e.pointerId)finishMapPan(e,true);});
$('map').addEventListener('click',e=>{if(suppressMapClick){suppressMapClick=false;e.preventDefault();return;}let p=mapPoint(e);if(!M.inside(p)){toast('当前点在海面，请选择陆地内的观察位置。');return;}position=p;locked=true;state.selected=p.slice();render();});
$('map').addEventListener('keydown',e=>{let d={ArrowUp:[0,1],ArrowRight:[1,0],ArrowDown:[0,-1],ArrowLeft:[-1,0]}[e.key];if(!d)return;e.preventDefault();let p=[position[0]+d[0],position[1]+d[1]];if(M.inside(p)){position=p;locked=true;state.selected=p.slice();render();}});
$('unlock').onclick=()=>{locked=!locked;render();};document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{pause();step(Number(b.dataset.step));});
$('play').onclick=()=>{if(timer){pause();return;}$('play').textContent='Ⅱ 暂停';timer=setInterval(()=>step(.25),1000);};document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
$('showSites').onchange=e=>$('resources').style.display=e.target.checked?'':'none';$('showZones').onchange=e=>{$('zoneLabels').style.display=e.target.checked?'':'none';$('regions').querySelectorAll('path').forEach(p=>p.setAttribute('stroke-opacity',e.target.checked?'1':'0'));};
$('collector').onclick=()=>{state.collector=true;M.event(state,'研究者在营地设置集雨器：0/10 L，自下一小时开始集雨；非角色制作');render();};
$('reset').onclick=()=>{if(!confirm('重置实验？请先保存需要保留的存档。'))return;pause();state=M.create(state.seed);position=state.selected.slice();locked=false;render();};
$('save').onclick=()=>{state.selected=position.slice();let a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));a.href=url;a.download='Olorua-观测存档-'+state.hour+'h.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('load').onclick=()=>$('file').click();$('file').onchange=async e=>{let f=e.target.files[0];if(!f)return;if(f.size>2*1024*1024){toast('存档超过2MB，请检查文件。');return;}try{let obj=JSON.parse(await f.text());M.validate(obj);pause();state=obj;position=state.selected.slice();locked=true;render();toast('存档已载入。');}catch(err){toast('未载入：'+err.message);}e.target.value='';};
$('help').onclick=()=>$('guide').showModal();$('closeHelp').onclick=()=>$('guide').close();$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('roleText').textContent);toast('已复制角色观察文字。');}catch{toast('无法访问剪贴板，请手动选择并复制文字。');}};
drawBase();render();updateMapCursor();

$('nextRain').onclick=()=>{pause();let target=null;for(let i=1;i<=24*60*4;i++){let h=state.hour+i*.25;if(M.weather(h,state.seed).rain>0&&M.weather(h-.25,state.seed).rain===0){target=Math.max(state.hour,h-.25);break;}}if(target!==null){if(target>state.hour)step(target-state.hour);toast('已到下一场雨进入东岸前；按+15分钟观察雨带向西推进。');}else toast('未来60天未找到新的降雨起点。');};
