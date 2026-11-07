/* 浏览器端检查：真实加载 index.html，移动鼠标、点击固定、按方向键，
   读取六向卡、公共背景与角色文本，并统计渲染耗时。
   运行：node tools/browser-check.mjs
   需要本机 Chrome；可用环境变量 CHROME 指定路径。 */
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CANDIDATES=[process.env.CHROME,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const chrome=CANDIDATES.find(p=>existsSync(p));
if(!chrome){console.error('未找到 Chrome/Edge；设置 CHROME 环境变量后重试。');process.exit(2);}
const port=9333,profile=mkdtempSync(path.join(tmpdir(),'olorua-browser-'));
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--allow-file-access-from-files',
  `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let pass=0,fail=0;const failures=[];
const ok=(cond,msg)=>{if(cond){pass++;console.log('  ok  '+msg);}else{fail++;failures.push(msg);console.log('  FAIL '+msg);}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function targets(){const r=await fetch(`http://127.0.0.1:${port}/json/list`);return r.json();}
let page=null;
for(let i=0;i<60&&!page;i++){
  try{const list=await targets();page=list.find(t=>t.type==='page');}catch{}
  if(!page)await sleep(250);
}
if(!page){console.error('Chrome 调试端口未就绪');child.kill();process.exit(2);}

const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();const errors=[];
ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}
  else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails?.text||'exception');
  else if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry.text);
};
await new Promise(r=>ws.onopen=r);
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||JSON.stringify(r.exceptionDetails));return r.result.value;};

console.log('Olorua 浏览器检查 · '+chrome);
try{
  await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
  const url='file:///'+ROOT.replace(/\\/g,'/').replace(/ /g,'%20')+'/index.html';
  await send('Page.navigate',{url});await sleep(2200);
  ok(await ev(`document.title.includes('岛屿观测台')`),'页面标题加载');
  ok(await ev(`document.querySelectorAll('.viewCard').length===6`),'六张方向卡同时呈现');
  ok(await ev(`document.getElementById('background').textContent.includes('可辨上限')`),'公共背景出现在六向卡上方');
  ok(await ev(`Array.from(document.querySelectorAll('.viewCard p')).every(p=>p.textContent.trim().length>0)`),'六张卡都有文字');
  const pos=()=>ev(`document.getElementById('position').textContent`);
  const parse=s=>{const m=/E\s+(-?\d+)\s+\/\s+N\s+(-?\d+)/.exec(s);return m?[Number(m[1]),Number(m[2])]:null;};
  await ev(`document.getElementById('map').scrollIntoView({block:'center'});true`);await sleep(200);
  const pt=await ev(`(()=>{const m=document.getElementById('map');const p=m.createSVGPoint();p.x=260;p.y=0;const s=p.matrixTransform(m.getScreenCTM());return {x:s.x,y:s.y};})()`);
  const cameraBefore=await ev(`(()=>{const m=document.getElementById('map'),v=m.viewBox.baseVal;return {x:v.x,y:v.y,width:v.width,height:v.height,world:JSON.stringify({position:position.slice(),hour:state.hour,stocks:state.sites.map(s=>s.pools.map(p=>p.amount))})};})()`);
  const anchorBefore=await ev(`(()=>{const m=document.getElementById('map'),p=m.createSVGPoint();p.x=${pt.x};p.y=${pt.y};const q=p.matrixTransform(m.getScreenCTM().inverse());return{x:q.x,y:q.y};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:pt.x,y:pt.y,deltaY:-120,deltaX:0});await sleep(100);
  const zoomed=await ev(`(()=>{const m=document.getElementById('map'),v=m.viewBox.baseVal,p=m.createSVGPoint();p.x=${pt.x};p.y=${pt.y};const q=p.matrixTransform(m.getScreenCTM().inverse());return {x:v.x,y:v.y,width:v.width,height:v.height,anchor:{x:q.x,y:q.y},world:JSON.stringify({position:position.slice(),hour:state.hour,stocks:state.sites.map(s=>s.pools.map(p=>p.amount))})};})()`);
  ok(zoomed.width<cameraBefore.width,'地图滚轮向上缩放视口');
  const anchorError=Math.hypot(zoomed.anchor.x-anchorBefore.x,zoomed.anchor.y-anchorBefore.y);
  ok(anchorError<.1,'滚轮缩放以指针位置为中心（屏幕像素量化下锚点误差 '+anchorError.toFixed(3)+' 米）');
  ok(zoomed.world===cameraBefore.world,'缩放不改变观察点、时间或资源库存');
  await ev(`document.getElementById('resetView').click()`);
  const reset=await ev(`(()=>{const v=document.getElementById('map').viewBox.baseVal;return{x:v.x,y:v.y,width:v.width,height:v.height};})()`);
  ok(Math.abs(reset.width-820)<.001&&Math.abs(reset.height-1030)<.001&&Math.abs(reset.x+380)<.001&&Math.abs(reset.y+525)<.001,'“全岛”按钮恢复完整地图视图');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pt.x,y:pt.y,button:'none'});await sleep(250);
  const moved=parse(await pos());
  ok(moved&&moved[0]>=258&&moved[0]<=260&&Math.abs(moved[1])<=2,'鼠标米制预览改变了观察位置');
  const first=await ev(`document.querySelectorAll('.viewCard p')[0].textContent`);
  ok(first.includes('米'),'预览后方向卡仍含方向事实文字');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pt.x,y:pt.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pt.x,y:pt.y,button:'left',clickCount:1});await sleep(250);
  ok((await ev(`document.getElementById('viewStatus').textContent`)).includes('点击已固定'),'点击固定观察点');
  const before=parse(await pos());
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await sleep(250);
  const after=parse(await pos());
  ok(before&&after&&after[0]===before[0]+1&&after[1]===before[1],'方向键每次移动1米');
  const role=await ev(`document.getElementById('roleText').textContent`);
  ok((role.match(/可辨上限|视线能及|视线受雨|视线只及/g)||[]).length===1,'角色文本包含且只包含一次公共背景');
  ok(role.includes('面前：')&&!role.includes('北：'),'角色文本使用相对方位，不直接给罗盘');
  const ms=await ev(`(()=>{const t=performance.now();for(let i=0;i<12;i++){position=[0+i,0];render();}return (performance.now()-t)/12;})()`);
  ok(ms<30,'浏览器渲染平均 '+ms.toFixed(2)+' ms（阈值30 ms）');
  ok(errors.length===0,'无浏览器脚本错误'+(errors.length?'：'+errors.join(' | '):''));
}catch(e){
  fail++;failures.push('浏览器检查异常：'+e.message);console.error('  FAIL 浏览器检查异常：'+e.message);
}finally{
  ws.close();child.kill();
  await sleep(300);
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
console.log('\n通过 '+pass+' 项，失败 '+fail+' 项');
if(fail){for(const f of failures)console.log(' - '+f);process.exitCode=1;}
else console.log('浏览器检查全部通过。');
