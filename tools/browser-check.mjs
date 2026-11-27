/* 浏览器端检查：真实加载 index.html，检查地图交互、Agent/报告结算、
   报告失败重试、实验数据脱敏与 PDF 导出；模型请求仅由本地假接口响应。
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
const mockSource=`(()=>{
  const nativeFetch=window.fetch.bind(window);
  window.__mockRequests=[];window.__mockScenario='';window.__mockSummaryFailed=false;
  window.fetch=async(input,init={})=>{
    const raw=typeof input==='string'?input:input.url;
    const url=new URL(raw,location.href);
    if(url.hostname==='mock.invalid'){
      if(url.pathname.endsWith('/models'))return new Response(JSON.stringify({data:[]}),{status:200,headers:{'Content-Type':'application/json'}});
      const payload=JSON.parse(init.body||'{}'),system=payload.messages?.find(item=>item.role==='system')?.content||'';
      let type='agent',content='按当前系统状态完成本轮核对。';
      if(system.includes('本轮行动时间线模拟器')){
        type='plan';content=JSON.stringify({title:'营地观察',summary:'按研究者任务整理一个行动时段。',steps:[{time_label:'09:00',start_offset_minutes:0,duration_minutes:30,activity:'在营地观察周边',point_id:null,resource_id:null,probability_percent:100,success_result:'完成周边观察。',failure_result:'观察未完成。',assumption:'按当前营地位置和研究者任务估计。',point_reason:'从当前位置开始。'}]});
      }else if(system.includes('把本轮全部 Agent 推理')){
        type='summary';
        if(window.__mockScenario==='summaryFailOnce'&&!window.__mockSummaryFailed){window.__mockSummaryFailed=true;content='本次注入的格式失败';}
        else content=JSON.stringify({human_summary:'求生者在营地完成周边观察，状态按本轮时长结算。',body_summary:'我在营地观察了半小时，暂时没有额外体力消耗；这是按本轮行动时长作出的模拟感受。',before_scene:'活动开始时人在营地，周边林地安静。',after_scene:'活动结束后仍在营地，天气与周边景象基本平稳。',island_summary:'模拟时钟推进30分钟，岛屿资源没有改变。'});
      }
      window.__mockRequests.push({type,url:url.href,model:payload.model});
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    if(url.protocol==='file:'||url.hostname==='127.0.0.1')return nativeFetch(input,init);
    throw new Error('browser-check blocked a non-mock network request: '+url.host);
  };
})()`;

console.log('Olorua 浏览器检查 · '+chrome);
try{
  await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:mockSource});
  const url='file:///'+ROOT.replace(/\\/g,'/').replace(/ /g,'%20')+'/index.html';
  await send('Page.navigate',{url});await sleep(2200);
  ok(await ev(`document.title.includes('Agent 交互实验')`),'页面标题加载');
  ok(await ev(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(node=>node.id);return ids.length===new Set(ids).size;})()`),'页面元素 ID 没有重复');
  ok(await ev(`(()=>{const panel=document.querySelector('.visibleConnection');return Boolean(panel&&panel.compareDocumentPosition(document.getElementById('agentChatHeading'))&Node.DOCUMENT_POSITION_FOLLOWING);})()`),'模型连接面板位于实验交互之前');
  ok(await ev(`document.querySelector('.tongjiProviderLabel')?.textContent.includes('目前不可用')`),'同济 AGI 状态明确标注目前不可用');
  ok(await ev(`document.querySelectorAll('.viewCard').length===6`),'六张方向卡同时呈现');
  ok(await ev(`document.getElementById('background').textContent.includes('可辨上限')`),'公共背景出现在六向卡上方');
  ok(await ev(`Array.from(document.querySelectorAll('.viewCard p')).every(p=>p.textContent.trim().length>0)`),'六张卡都有文字');
  const pos=()=>ev(`document.getElementById('position').textContent`);
  const parse=s=>{const m=/E\s+(-?\d+)\s+\/\s+N\s+(-?\d+)/.exec(s);return m?[Number(m[1]),Number(m[2])]:null;};
  await ev(`document.documentElement.style.scrollBehavior='auto';document.getElementById('map').scrollIntoView({block:'center',behavior:'instant'});true`);await sleep(150);
  const pt=await ev(`(()=>{const m=document.getElementById('map');const p=m.createSVGPoint();p.x=0;p.y=0;const s=p.matrixTransform(m.getScreenCTM());return {x:s.x,y:s.y};})()`);
  const cameraBefore=await ev(`(()=>{const m=document.getElementById('map'),v=m.viewBox.baseVal;return {x:v.x,y:v.y,width:v.width,height:v.height,world:JSON.stringify({position:position.slice(),hour:state.hour,stocks:state.sites.map(s=>s.pools.map(p=>p.amount))})};})()`);
  const anchorBefore=await ev(`(()=>{const m=document.getElementById('map'),p=m.createSVGPoint();p.x=${pt.x};p.y=${pt.y};const q=p.matrixTransform(m.getScreenCTM().inverse());return{x:q.x,y:q.y};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:pt.x,y:pt.y,deltaY:-120,deltaX:0});await sleep(100);
  const zoomed=await ev(`(()=>{const m=document.getElementById('map'),v=m.viewBox.baseVal,p=m.createSVGPoint();p.x=${pt.x};p.y=${pt.y};const q=p.matrixTransform(m.getScreenCTM().inverse());return {x:v.x,y:v.y,width:v.width,height:v.height,anchor:{x:q.x,y:q.y},world:JSON.stringify({position:position.slice(),hour:state.hour,stocks:state.sites.map(s=>s.pools.map(p=>p.amount))})};})()`);
  ok(zoomed.width<cameraBefore.width,'地图滚轮向上缩放视口');
  const anchorError=Math.hypot(zoomed.anchor.x-anchorBefore.x,zoomed.anchor.y-anchorBefore.y);
  ok(anchorError<.5,'滚轮缩放以指针位置为中心（屏幕像素量化下锚点误差 '+anchorError.toFixed(3)+' 米）');
  ok(zoomed.world===cameraBefore.world,'缩放不改变观察点、时间或资源库存');
  await ev(`document.getElementById('resetView').click()`);
  const reset=await ev(`(()=>{const v=document.getElementById('map').viewBox.baseVal;return{x:v.x,y:v.y,width:v.width,height:v.height};})()`);
  ok(Math.abs(reset.width-820)<.001&&Math.abs(reset.height-1030)<.001&&Math.abs(reset.x+380)<.001&&Math.abs(reset.y+525)<.001,'“全岛”按钮恢复完整地图视图');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pt.x,y:pt.y,button:'none'});await sleep(250);
  const moved=parse(await pos());
  ok(moved&&Math.abs(moved[0])<=1&&Math.abs(moved[1])<=1,'鼠标米制预览改变了观察位置');
  const firstCardText=await ev(`document.querySelectorAll('.viewCard p')[0].textContent`);
  ok(firstCardText.includes('米'),'预览后方向卡仍含方向事实文字');
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

  await ev(`(()=>{const set=(id,value,event='input')=>{const item=document.getElementById(id);item.value=value;item.dispatchEvent(new Event(event,{bubbles:true}));};set('aiProvider','custom','change');set('aiApiKey','browser-check-only-secret');set('aiBaseUrl','https://mock.invalid/v1');set('aiModelName','mock-model');set('agentRoundPrompt','在营地观察周边环境。');return true;})()`);
  let ready=false;for(let i=0;i<50&&!ready;i++){ready=await ev(`!document.getElementById('runAgentRound').disabled`);if(!ready)await sleep(100);}
  ok(ready,'隔离模型连接完成配置且运行按钮可用');
  await ev(`document.getElementById('runAgentRound').click();true`);
  let first=null;for(let i=0;i<100;i++){first=await ev(`(()=>{const a=SurvivalAgent.getExperimentArchive();return {round:Number(document.getElementById('agentRoundCount').textContent),reports:document.querySelectorAll('#eventReportList .eventReportCard').length,hour:IslandApp.getWorldState().hour,points:document.getElementById('eventMarkers').childElementCount,archive:a?JSON.stringify(a.rounds[0]?.model_responses||[]):''};})()`);if(first.round===1&&first.reports===1)break;await sleep(100);}
  ok(first?.round===1&&first.reports===1&&Math.abs(first.hour-.5)<1e-9,'假模型跑完整 Agent→报告→状态结算，时钟推进30分钟');
  ok(first?.points===1,'行动点位写入地图');
  ok(first?.archive.includes('event_report_plan')&&first?.archive.includes('event_report_summary'),'完整归档包含报告模型的原始返回');
  const units=await ev(`(()=>{const a=SurvivalAgent.getExperimentArchive();const frames=[a.initial,a.current.frame,...a.rounds.flatMap(r=>[r.frame_before,r.frame_after_agent])];const codes=[...new Set(frames.flatMap(f=>f.systems.flatMap(s=>s.parameters.map(p=>p.param))))];const missing=codes.filter(code=>typeof a.parameter_units[code]!=='string'||!a.parameter_units[code].trim());return {count:codes.length,missing};})()`);
  ok(units.count>0&&units.missing.length===0,'实验框架全部参数均有单位且纳入 PDF 单位表（'+units.count+'项）');
  const secretInArchive=await ev(`JSON.stringify(SurvivalAgent.getExperimentArchive()).includes('browser-check-only-secret')`);
  ok(secretInArchive===false,'完整导出脱敏 API Key');

  await ev(`(()=>{window.__mockScenario='summaryFailOnce';window.__mockSummaryFailed=false;const p=document.getElementById('agentRoundPrompt');p.value='再次检查营地与周边环境。';p.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('runAgentRound').click();return true;})()`);
  let failed=null;for(let i=0;i<100;i++){failed=await ev(`(()=>{const a=SurvivalAgent.getExperimentArchive();return {round:Number(document.getElementById('agentRoundCount').textContent),reports:document.querySelectorAll('#eventReportList .eventReportCard').length,hour:IslandApp.getWorldState().hour,pending:Boolean(a?.current.pending_report),retryVisible:!document.getElementById('retryEventReport').hidden,points:document.getElementById('eventMarkers').childElementCount};})()`);if(failed.pending&&failed.retryVisible)break;await sleep(100);}
  ok(failed?.round===2&&failed.reports===1&&failed.pending&&Math.abs(failed.hour-.5)<1e-9,'报告格式错误时不提交世界/时钟，保留待重试报告');
  ok(failed?.points===2,'报告待重试时地图仍保留待结算点位预览');
  await ev(`document.getElementById('retryEventReport').click();true`);
  let retried=null;for(let i=0;i<100;i++){retried=await ev(`(()=>{const a=SurvivalAgent.getExperimentArchive();return {round:Number(document.getElementById('agentRoundCount').textContent),reports:document.querySelectorAll('#eventReportList .eventReportCard').length,hour:IslandApp.getWorldState().hour,pending:Boolean(a?.current.pending_report),archive:JSON.stringify(a?.rounds[1]?.model_responses||[])};})()`);if(retried.round===2&&retried.reports===2&&!retried.pending)break;await sleep(100);}
  ok(retried?.reports===2&&Math.abs(retried.hour-1)<1e-9&&!retried.pending,'重试成功后只结算一次并生成第二轮报告');
  ok(retried?.archive.includes('本次注入的格式失败')&&retried?.archive.includes('求生者在营地完成周边观察'),'报告首次失败与重试成功的原文都留在对应轮次归档');

  await send('Runtime.evaluate',{expression:"document.getElementById('exportExperimentPdf').click()",userGesture:true,returnByValue:true});
  let exportTarget=null;for(let i=0;i<30&&!exportTarget;i++){const list=await targets();exportTarget=list.find(t=>t.type==='page'&&t.title?.includes('OLORUA 完整实验记录'));if(!exportTarget)await sleep(100);}
  ok(Boolean(exportTarget),'完整实验记录导出窗口打开');
  if(exportTarget){
    const pdfWs=new WebSocket(exportTarget.webSocketDebuggerUrl),pdfPending=new Map();let pdfId=0;
    pdfWs.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pdfPending.has(m.id)){const {res,rej}=pdfPending.get(m.id);pdfPending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
    await new Promise(r=>pdfWs.onopen=r);
    const pdfSend=(method,params={})=>new Promise((res,rej)=>{const i=++pdfId;pdfPending.set(i,{res,rej});pdfWs.send(JSON.stringify({id:i,method,params}));});
    const pdfText=await pdfSend('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true});
    ok(pdfText.result?.value?.includes('第 2 轮')&&pdfText.result.value.includes('参数单位对照'),'导出页包含跨轮记录与参数单位表');
    const pdfData=await pdfSend('Page.printToPDF',{printBackground:true});
    ok((pdfData.data||'').length>1000,'浏览器成功生成完整记录 PDF 数据');
    pdfWs.close();
  }

  const ms=await ev(`(()=>{const t=performance.now();for(let i=0;i<12;i++){position=[0+i,0];render();}return (performance.now()-t)/12;})()`);
  ok(ms<30,'浏览器渲染平均 '+ms.toFixed(2)+' ms（阈值30 ms）');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(150);
  const mobile=await ev(`(()=>({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,connection:document.querySelector('.visibleConnection').getBoundingClientRect().width,workspace:document.querySelector('.eventWorkspace')?.getBoundingClientRect().width||0}))()`);
  ok(mobile.document<=mobile.viewport+1,'390px 窄屏没有横向溢出（文档 '+mobile.document+' / 视口 '+mobile.viewport+' px）');
  ok(mobile.connection>0&&mobile.connection<=mobile.viewport,'窄屏模型连接区保持在视口内');
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
