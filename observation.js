/* Observation is a projection of state, never a second resource inventory.
   观测流程：唯一世界状态 → 位置/方向采样 → 结构化事实 → 可见性与重要性筛选 → 文字。
   方向卡只叙述该方向实际可获得的线索；同一斑块只由最接近的水平卡主述一次，
   避免一片海或一丛椰果在四张卡里被整段复制。 */
(function(M){
'use strict';
const D=M.D;
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const DEG=Math.PI/180;
const ALGORITHM='obs-dir-v4';
const NEAR_MAX=10;          // 近景：约0—10米
const MID_MAX=40;           // 中景：约10—40米
const SECTOR=50*DEG;        // 每张水平卡的水平半角；四卡在斜角有10度重叠
const LAND_NEAR=15;         // 脚边资源由“脚下”负责，方向卡从15米外开始
const LAND_MAX=70;          // 方向卡最多描述70米内的陆地斑块
const SEA_OFFSET=9;         // 岸点向海一侧偏移，形成近岸海域范围（模拟设定）
const TIDE_LOW=.15;         // 退露礁面的模拟潮位阈值
const DIRS=[
  {key:'N',name:'北',dx:0,dy:1},
  {key:'E',name:'东',dx:1,dy:0},
  {key:'S',name:'南',dx:0,dy:-1},
  {key:'W',name:'西',dx:-1,dy:0}
];

/* 平滑格点噪声：同一位置稳定，随位置连续变化，不按“每走一米”随机换句。 */
function field(p,key,scale=30){
  let x=p[0]/scale,y=p[1]/scale,ix=Math.floor(x),iy=Math.floor(y),u=x-ix,v=y-iy;
  u=u*u*(3-2*u);v=v*v*(3-2*v);
  const n=(a,b)=>M.rnd(7919,key+':'+a+':'+b);
  return (n(ix,iy)*(1-u)+n(ix+1,iy)*u)*(1-v)+(n(ix,iy+1)*(1-u)+n(ix+1,iy+1)*u)*v;
}

/* 细分格生物群系查表：只用于方向采样，避免每个5米采样点都回退扫描836个多边形。 */
const CELL=20,cellBiome=new Map();
for(const z of D.zones){
  const k=Math.floor(z.center[0]/CELL)+':'+Math.floor(z.center[1]/CELL);
  if(!cellBiome.has(k))cellBiome.set(k,z.biome);
}
function biomeAt(p){
  const z=cellBiome.get(Math.floor(p[0]/CELL)+':'+Math.floor(p[1]/CELL));
  if(z)return z;
  return M.edgeDist(p)<10?'shore':M.terrain(p)>20?'woodland':'scrub';
}

/* 连续位置场：树冠、灌草、石砾、落叶按生物群系缩放，避免光秃岸滩出现“密集灌丛”。 */
function surface(p){
  const biome=biomeAt(p);
  const canopy=clamp((biome==='woodland'?.55:biome==='scrub'?.18:.02)+field(p,'canopy')*.35);
  const shrub=clamp((biome==='scrub'?.52:biome==='woodland'?.26:.06)+field(p,'shrub',19)*(biome==='shore'?.18:.3));
  const rock=clamp((biome==='shore'?.5:biome==='scrub'?.22:.08)+field(p,'rock',12)*(biome==='shore'?.4:.25));
  const litter=clamp(canopy*.7+field(p,'litter',9)*.3);
  const canopyHeight=canopy*(biome==='woodland'?8:biome==='scrub'?2.4:.7);
  return{biome,canopy,shrub,rock,litter,canopyHeight};
}
function coverAt(p){return surface(p).canopyHeight;}

/* 观察点局部场：天气、湿润、斑块库存的加权线索。库存仍只来自state.sites同一份。 */
function local(s,p){
  const w=M.weather(s.hour,s.seed,p),z=M.zone(p),edge=M.edgeDist(p),height=M.terrain(p),sf=surface(p);
  /* 兼容旧localFields调用方：保留一个平滑的局部坡度大小；文字不再使用它。 */
  const slope=Math.hypot(M.terrain([p[0]+4,p[1]])-height,M.terrain([p[0],p[1]+4])-height)/4;
  let wet=.10;
  for(let i=0;i<24;i++)wet+=M.weather(s.hour-i,s.seed,p).rain*.04*Math.exp(-i/8);
  wet=clamp(wet+sf.canopy*.14);
  const resources={},nearResources={};
  for(const point of D.sites){
    const d=Math.hypot(point.east_m-p[0],point.north_m-p[1]),r=point.radius_m||24;
    if(d>r)continue;
    const fall=1-d/r,site=s.sites.find(a=>a.id===point.id);
    for(const a of site.pools){
      const v=resources[a.resource]||(resources[a.resource]={amount:0,capacity:0,coverage:0});
      v.amount+=a.amount*fall;v.capacity+=a.capacity*fall;v.coverage+=fall;
      if(fall>=.5){
        const n=nearResources[a.resource]||(nearResources[a.resource]={amount:0,capacity:0,coverage:0});
        n.amount+=a.amount*fall;n.capacity+=a.capacity*fall;n.coverage+=fall;
      }
    }
  }
  return{w,z,edge,height,slope,canopy:sf.canopy,shrub:sf.shrub,rock:sf.rock,litter:sf.litter,
    canopyHeight:sf.canopyHeight,biome:sf.biome,wet,resources,nearResources};
}

/* ---------- 近岸海域范围：锚点是岸边作业入口，不是鱼的真实坐标 ---------- */
function nearestCoast(p){
  let best=null;
  for(let i=0;i<D.ring.length;i++){
    const a=D.ring[i],b=D.ring[(i+1)%D.ring.length],dx=b[0]-a[0],dy=b[1]-a[1];
    const t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),0,1);
    const q=[a[0]+t*dx,a[1]+t*dy],d=Math.hypot(p[0]-q[0],p[1]-q[1]);
    if(!best||d<best.d)best={q,d,i,t};
  }
  return best;
}
let seaPatches=null;
function buildSeaPatches(){
  if(seaPatches)return seaPatches;
  seaPatches=[];
  for(const site of D.sites){
    const ids=site.stocks.filter(a=>['R05','R06','R07'].includes(a.resource)).map(a=>a.resource);
    if(!ids.length)continue;
    const p=[site.east_m,site.north_m],nc=nearestCoast(p);
    const a=D.ring[nc.i],b=D.ring[(nc.i+1)%D.ring.length];
    let nx=b[1]-a[1],ny=-(b[0]-a[0]);
    const len=Math.hypot(nx,ny)||1;nx/=len;ny/=len;
    if(M.inside([nc.q[0]+nx*2,nc.q[1]+ny*2])){nx=-nx;ny=-ny;}
    let off=SEA_OFFSET;
    while(off<40&&M.inside([nc.q[0]+nx*off,nc.q[1]+ny*off]))off+=5;
    seaPatches.push({
      index:seaPatches.length,siteId:site.id,
      cx:nc.q[0]+nx*off,cy:nc.q[1]+ny*off,
      r:clamp((site.radius_m||24)*.6,12,26),
      coast:[nc.q[0],nc.q[1]],ids
    });
  }
  return seaPatches;
}

function angleOf(p,q,dir){
  const x=q[0]-p[0],y=q[1]-p[1],d=Math.hypot(x,y)||1;
  return Math.acos(clamp((x*dir.dx+y*dir.dy)/d,-1,1));
}
function rightOf(p,q,dir){
  const x=q[0]-p[0],y=q[1]-p[1];
  return dir.dy*x-dir.dx*y;
}
function bearingText(p,q,dir){
  const a=angleOf(p,q,dir),right=rightOf(p,q,dir);
  return {angle:a,side:Math.abs(a)<6*DEG?'正前方':right>0?'右前方':'左前方'};
}
function rotate(dir,deg){
  const a=deg*DEG,c=Math.cos(a),s=Math.sin(a);
  return{dx:dir.dx*c-dir.dy*s,dy:dir.dx*s+dir.dy*c};
}
function rayExit(p,dir,reach){
  for(let d=2;d<=reach;d+=2){
    if(!M.inside([p[0]+dir.dx*d,p[1]+dir.dy*d]))return d;
  }
  return null;
}
/* 到海域中心的视线：越过陆地时被地形或树冠挡住就不可见；离开陆地后视为开阔海面。 */
function lineClear(p,q,eye){
  const dx=q[0]-p[0],dy=q[1]-p[1],d=Math.hypot(dx,dy);
  if(d<=20)return true;
  for(let t=20;t<d-4;t+=5){
    const x=p[0]+dx*t/d,y=p[1]+dy*t/d;
    if(!M.inside([x,y]))continue;
    if(M.terrain([x,y])+coverAt([x,y])>eye+2.5)return false;
  }
  return true;
}
function visibleRayExit(p,dir,reach,eye){
  const d=rayExit(p,dir,reach);
  if(d===null)return null;
  const q=[p[0]+dir.dx*d,p[1]+dir.dy*d];
  return lineClear(p,q,eye)?d:null;
}

/* ---------- 方向扫描：岸线、遮挡、坡度趋势、近中远景 ---------- */
function scan(p,dir,reach,eye){
  let edge=null,block=null,blockCause=null;
  const layers={near:null,mid:null,far:null};
  const trend=[[0,M.terrain(p)]];
  for(let d=5;d<=reach;d+=5){
    const q=[p[0]+dir.dx*d,p[1]+dir.dy*d];
    if(!M.inside(q)){edge=d;break;}
    const h=M.terrain(q),cover=coverAt(q);
    if(d<=60&&d%10===0)trend.push([d,h]);
    if(!block&&d>=20&&h+cover>eye+2.5){
      block=d;
      blockCause=h-eye>1.5&&cover>1.5?'both':cover>1.5?'canopy':'terrain';
      break;
    }
    if(!layers.near&&d<=NEAR_MAX)layers.near={d,q,h,...surface(q)};
    if(!layers.mid&&d>NEAR_MAX&&d<=MID_MAX)layers.mid={d,q,h,...surface(q)};
    if(!layers.far&&d>MID_MAX)layers.far={d,q,h,...surface(q)};
  }
  return{edge,block,blockCause,layers,trend:trendOf(trend)};
}
function trendOf(pts){
  if(pts.length<3)return{kind:'unknown',grade:0,span:0};
  const n=pts.length;
  let sx=0,sy=0,sxx=0,sxy=0;
  for(const [x,y]of pts){sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;}
  const grade=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  let low=pts[0];
  for(const q of pts)if(q[1]<low[1])low=q;
  const dip=low!==pts[0]&&low!==pts[n-1]&&pts[0][1]-low[1]>.8&&pts[n-1][1]-low[1]>.8;
  const kind=dip?'dip':grade>.045?'up':grade<-.045?'down':'level';
  return{kind,grade,lowAt:low[0],lowHeight:low[1],span:pts[n-1][0]-pts[0][0]};
}

/* ---------- 文字：只在事实差异足够时变化，不靠同义词随机替换 ---------- */
function vegClass(s){
  if(s.biome==='shore'||(s.canopy<.12&&s.rock>.55))return'shore';
  if(s.canopy>=.62)return'closed';
  if(s.canopy>=.32)return'mixed';
  if(s.shrub>=.55)return'scrub';
  return'open';
}
function vegText(s){
  const c=vegClass(s);
  if(c==='shore')return'砂砾、碎壳和礁石边缘，岸草稀疏';
  if(c==='closed')return'树冠相连，树干间只漏下零碎光斑';
  if(c==='mixed')return'乔木与灌丛交错，枝叶间有空隙';
  if(c==='scrub')return'灌草纠缠，低枝挡住部分视线';
  return'灌草不高，土石间视线较通';
}
function trendText(t){
  if(t.kind==='dip')return`沿视线方向先下到约${t.lowAt}米处的低洼，再重新抬升。`;
  if(t.kind==='up'){
    if(t.span<30)return t.grade>.5?'近处地面明显向上抬升。':t.grade>.28?'近处地面较陡地向上抬升。':t.grade>.14?'近处地面持续向上抬升。':'近处地面略有上坡。';
    return t.grade>.25?'沿视线方向地势明显抬升，这一段走起来较费力。':t.grade>.15?'沿视线方向地势持续抬升。':t.grade>.09?'沿视线方向地势缓缓抬升。':'沿视线方向略有上坡。';
  }
  if(t.kind==='down'){
    if(t.span<30)return t.grade<-.5?'近处地面明显向下落。':t.grade<-.28?'近处地面较陡地向下落。':t.grade<-.14?'近处地面持续向下落。':'近处地面略有下坡。';
    return t.grade<-.25?'沿视线方向地势明显下降，前方更低。':t.grade<-.15?'沿视线方向地势持续下降。':t.grade<-.09?'沿视线方向地势缓缓下降。':'沿视线方向略有下坡。';
  }
  if(t.kind==='level')return t.span<30?'近处地面起伏不明显。':'沿视线方向地势起伏不大。';
  return'';
}
function blockText(s){
  const what=s.blockCause==='both'?'抬高的地面和树冠':s.blockCause==='canopy'?'连续的枝叶':'抬升的地面';
  const at=s.block<=25?`近处约${s.block}米`:`约${s.block}米外`;
  return`${at}，${what}挡住正前方更远处的景物。`;
}
function sectorEdge(s,p,dir,reach,eye){
  const eL=visibleRayExit(p,rotate(dir,12),reach,eye),eR=visibleRayExit(p,rotate(dir,-12),reach,eye);
  const exits=[s.edge,eL,eR].filter(Number.isFinite);
  return{eL,eR,nearest:exits.length?Math.min(...exits):null};
}
function coastText(se,eL,eR,w){
  const nearest=se.nearest;
  let out=`约${nearest}米外是水边。`;
  if(nearest<=10)out=`水边就在${nearest}米内，脚下很快变成湿砂或礁面。`;
  if(eL===null&&eR!==null)out+='岸线向右侧斜过去。';
  else if(eR===null&&eL!==null)out+='岸线向左侧斜过去。';
  else if(eL!==null&&eR!==null){
    if(eR<eL*.72)out+='右边先到水边，岸线斜着横过前方。';
    else if(eL<eR*.72)out+='左边先到水边，岸线斜着横过前方。';
    else out+='岸线大致横在正前方。';
  }
  return out;
}

function amountOf(state){
  const a={};
  for(const p of state.pools)a[p.resource]=p.amount;
  return a;
}
/* 陆地斑块线索只读该斑块自己的库存；描述不产生第二份库存。
   返回带资源键的条目，方便同一张卡去重，避免两条“枯枝”重复。 */
function siteClauses(state,f,limit){
  const a=amountOf(state),out=[];
  if(a.R03>0)out.push({key:'R03',text:a.R03>4?'树根与落叶间散着数个椰果，成熟度不一致。':'树根旁能辨认零星椰果，不能只看外壳判断。'});
  if(a.R01>.2)out.push({key:'R01',text:a.R01>5?'倒木和枯枝堆成几处可接近的小堆。':'地面散着少量可捡的枯枝。'});
  if(a.R02>.1)out.push({key:'R02',text:f.shrub>.55?'灌草间可割取纤维，但枝条纠缠。':'开阔草叶间能找到纤维材料。'});
  if(a.R09>.2)out.push({key:'R09',text:'土石间有可搬取的小石块，尚不能据此认定适合做工具。'});
  if(a.R04>0)out.push({key:'R04',text:'灌木间有动物踩踏或活动线索，不能据此定位每一只山羊。'});
  if(a.R08>0&&f.w.daylight)out.push({key:'R08',text:'叶丛间有鸟鸣和掠动，声源未必与可见位置一致。'});
  if(a.R10>0)out.push({key:'R10',text:'岸滩夹着空壳碎屑，空壳不是带肉贝类。'});
  return out.slice(0,limit);
}
function blendClauses(a,f,limit){
  const out=[];
  if(a.R03?.amount>.1)out.push({key:'R03',text:a.R03.amount>4?'树根与落叶间散着数个椰果，成熟度不一致。':'树根旁能辨认零星椰果，不能只看外壳判断。'});
  if(a.R01?.amount>.2)out.push({key:'R01',text:(a.R01.amount>5?'倒木、枯枝分布成几处可接近的小堆':'地面散着少量可捡枯枝')+'，表面'+(f.wet>.3?'带潮，细火绒可能更难点燃。':'偏干，粗枝内部是否干燥仍需检查。')});
  if(a.R02?.amount>.1)out.push({key:'R02',text:f.shrub>.55?'灌草间可割取纤维，但枝条纠缠。':'开阔草叶间能找到纤维材料。'});
  if(a.R09?.amount>.2)out.push({key:'R09',text:'土石间有可搬取的小石块，尚不能据此认定适合做工具。'});
  if(a.R04?.amount>0)out.push({key:'R04',text:'灌木间有动物踩踏或活动线索，不能据此定位每一只山羊。'});
  if(a.R08?.amount>0&&f.w.daylight)out.push({key:'R08',text:'叶丛间有鸟鸣和掠动，声源未必与可见位置一致。'});
  if(a.R10?.amount>0)out.push({key:'R10',text:'岸滩夹着空壳碎屑，空壳不是带肉贝类。'});
  return out.slice(0,limit);
}

/* 近岸线索按方向选择一片海域，只读该斑块的库存。固定种子+3小时时段决定观察机会，
   移动鼠标或同一时刻反复观察不会刷出新的鱼影。 */
function marineLines(s,sp,p,dir,w){
  const site=s.sites.find(x=>x.id===sp.siteId);
  if(!site)return[];
  const a=amountOf(site);
  const d=Math.hypot(sp.cx-p[0],sp.cy-p[1]);
  const b=bearingText(p,[sp.cx,sp.cy],dir);
  const where=`${b.side}约${Math.round(d/5)*5}米`;
  if(w.rain>5)return[`${where}的海面被雨幕压住，无法分辨水下细节。`];
  if(!w.daylight)return[`${where}只剩浪声和暗色反光，不能可靠分辨鱼影或贝类。`];
  if(d>120)return[`${where}只剩水面反光，距离太远，不能分辨鱼影或礁缝贝类。`];
  const out=[],slot=Math.floor(s.hour/3),seed=s.seed;
  const roll=key=>M.rnd(seed,`sea:${key}:${sp.siteId}:${slot}`);
  if(a.R05>0){
    const cue=a.R05>12?'鱼影较多':a.R05>5?'偶有鱼影':'只有零散鱼影';
    out.push(roll('fish')<.72
      ?`${where}，${w.rain>0?'雨点打散水面反光，仍能瞥见':'水色较深处'}${cue}；看到不等于能徒手抓到。`
      :`${where}水面较平，暂未看到明确鱼影；这不代表这片海里没有鱼。`);
  }
  if(a.R06>0&&d<=60){
    const cue=a.R06>25?'贝类痕迹较密':a.R06>8?'能辨认带肉贝类':'只有零散附着贝类';
    out.push(w.tide<=TIDE_LOW
      ?`${where}，${d<15?'脚边的':'稍远的'}退露礁缝上${cue}，仍需靠近逐个确认。`
      :`${where}的礁面多被海水覆盖，贝类此刻不易接近。`);
  }
  if(a.R07>0&&d<=60&&w.tide<=0&&roll('crab')<.6)out.push(`${where}潮湿裂隙边偶有小型甲壳类移动。`);
  if(!out.length)out.push(`${where}水面没有可辨的近岸细节，不能凭外观推断库存。`);
  return out;
}

/* ---------- 主观察 ---------- */
function observe(s,p){
  if(!M.inside(p))return{valid:false,cards:[],background:'',backgroundRole:'',role:'请将观察点放在陆地内。',facts:null};
  const f=local(s,p),w=f.w;
  const reach=w.daylight?(w.rain>5?45:w.rain>0?85:220):12;
  const eye=f.height+1.65;
  const facts={
    algorithm:ALGORITHM,hour:s.hour,position:p.slice(),reach,eye,
    background:{rain:w.rain,cloud:w.cloud,daylight:w.daylight,tide:w.tide},
    directions:[]
  };

  /* 每个斑块只归入角差最小的水平卡；斜角对象只在那一张卡的边缘出现，
     不会同时复制到相邻卡，更不会扩散到四向。 */
  const landOwner=new Map();
  for(const site of D.sites){
    const q=[site.east_m,site.north_m],d=Math.hypot(q[0]-p[0],q[1]-p[1]);
    if(d<LAND_NEAR||d>Math.min(reach,LAND_MAX))continue;
    let best=-1,ba=Infinity;
    for(let i=0;i<4;i++){const ang=angleOf(p,q,DIRS[i]);if(ang<ba){ba=ang;best=i;}}
    if(ba<=SECTOR)landOwner.set(site.id,best);
  }
  const seaOwner=new Map();
  for(const sp of buildSeaPatches()){
    const d=Math.hypot(sp.cx-p[0],sp.cy-p[1]);
    if(d>reach+30)continue;
    let best=-1,ba=Infinity;
    for(let i=0;i<4;i++){const ang=angleOf(p,[sp.cx,sp.cy],DIRS[i]);if(ang<ba){ba=ang;best=i;}}
    if(ba<=SECTOR)seaOwner.set(sp.index,best);
  }

  const built=DIRS.map((dir,ci)=>{
    const sight=scan(p,dir,reach,eye);
    const se=sectorEdge(sight,p,dir,reach,eye);
    const parts=[];
    facts.directions.push({
      card:dir.name,edge:sight.edge,edgeNear:se.nearest,edgeSides:{left:se.eL,right:se.eR},block:sight.block,blockCause:sight.blockCause,
      trend:sight.trend,layers:{near:vegClass(sight.layers.near||f),mid:sight.layers.mid?vegClass(sight.layers.mid):null,far:sight.layers.far?vegClass(sight.layers.far):null},
      targets:[],sea:null
    });
    const fact=facts.directions[facts.directions.length-1];

    if(!w.daylight){
      const audioEdge=sight.edge||rayExit(p,dir,30);
      if(audioEdge&&audioEdge<=30)parts.push('这一侧能听到更清楚的水声。');
      else if(vegClass(sight.layers.near||f)==='closed')parts.push('这一侧只有树冠下的暗影。');
      else parts.push('这一侧只有近处坡面的暗影。');
      if(audioEdge&&audioEdge<=12)parts.push('水边就在几步内。');
    }else{
      const near=sight.layers.near||f;
      const sameGround=vegClass(near)===vegClass(f)&&Math.abs(near.rock-f.rock)<.2&&Math.abs(near.litter-f.litter)<.2;
      if(!sameGround)parts.push(`近处是${vegText(near)}${near.rock>.62?'，石砾较多':''}${near.litter>.6?'，落叶层较厚':''}。`);
      if(sight.layers.mid&&w.rain<=5){
        const mid=sight.layers.mid;
        if(vegClass(mid)!==vegClass(near))parts.push(`再往前约${mid.d}米，${vegText(mid)}。`);
        else if(Math.abs(mid.canopy-near.canopy)>.25)parts.push(`再往前约${mid.d}米，树冠比近处${mid.canopy>near.canopy?'更密':'更疏'}。`);
      }
      if(sight.layers.far&&w.rain===0&&!sight.edge&&!sight.block){
        const far=sight.layers.far,prev=sight.layers.mid||near;
        if(vegClass(far)!==vegClass(prev)||Math.abs(far.canopy-prev.canopy)>.3)parts.push(`约${far.d}米外，${vegText(far)}。`);
      }
      const tt=trendText(sight.trend);if(tt)parts.push(tt);
      if(sight.block)parts.push(blockText(sight));
      if(se.nearest!==null)parts.push(coastText(se,se.eL,se.eR,w));
      else if(!sight.block&&w.rain<=5)parts.push(`这一侧${reach}米内没有看到岸线。`);

      /* 陆地斑块：仅保留归本卡、15—70米内、当日可见的对象。
         同一张卡按资源键去重，避免两片枯木各说一遍。 */
      if(w.rain<=5){
        const nearSites=[];
        for(const site of D.sites){
          if(landOwner.get(site.id)!==ci)continue;
          const q=[site.east_m,site.north_m],d=Math.hypot(q[0]-p[0],q[1]-p[1]);
          if(d<LAND_NEAR||d>Math.min(reach,LAND_MAX))continue;
          if(w.rain>0&&d>25)continue;
          if(!lineClear(p,q,eye))continue;
          if(!site.stocks.length&&!['01','08'].includes(site.id))continue;
          nearSites.push({site,d,q});
        }
        nearSites.sort((a,b)=>a.d-b.d);
        const cands=[],used=new Set(),usedSites=new Set();
        for(const {site,d,q}of nearSites){
          const b=bearingText(p,q,dir),where=`${b.side}约${Math.round(d/5)*5}米外`;
          if(site.id==='08'){
            cands.push({d,keys:['08'],siteId:site.id,text:`${where}，${s.water.W01>.2?'岩面低处有小片积水，外观不能证明水质安全。':'低处岩池露出较多池底，水量很少或已干涸。'}`});
          }else if(site.id==='01'){
            cands.push({d,keys:['01'],siteId:site.id,text:`${where}，${s.collector?'有人工集雨设施。':'有一片较开阔的候选营地。'}`});
          }else{
            const st=s.sites.find(x=>x.id===site.id),clauses=siteClauses(st,local(s,q),2);
            if(clauses.length)cands.push({d,keys:clauses.map(c=>c.key),siteId:site.id,text:`${where}，${clauses.map(c=>c.text.replace(/。$/,'')).join('；')}。`});
          }
        }
        for(const c of cands){
          if(c.keys.some(k=>used.has(k))||usedSites.size>=2)continue;
          for(const k of c.keys)used.add(k);
          usedSites.add(c.siteId);parts.push(c.text);
        }
        fact.targets.push(...usedSites);
      }

      /* 海域斑块：只读这一片自己的库存，且必须没有被地形/树冠挡住。 */
      {
        let best=null;
        for(const sp of buildSeaPatches()){
          if(seaOwner.get(sp.index)!==ci)continue;
          const d=Math.hypot(sp.cx-p[0],sp.cy-p[1]);
          if(d>reach)continue;
          const ang=angleOf(p,[sp.cx,sp.cy],dir);
          if(ang>SECTOR)continue;
          if(!lineClear(p,[sp.cx,sp.cy],eye))continue;
          const score=ang*120+d*.25-sp.r*.15;
          if(!best||score<best.score)best={sp,d,ang,score};
        }
        if(best){
          fact.sea={siteId:best.sp.siteId,d:Math.round(best.d),angle:+(best.ang/DEG).toFixed(1)};
          parts.push(...marineLines(s,best.sp,p,dir,w));
        }else if(se.nearest!==null&&w.rain<=5){
          parts.push('这一侧的水面没有配置可判定的近岸资源范围，不能凭外观推断鱼贝数量。');
        }
      }
    }
    return{name:dir.name,parts,reach,
      edge:sight.edge,block:sight.block,grade:+(sight.trend.grade||0).toFixed(3),fact};
  });

  /* 斜角对象的第二遍处理：只在已经主述它的相邻卡旁提一句，
     不重复资源细节，也不向背向两张卡扩散。 */
  const primaryTargets=built.map(b=>b.fact.targets.slice());
  for(let ci=0;ci<4;ci++){
    const b=built[ci];
    if(!w.daylight||w.rain>5)continue;
    const targetRids=new Set();
    for(const id of b.fact.targets){
      const site=D.sites.find(x=>x.id===id);
      for(const a of site?.stocks||[])if(!['R05','R06','R07'].includes(a.resource))targetRids.add(a.resource);
    }
    let edge=null;
    for(const site of D.sites){
      const owner=landOwner.get(site.id);
      if(owner===undefined||owner===ci)continue;
      if(Math.abs(owner-ci)!==1&&Math.abs(owner-ci)!==3)continue;
      if(!primaryTargets[owner].includes(site.id))continue;
      const q=[site.east_m,site.north_m],d=Math.hypot(q[0]-p[0],q[1]-p[1]);
      if(d<LAND_NEAR||d>Math.min(reach,LAND_MAX))continue;
      if(!lineClear(p,q,eye))continue;
      const ang=angleOf(p,q,DIRS[ci]);
      if(ang<30*DEG||ang>SECTOR)continue;
      const rid=(site.stocks.find(a=>!['R05','R06','R07'].includes(a.resource))||{}).resource;
      if(!rid||targetRids.has(rid))continue;
      if(!edge||d<edge.d)edge={d,rid,siteId:site.id};
    }
    if(edge){
      b.parts.push(`视野边缘约${Math.round(edge.d/5)*5}米还有一处${D.pools[edge.rid].name}，主述在相邻方向，这里不重复展开。`);
      b.fact.edgeTargets=[edge.siteId];b.fact.targets.push(edge.siteId);
    }
  }
  const cards=built.map(b=>({name:b.name,text:[...new Set(b.parts)].filter(Boolean).join('\n'),reach:b.reach,
    edge:b.edge,block:b.block,grade:b.grade,targets:b.fact.targets}));

  /* 公共背景只完整出现一次；方向卡不再重复雨势、昼夜和潮位。 */
  const sunVisible=w.sun.alt>0&&w.cloud<.65&&!w.rain&&f.canopy<.65;
  const sunText=w.sun.alt<0?'太阳已落下，不能靠它判断方向。':sunVisible?'太阳在天空中，可作大致方向线索。':f.canopy>=.65?'树冠遮住太阳，零散光斑不足以辨别方向。':'云雨遮住太阳，当前没有可靠的日照方向线索。';
  const tideText=w.tide>.2?'礁缘多被水覆盖':w.tide<-.2?'礁面露出较多':'潮位接近中位';
  const background=[
    `${w.daylight?'白昼':'夜间'}，${w.rain>5?'较强降雨':w.rain>0?'细雨':'无雨'}，${w.cloud>.6?'云层较厚':'云量不多'}；四向共用的可辨上限约${reach}米。`,
    `模拟潮位${w.tide.toFixed(2)}米，${tideText}。`,
    sunText
  ].join('\n');
  const backgroundRole=`${w.daylight?'天还亮着':'夜色已深'}，${w.rain>5?'雨势很大':w.rain>0?'下着细雨':'没有下雨'}，${w.cloud>.6?'云层压得较低':'云不厚'}；视线${reach>=200?'能及远处岸线':reach>=80?'受雨影响，远处发灰':'只及近处'}。潮水${w.tide>.2?'较高':w.tide<-.2?'退得较多':'不高不低'}。`;

  const sky=(f.canopy>.7?'头顶枝叶层层叠压，只能看到碎片状天空。':f.canopy>.4?'交错树冠间能看到不规则天空缺口。':'上空开阔，稀疏枝梢没有连成完整树冠。')
    +(w.rain?'\n叶尖滴水与雨声相叠，树下也不能保证干燥。':'');
  cards.push({name:'上方',text:sky,reach:0,targets:[]});

  const ground=f.biome==='shore'?'岸边砂砾、碎壳与礁石边缘':f.canopy>.5?'落叶、细枝与腐殖层':'灌草间的土石和裸露地表';
  const feet=[`这里是${ground}。`,
    f.wet>.55?'地表明显湿润，低处仍可能留水。':f.wet>.25?'表层带潮，阴影处比开阔处更湿。':'表层偏干，松散砂砾的边缘清楚。',
    f.rock>.65?'脚边石砾较多，较大的边角会影响落脚。':f.litter>.55?'落叶层较厚，可能盖住细枝和小坑。':'地表覆盖较薄，土石之间的空隙更容易辨认。'];
  if(w.daylight)feet.push(...blendClauses(f.nearResources,f,4).map(c=>c.text));
  else feet.push('光线不足，只能凭脚下触感和近处轮廓判断。');
  const rockPool=D.sites.find(x=>x.id==='08');
  if(Math.hypot(p[0]-rockPool.east_m,p[1]-rockPool.north_m)<8)feet.push(s.water.W01>.2?'脚边岩池里有积水；需要处理后再考虑饮用。':'脚边岩池几乎见底。');
  if(f.edge<8)feet.push('脚边已是水线，浪能打湿鞋面。');
  cards.push({name:'脚下',text:[...new Set(feet)].join('\n'),reach:0,targets:[]});

  const role=[backgroundRole,'你停在这里。',
    ...cards.map((c,i)=>(i<4?['面前','右侧','身后','左侧'][i]:c.name)+'：'+c.text)].join('\n');
  return{valid:true,zone:f.z,cards,role,background,backgroundRole,weather:w,height:f.height,
    sunVisible,local:f,facts,algorithm:ALGORITHM,
    frame:'相对方位沿用本次朝向；并不向角色提供绝对罗盘、资源库存或全岛地图。'};
}

M.observe=observe;M.localFields=local;M.observationAlgorithm=ALGORITHM;
})(IslandModel);
