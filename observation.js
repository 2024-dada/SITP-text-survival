/* Observation is a projection of state, never a second resource inventory. */
(function(M){'use strict';
 const D=M.D,clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
 function field(p,key,scale=30){let x=p[0]/scale,y=p[1]/scale,ix=Math.floor(x),iy=Math.floor(y),u=x-ix,v=y-iy;u=u*u*(3-2*u);v=v*v*(3-2*v);let n=(a,b)=>M.rnd(7919,key+':'+a+':'+b);return(n(ix,iy)*(1-u)+n(ix+1,iy)*u)*(1-v)+(n(ix,iy+1)*(1-u)+n(ix+1,iy+1)*u)*v;}
 function local(s,p){let w=M.weather(s.hour,s.seed),z=M.zone(p),edge=M.edgeDist(p),height=M.terrain(p),slope=Math.hypot(M.terrain([p[0]+2,p[1]])-height,M.terrain([p[0],p[1]+2])-height)/2;
  let canopy=clamp((z?.biome==='woodland'?.45:z?.biome==='scrub'?.15:.03)+field(p,'canopy')*.45),shrub=field(p,'shrub',19),rock=field(p,'rock',12),litter=clamp(canopy*.7+field(p,'litter',9)*.3),wet=.10;for(let i=0;i<24;i++)wet+=M.weather(s.hour-i,s.seed).rain*.04*Math.exp(-i/8);wet=clamp(wet+canopy*.14);
  const resources={};for(const point of D.sites){let d=Math.hypot(point.east_m-p[0],point.north_m-p[1]),r=point.radius_m||24;if(d>r)continue;let fall=1-d/r,site=s.sites.find(a=>a.id===point.id);for(const a of site.pools){let v=resources[a.resource]||(resources[a.resource]={amount:0,capacity:0,coverage:0});v.amount+=a.amount*fall;v.capacity+=a.capacity*fall;v.coverage+=fall;}}
  return{w,z,edge,height,slope,canopy,shrub,rock,litter,wet,resources};}
 function marine(s,p,w){let pool={R05:0,R06:0,R07:0},found=false;for(const point of D.sites){if(Math.hypot(point.east_m-p[0],point.north_m-p[1])>85)continue;for(const a of s.sites.find(x=>x.id===point.id).pools)if(a.resource in pool){pool[a.resource]+=a.amount;found=true;}}
  if(!found)return'近岸水色随深浅变化；这里尚未配置可判定的鱼贝资源带，不能凭外观推断数量。';
  if(!w.daylight)return'海面只剩暗色反光和浪声，不能可靠分辨水下鱼影或礁缝里的贝类。';
  if(w.rain>5)return'密集雨点和破碎反光盖住水下细节；当前难以确认鱼贝活动。';
  let fish=pool.R05>0?(w.rain?'雨点间偶尔掠过模糊鱼影，不能判断大小和数量。':w.tide>0?'较深水色间偶有鱼影掠过；海水覆盖礁缘，看到不等于能徒手抓到。':'浅水边缘偶有小鱼闪动，静止观察比追赶更容易辨认。'):'近岸暂未见明确鱼影；这不足以证明整片海域没有鱼。';
  let shell=pool.R06>0?(w.tide<=0?'退露礁缘和石缝上能辨认带肉小贝类，仍需靠近逐个确认。':'部分附着贝类所在礁面被海水覆盖，当前不能直接采到。'):'近处可接近礁缝未见明显可采贝类。';
  return fish+'\n'+shell+(pool.R07>0&&w.tide<=0?'\n潮湿裂隙附近偶有小型甲壳类移动。':'');}
 function describeResources(f){let a=f.resources,out=[];if(a.R03?.amount>.1)out.push(a.R03.amount>4?'这一小片树根与落叶间分散着数个椰果，外观成熟度并不一致。':'树根附近能辨认零星椰果，不能只凭外观判断内部可食部分。');if(a.R01?.amount>.2)out.push((a.R01.amount>5?'倒木、枯枝分布成几处可接近的小堆':'地面散着少量可捡取枯枝')+'，表面'+(f.wet>.3?'带潮，细火绒可能更难点燃。':'偏干，粗枝内部是否干燥仍需检查。'));if(a.R02?.amount>.1)out.push(f.shrub>.5?'灌草间有可割取或剥离的纤维，纠缠枝条增加接近难度。':'较开阔的草叶带里可找到纤维材料，采走后当地不会立即长回。');if(a.R09?.amount>.2)out.push('土石间有可搬取的小石块，边角与粒径不一，尚不能据此认定适合做工具。');if(a.R04?.amount>0)out.push('灌木间可辨动物踩踏或活动线索，不能据此定位每一只山羊。');if(a.R08?.amount>0&&f.w.daylight)out.push('叶丛间偶有鸟鸣和掠动，声音来源未必与可见位置一致。');if(a.R10?.amount>0)out.push('岸滩夹杂空壳碎屑，空壳本身不能当作带肉贝类。');return out;}
 function observe(s,p){if(!M.inside(p))return{valid:false,cards:[],role:'请将观察点放在陆地内。'};let f=local(s,p),w=f.w,reach=w.daylight?(w.rain>5?45:w.rain>0?85:220):12,dirs=[['北',0,1],['东',1,0],['南',0,-1],['西',-1,0]];
  let cards=dirs.map(([name,dx,dy])=>{let parts=[],edge=null,block=null,peak=f.height,eye=f.height+1.65,near=[p[0]+dx*6,p[1]+dy*6],nf=M.inside(near)?local(s,near):f;
   if(!w.daylight)parts.push('夜间只能辨认近处明暗轮廓；浪声、叶响比远处视觉细节更可靠。');else if(w.rain)parts.push(w.rain>5?'雨幕密集，远景消失，近处叶尖持续滴水。':'细雨与反光使远处轮廓发灰，近处物体仍可分辨。');
   if(w.daylight||reach>6){parts.push(nf.canopy>.7?'近处树冠相连，树干间的空隙较窄，地面光斑零碎。':nf.canopy>.4?'乔木与灌木交错，枝叶间留有不连续的透光空隙。':nf.z?.biome==='shore'?'近处以砂砾、礁石边缘和稀疏岸草为主，天空较开阔。':'近处灌草与裸露土石交错，视线能穿过较低植被。');parts.push(nf.slope>.24?'地面在这一侧明显倾斜，落脚与搬运需要更小心。':nf.shrub>.65?'低枝和纠缠灌丛阻碍直线穿行，需要绕开密集部分。':'脚边有可穿行的空隙，但地表仍不完全平整。');}
   for(let d=5;d<=reach;d+=5){let q=[p[0]+dx*d,p[1]+dy*d];if(!M.inside(q)){edge=d;break;}let h=M.terrain(q),can=localCanopy(q);peak=Math.max(peak,h);if(d>=15&&d<=90&&h+can>eye+3){block=d;break;}}
   if(block)parts.push(`约${block}米外，${peak>f.height+3?'抬高的地面与':'连续的'}枝叶遮住后方；无法判断遮挡后的资源。`);else if(edge){parts.push(edge<=20?'这一侧很快接到海岸，能听见更清楚的浪声。':`约${edge}米外陆地向海岸收束，海面反光随波纹变化。`);if(edge<=65)parts.push(marine(s,p,w));}else parts.push(peak>f.height+4?'远处可辨地势抬升和更高的植被轮廓。':'更远处仍是高低不齐的植被，未见清楚的岸线。');
   let targets=[];for(const point of D.sites){let x=point.east_m-p[0],y=point.north_m-p[1],d=Math.hypot(x,y);if(d<8||d>Math.min(reach,65)||(x*dx+y*dy)/d<.65||block&&d>block)continue;targets.push({point,d});}targets.sort((a,b)=>a.d-b.d);
   if(w.daylight)for(const {point,d}of targets.slice(0,2)){let q=[point.east_m,point.north_m];if(point.id==='08')parts.push(s.water.W01>.2?'岩面低处有小片积水，外观不能证明水质安全。':'低处岩池露出较多池底，水量很少或已干涸。');else if(point.id==='01')parts.push(s.collector?'近处有人工集雨设施。':'近处有一片较开阔的候选营地。');else if(d<40){let desc=describeResources(local(s,q));if(desc.length)parts.push(desc[0]);}}
   return{name,text:[...new Set(parts)].join('\n'),reach,targets:targets.slice(0,2).map(x=>x.point.id)};});
  let sunVisible=w.sun.alt>0&&w.cloud<.65&&!w.rain&&f.canopy<.65;
  let sky=w.sun.alt<0?'太阳已落到地平线以下，不能用太阳判断方向。':sunVisible?(w.sun.alt>65?'太阳高悬，影子较短，不利于判断精细方向。':w.date.getUTCHours()<12?'太阳在上午天空中，树干影子向另一侧伸展，可作为大致方向线索。':'太阳已向午后天空偏移，影子与上午相比改变了方向。'):f.canopy>=.65?'树冠遮住太阳，零散光斑不足以可靠辨别方向。':'云雨遮蔽太阳，当前没有可靠的日照方向线索。';
  cards.push({name:'上方',text:sky+'\n'+(f.canopy>.7?'头顶枝叶层层叠压，只能看到碎片状天空。':f.canopy>.4?'交错树冠间能看到不规则天空缺口。':'上空开阔，稀疏枝梢没有连成完整树冠。')+'\n'+(w.rain?'叶尖滴水与雨声相叠，树下也不能保证干燥。':w.cloud>.5?'云块较多，光照在阴影与明亮之间变化。':'天空有散云，地面光影边界相对清楚。'),reach:0,targets:[]});
  let ground=f.z?.biome==='shore'?'岸边砂砾、碎壳与礁石边缘':f.canopy>.5?'落叶、细枝与腐殖层':'灌草间的土石和裸露地表';let feet=[`这里是${ground}。`,f.wet>.55?'地表明显湿润，低处仍可能留水，落叶贴着地面。':f.wet>.25?'表层带潮，阴影处比开阔处更湿。':'表层偏干，松散落叶与砂砾的边缘清楚。',f.rock>.65?'脚边石砾较多，较大的边角会影响落脚。':f.litter>.55?'落叶层较厚，可能盖住细枝和小坑。':'地表覆盖较薄，土石之间的空隙更容易辨认。'];
  if(w.daylight)feet.push(...describeResources(f));else feet.push('光线不足，不能可靠辨认脚边食物与细小材料。');
  let nearbyWater=D.sites.find(x=>x.id==='08');if(Math.hypot(p[0]-nearbyWater.east_m,p[1]-nearbyWater.north_m)<8)feet.push(s.water.W01>.2?'脚边岩池里有积水；需要处理后再考虑饮用。':'脚边岩池几乎见底。');if(f.edge<15)feet.push(marine(s,p,w));
  cards.push({name:'脚下',text:[...new Set(feet)].join('\n'),reach:0,targets:[]});let role=['你站在'+ground+'上。',...cards.map((c,i)=>(i<4?['面前','右侧','身后','左侧'][i]:c.name)+'：'+c.text)].join('\n');
  return{valid:true,zone:f.z,cards,role,weather:w,height:f.height,sunVisible,local:f,frame:'相对方位沿用本次朝向；并不向角色提供绝对罗盘、资源库存或全岛地图。'};
 }
 function localCanopy(p){let z=M.zone(p);return(z?.biome==='woodland'?7:z?.biome==='scrub'?2:.4)*field(p,'canopy');}
 M.observe=observe;M.localFields=local;
})(IslandModel);
