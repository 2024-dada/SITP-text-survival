'use strict';
const M=IslandModel,D=M.D,$=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
let state=M.create(),position=state.selected.slice(),locked=false,timer=null,toastTimer=null,lastMove=0,mapPan=null,suppressMapClick=false;
function svg(tag,attrs,text){let n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;return n;}
function path(poly){return poly.map((p,i)=>(i?'L':'M')+p[0]+','+(-p[1])).join(' ')+'Z';}
function toast(text){$('toast').textContent=text;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',4000);}
function dateLabel(date){return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')} ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;}
const previewDialog=$('textPreview'),previewBody=$('textPreviewBody'),previewHeading=$('textPreviewHeading'),previewZoom=$('textPreviewZoom');let previewScale=1;
function makePreviewable(el,title,kind='text'){el.dataset.textPreview='true';el.dataset.previewTitle=title;el.dataset.previewKind=kind;el.tabIndex=0;el.setAttribute('role',el.querySelector('button,a,input')?'group':'button');el.setAttribute('aria-label',`点击放大查看：${title}`);}
function openTextPreview(source){let copy=source.cloneNode(true),kind=source.dataset.previewKind||'text';copy.classList.add('previewCard',`previewKind-${kind}`);copy.removeAttribute('data-text-preview');copy.removeAttribute('tabindex');copy.removeAttribute('role');copy.removeAttribute('aria-label');copy.querySelectorAll('button').forEach(b=>b.remove());previewHeading.textContent=source.dataset.previewTitle||'文字放大预览';previewBody.replaceChildren(copy);previewScale=1;copy.style.transform='scale(1)';previewZoom.textContent='100%';previewDialog.showModal();$('closeTextPreview').focus();}
function closeTextPreview(){if(previewDialog.open)previewDialog.close();}
function previewScaleLimit(card){const stage=$('textPreviewStage');return Math.max(1,Math.min(3,(stage.clientWidth-24)/card.offsetWidth,(stage.clientHeight-24)/card.offsetHeight));}
for(const el of document.querySelectorAll('.backgroundNote,.rolePanel pre'))makePreviewable(el,el.classList.contains('backgroundNote')?'六向观测背景':'角色观测文本',el.classList.contains('backgroundNote')?'background':'role');
document.addEventListener('click',e=>{if(previewDialog.open)return;const card=e.target.closest('[data-text-preview="true"]');if(!card||e.target.closest('button,a,input,label,summary'))return;openTextPreview(card);});
document.addEventListener('keydown',e=>{if(previewDialog.open||(e.key!=='Enter'&&e.key!==' ')||e.target.closest('button,a,input,label,summary'))return;const card=e.target.closest('[data-text-preview="true"]');if(card){e.preventDefault();openTextPreview(card);}});
previewDialog.addEventListener('click',e=>{if(!e.target.closest('.previewCard'))closeTextPreview();});
previewDialog.addEventListener('wheel',e=>{if(!previewDialog.open||e.ctrlKey)return;e.preventDefault();const card=previewBody.firstElementChild;if(!card)return;const limit=previewScaleLimit(card),factor=e.deltaY<0?1.12:1/1.12;previewScale=Math.max(1,Math.min(limit,previewScale*factor));card.style.transform=`scale(${previewScale})`;previewZoom.textContent=`${Math.round(previewScale*100)}%`;},{passive:false});
previewDialog.addEventListener('close',()=>{previewBody.replaceChildren();previewScale=1;previewZoom.textContent='100%';});
 $('closeTextPreview').addEventListener('click',closeTextPreview);
function drawBase(){
 $('coast').setAttribute('d',path(D.ring));$('clipPath').setAttribute('d',path(D.ring));
 for(const z of D.zones){let p=svg('path',{d:path(z.polygon),fill:({shore:'#d9d3ad',woodland:'#a9c49c',scrub:'#c5cca3'})[z.biome],stroke:'#82976b','stroke-width':.7,'stroke-dasharray':'2 3'});$('regions').append(p);let x=z.polygon.reduce((s,p)=>s+p[0],0)/z.polygon.length,y=z.polygon.reduce((s,p)=>s+p[1],0)/z.polygon.length;if(z.area_m2>3000)$('zoneLabels').append(svg('text',{x,y:-y,'font-size':11,fill:'#57764f','text-anchor':'middle','opacity':'.65'},z.id));}
 // Contours use the same interpolated terrain as the observation engine.
 for(let x=-330;x<330;x+=12)for(let y=-450;y<450;y+=12){if(!M.inside([x,y]))continue;let a=M.terrain([x,y]),b=M.terrain([x+12,y]),c=M.terrain([x,y+12]);for(let level=10;level<=50;level+=10){if((a<level)!==(b<level)){let px=x+12*(level-a)/(b-a);$('contours').append(svg('path',{d:`M${px},${-y}v-8`,stroke:'#799565','stroke-width':.8,opacity:.45}));}if((a<level)!==(c<level)){let py=y+12*(level-a)/(c-a);$('contours').append(svg('path',{d:`M${x},${-py}h8`,stroke:'#799565','stroke-width':.8,opacity:.45}));}}}
 for(const s of D.sites){let g=svg('g',{transform:`translate(${s.east_m},${-s.north_m})`});g.append(svg('circle',{r:Number(s.id)>14?3.5:10,fill:['08','14'].includes(s.id)?'#337b8c':'#38634a',stroke:'#fffef9','stroke-width':2}));if(Number(s.id)<=14)g.append(svg('text',{y:3.6,'text-anchor':'middle','font-size':9,fill:'white'},s.id));$('resources').append(g);}
}

function drawRain(){let layer=$('localRain');layer.replaceChildren();for(let x=D.bounds[0];x<D.bounds[2];x+=25){let w=M.weather(state.hour,state.seed,[x+12.5,0]);if(w.rain<=0&&w.cloud<.78)continue;layer.append(svg('rect',{x,y:-600,width:25,height:1200,fill:w.rain>0?'#4582a8':'#7d8b99',opacity:w.rain>0?Math.min(.48,.15+w.rain*.025):.12}));} }
function render(){const w=M.weather(state.hour,state.seed,position),obs=M.observe(state,position);$('date').textContent=dateLabel(w.date);$('season').textContent=w.season+' · '+w.label;$('currentWeather').textContent=`${w.temperature.toFixed(1)} ℃ / ${w.rain.toFixed(1)} mm·h⁻¹ / ${w.daylight?'白昼':'夜间'}`;$('rainLayer').setAttribute('opacity',0);drawRain();$('nightLayer').setAttribute('opacity',w.daylight?0:.45);$('viewStatus').textContent=locked?'点击已固定 · 时间仍在演化':'随鼠标预览';$('unlock').textContent=locked?'恢复鼠标预览':'鼠标预览';$('marker').setAttribute('transform',`translate(${position[0]},${-position[1]})`);$('position').textContent=`1 m 模拟格 · E ${position[0]} / N ${position[1]} m · 高程插值 ${M.terrain(position).toFixed(1)} m`;
 $('background').textContent=obs.background||'';$('cards').replaceChildren();for(const c of obs.cards){let card=document.createElement('article');card.className='viewCard'+(['上方','脚下'].includes(c.name)?' vertical':'');let h=document.createElement('h3'),small=document.createElement('span'),p=document.createElement('p');h.textContent=c.name;small.textContent=c.reach?`可辨上限约 ${c.reach} m`:'垂直观察';h.append(small);p.textContent=c.text;card.append(h,p);makePreviewable(card,`${c.name}方向景象`,'view');$('cards').append(card);}
 $('roleText').textContent=(obs.frame||'')+'\n\n'+obs.role;$('regionTitle').textContent=obs.zone?obs.zone.id+' · '+obs.zone.name:'陆地区域';$('localInfo').textContent=obs.valid?`此处属于${obs.zone?.name||'岸缘'}，20米细分格面积约 ${obs.zone?.area_m2||0} m²。树冠覆盖约 ${Math.round((obs.local?.canopy||0)*100)}%，地表湿润指数 ${Math.round((obs.local?.wet||0)*100)}。观测算法 ${obs.algorithm||'obs-dir-v4'}：按方向分别采样近/中/远景、坡度、岸线与视线遮挡。仅研究者可见，均为模拟值；1米内插不代表实测。按方向键可逐米移动固定观察点。`:'将鼠标放在陆地上。';makePreviewable($('localInfo'),'研究者局部信息','text');
 $('nearby').replaceChildren();let near=D.sites.filter(s=>Math.hypot(s.east_m-position[0],s.north_m-position[1])<45).sort((a,b)=>Math.hypot(a.east_m-position[0],a.north_m-position[1])-Math.hypot(b.east_m-position[0],b.north_m-position[1]));for(const s of near){let div=document.createElement('div');div.className='target';let head=document.createElement('strong');head.textContent=s.id+' · '+s.name;div.append(head);let local=state.sites.find(p=>p.id===s.id);for(const a of local.pools){let row=document.createElement('div');row.textContent=`${D.pools[a.resource].name}：${a.amount.toFixed(a.unit==='kg'?1:0)} / ${a.capacity} ${a.unit}`;div.append(row);if(a.resource!=='R08'){let b=document.createElement('button');b.textContent='研究试采';b.onclick=()=>{try{M.harvest(state,s.id,a.resource);render();}catch(e){toast(e.message);}};div.append(b);}}
 if(s.id==='08'){let r=document.createElement('p');r.textContent=`岩池 ${state.water.W01.toFixed(2)} / 1 L（原水）`;div.append(r);}if(s.id==='01'){let r=document.createElement('p');r.textContent=state.collector?`集雨器 ${state.water.W02.toFixed(2)} / 10 L`:'集雨器尚未建成';div.append(r);}makePreviewable(div,`${s.id} · ${s.name}资源点信息`,'target');$('nearby').append(div);}
 if(!near.length){let p=document.createElement('small');p.textContent='45米内没有已配置的资源地带；景物仍由局部地形与植被生成。';$('nearby').append(p);}
 $('collector').disabled=state.collector;$('collector').textContent=state.collector?'集雨器已存在':'在营地设置集雨器';
 $('forecast').replaceChildren();for(let i=0;i<24;i++){let f=M.weather(state.hour+i,state.seed,position),a=document.createElement('article');a.className=i===0?'now':'';for(const [cls,text]of [['time',i===0?'现在':String(f.date.getUTCHours()).padStart(2,'0')+':'+String(f.date.getUTCMinutes()).padStart(2,'0')],['icon',f.rain?'☂':!f.daylight?'☾':f.cloud>.5?'☁':'☀'],['temp',f.temperature.toFixed(0)+'°'],['rain',f.rain.toFixed(1)+' mm/h'],['label',f.label]]){let n=document.createElement('div');n.className=cls;n.textContent=text;a.append(n);}makePreviewable(a,'逐小时天气预报','forecast');$('forecast').append(a);}
 $('waterStats').replaceChildren();for(const [name,value]of [['岩池 W01',state.water.W01.toFixed(2)+' L'],['集雨 W02',state.collector?state.water.W02.toFixed(2)+' L':'未建'],['潮位 · 模拟',w.tide.toFixed(2)+' m']]){let box=document.createElement('div'),label=document.createElement('small'),v=document.createElement('strong');label.textContent=name;v.textContent=value;box.append(label,v);makePreviewable(box,name,'water');$('waterStats').append(box);}
 $('ecoStats').replaceChildren();for(const e of M.ecologySummary(state)){let card=document.createElement('article'),title=document.createElement('h3'),stock=document.createElement('p'),stages=document.createElement('p'),capacity=document.createElement('p'),meter=document.createElement('div'),fill=document.createElement('i'),foodDp=e.rid==='R06'||e.rid==='R05'?1:0,popDp=e.populationUnit==='kg'?1:0;card.className='ecoCard';title.textContent=e.name;stock.textContent=`${e.foodName}：${e.stock.toFixed(foodDp)} / ${e.foodCapacity} ${e.unit}；最近结算恢复 ${e.growth.toFixed(foodDp)}、取食 ${e.consumption.toFixed(foodDp)} ${e.unit}`;stages.textContent=`族群总量 ${e.total.toFixed(popDp)} ${e.populationUnit}：幼体 ${e.young.toFixed(popDp)} · 青年/稚体 ${e.juvenile.toFixed(popDp)} · 亚成体 ${e.subadult.toFixed(popDp)} · 成体/繁殖阶段 ${e.adult.toFixed(popDp)}`;capacity.textContent=`食源推算承载量约 ${e.carrying.toFixed(popDp)} ${e.populationUnit} · 场景硬上限 ${e.hardCap} ${e.populationUnit} · 栖地状态 ${Math.round(e.condition*100)}%`;meter.className='ecoMeter';fill.style.width=100*e.condition+'%';meter.append(fill);card.append(title,stock,stages,capacity,meter);makePreviewable(card,e.name+'生态信息','eco');$('ecoStats').append(card);}
 let table=document.createElement('table');table.innerHTML='<thead><tr><th>资源</th><th>现有 / 场景上限</th><th>库存比例</th></tr></thead>';let tbody=document.createElement('tbody');for(const [rid,a]of Object.entries(M.totals(state))){let tr=document.createElement('tr'),name=document.createElement('td'),n=document.createElement('td'),bar=document.createElement('td'),track=document.createElement('div'),fill=document.createElement('i');name.textContent=D.pools[rid].name;n.textContent=`${a.amount.toFixed(a.unit==='kg'?1:0)} / ${a.capacity} ${a.unit}`;track.className='bar';fill.style.width=100*a.amount/a.capacity+'%';track.append(fill);bar.append(track);tr.append(name,n,bar);tbody.append(tr);}table.append(tbody);$('stockTable').replaceChildren(table);
 $('events').replaceChildren();let entries=state.log.slice().reverse();if(!entries.length)entries=[{hour:state.hour,text:'世界已初始化。推进时间会演化自然状态；研究试采后会记录扰动。'}];for(const e of entries){let p=document.createElement('p'),t=document.createElement('small');t.textContent=dateLabel(M.weather(e.hour,state.seed).date)+' · ';p.append(t,document.createTextNode(e.text));$('events').append(p);}}
function pause(){if(timer){clearInterval(timer);timer=null;}$('play').textContent='▶ 自动';}
function step(n){M.tick(state,n);state.selected=position.slice();render();}
// Camera only: zoom never modifies world time, selected position or inventories.
const fullMapView={x:-380,y:-525,width:820,height:1030};
let focusedEventMarkerIndex=-1;
const mapPanZoomThreshold=1.05,mapDragThreshold=3;
function mapCoordinates(e){let pt=$('map').createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform($('map').getScreenCTM().inverse());}
function mapCoordinatesWith(e,matrix){let pt=$('map').createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform(matrix);}
function mapPoint(e){let pt=mapCoordinates(e);return[Math.floor(pt.x),Math.floor(-pt.y)];}
function mapZoom(){return fullMapView.width/$('map').viewBox.baseVal.width;}
function updateMapCursor(){$('map').classList.toggle('panReady',mapZoom()>mapPanZoomThreshold);}
function finishMapPan(e,cancelled=false){if(!mapPan)return;const pan=mapPan,map=$('map');mapPan=null;map.classList.remove('mapPanning');if(map.hasPointerCapture(pan.pointerId))map.releasePointerCapture(pan.pointerId);suppressMapClick=!cancelled&&pan.dragged;if(!cancelled&&pan.dragged&&!locked&&e){const p=mapPoint(e);if(M.inside(p)){position=p;state.selected=p.slice();render();}}}
function resetMapView(){if(mapPan)finishMapPan(null,true);$('map').setAttribute('viewBox',`${fullMapView.x} ${fullMapView.y} ${fullMapView.width} ${fullMapView.height}`);$('zoomLevel').textContent='1.0×';updateMapCursor();}
function focusEventPoint(east,north,index){
 if(!Number.isFinite(east)||!Number.isFinite(north))return;
 if(mapPan)finishMapPan(null,true);
 focusedEventMarkerIndex=index;
 const width=fullMapView.width/4,height=fullMapView.height/4,x=east-width/2,y=-north-height/2,map=$('map');
 map.setAttribute('viewBox',`${x} ${y} ${width} ${height}`);
 $('zoomLevel').textContent=(fullMapView.width/width).toFixed(1)+'×';
 updateMapCursor();
 $('eventMarkers').querySelectorAll('.eventMarker').forEach((marker,i)=>marker.classList.toggle('eventMarkerFocused',i===index));
 $('eventPointControls').querySelectorAll('[data-event-point-index]').forEach(button=>button.setAttribute('aria-pressed',Number(button.dataset.eventPointIndex)===index?'true':'false'));
}
$('eventPointControls').addEventListener('click',e=>{
 const button=e.target.closest('[data-event-point-index]');
 if(!button)return;
 focusEventPoint(Number(button.dataset.east),Number(button.dataset.north),Number(button.dataset.eventPointIndex));
});
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

function setEventMarkers(markers=[]){
 const layer=$('eventMarkers'),controls=$('eventPointControls'),valid=markers.filter(item=>Number.isFinite(Number(item.east_m))&&Number.isFinite(Number(item.north_m)));
 layer.replaceChildren();controls.replaceChildren();
 if(!valid.length){controls.hidden=true;focusedEventMarkerIndex=-1;return;}
 controls.hidden=false;
 const label=document.createElement('strong');label.textContent='定位模拟点位';controls.append(label);
 const latestRound=valid[valid.length-1].round;
 const latest=valid.map((item,index)=>({item,index})).filter(({item})=>item.round===latestRound);
 const points=latest.map(({item})=>[Number(item.east_m),-Number(item.north_m)]);
 const distinct=new Set(points.map(point=>point.join(','))).size;
 const locate=document.createElement('button');
 locate.type='button';
 locate.textContent='定位第 '+latestRound+' 轮'+(distinct>1?'轨迹':'地点');
 locate.onclick=()=>{
  if(distinct===1){
   focusEventPoint(points[0][0],-points[0][1],latest[latest.length-1].index);
  }else{
   if(mapPan)finishMapPan(null,true);
   const xs=points.map(([x])=>x),ys=points.map(([,y])=>y);
   const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
   const scale=Math.max(.25,(right-left+96)/fullMapView.width,(bottom-top+96)/fullMapView.height);
   const width=fullMapView.width*scale,height=fullMapView.height*scale;
   $('map').setAttribute('viewBox',`${(left+right-width)/2} ${(top+bottom-height)/2} ${width} ${height}`);
   $('zoomLevel').textContent=(1/scale).toFixed(1)+'×';
   updateMapCursor();
   focusedEventMarkerIndex=-1;
   layer.querySelectorAll('.eventMarkerFocused').forEach(marker=>marker.classList.remove('eventMarkerFocused'));
   controls.querySelectorAll('[data-event-point-index]').forEach(button=>button.setAttribute('aria-pressed','false'));
  }
  $('map').scrollIntoView({block:'nearest'});
 };
 controls.append(locate);
 if(distinct>1){
  const coordinates=points.map(point=>point.join(',')).join(' ');
  layer.append(
   svg('polyline',{points:coordinates,fill:'none',stroke:'#fff8eb','stroke-width':6,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round'}),
   svg('polyline',{points:coordinates,fill:'none',stroke:'#c52232','stroke-width':3,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round'})
  );
 }
 for(const [index,item] of valid.entries()){
  const east=Number(item.east_m),north=Number(item.north_m),round=Number(item.round),title=String(item.title||'行动点位'),time=title.match(/\d{1,2}:\d{2}/)?.[0];
  const group=svg('g',{transform:`translate(${east},${-north})`,class:`eventMarker${index===focusedEventMarkerIndex?' eventMarkerFocused':''}`});
  group.append(svg('title',{},`${index+1}. ${title} · ${item.name||''}`),svg('circle',{r:16,fill:'#c52232',stroke:'#fff8eb','stroke-width':3}),svg('circle',{r:19,fill:'none',stroke:'#c52232','stroke-width':1.5,opacity:.75}),svg('text',{y:4,'text-anchor':'middle','font-size':11,'font-weight':700,fill:'#fff'},distinct>1?String(index+1):''));
  layer.append(group);
  const button=document.createElement('button');
  button.type='button';button.className='eventPointButton';
  button.dataset.eventPointIndex=String(index);button.dataset.east=String(east);button.dataset.north=String(north);
  button.setAttribute('aria-pressed',index===focusedEventMarkerIndex?'true':'false');
  button.setAttribute('aria-label',`定位到第 ${round||1} 轮，${title}，${item.name||'点位'}，东向 ${east.toFixed(1)} 米、北向 ${north.toFixed(1)} 米`);
  button.title=`${title} · ${item.name||''} · E ${east.toFixed(1)} m / N ${north.toFixed(1)} m`;
  button.textContent=`${String(index+1).padStart(2,'0')} · ${round?`第${round}轮`:'点位'}${time?` · ${time}`:''}`;
  controls.append(button);
 }
}

globalThis.IslandApp=Object.freeze({getWorldState:()=>state,getPosition:()=>position.slice(),pause,setEventMarkers,setWorldState(next,focusPosition){M.validate(next);if(focusPosition&&!M.inside(focusPosition))throw Error('求生者位置必须在岛上');const previousState=state,previousPosition=position.slice(),previousLocked=locked;pause();try{state=next;if(focusPosition){position=focusPosition.slice();locked=true;}state.selected=position.slice();render();}catch(error){state=previousState;position=previousPosition;locked=previousLocked;render();throw error;}}});
