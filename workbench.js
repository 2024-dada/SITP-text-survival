(function () {
  'use strict';
  const button = document.getElementById('exportExperimentPdf');
  const status = document.getElementById('archiveStatus');
  const prompt = document.getElementById('agentRoundPrompt');
  const draftKey = 'olorua.researcher-task-draft';
  const helper = document.createElement('div');
  helper.className = 'taskHelper';
  const counter = document.createElement('span');
  const clear = document.createElement('button');
  clear.type = 'button'; clear.textContent = '清空草稿';
  const draftStatus = document.createElement('span');
  draftStatus.setAttribute('role', 'status');
  helper.append(counter, draftStatus, clear); prompt.after(helper);
  try { if (!prompt.value) prompt.value = sessionStorage.getItem(draftKey) || ''; }
  catch { draftStatus.textContent = '草稿仅保留在当前页面'; }
  function saveDraft() {
    counter.textContent = `${prompt.value.length} 字 · 可输入单个行动或多时段日程`;
    try { sessionStorage.setItem(draftKey, prompt.value); draftStatus.textContent = '草稿已暂存于当前标签页'; }
    catch { draftStatus.textContent = '草稿仅保留在当前页面'; }
  }
  prompt.addEventListener('input', saveDraft);
  clear.addEventListener('click', () => { prompt.value = ''; saveDraft(); prompt.focus(); });
  saveDraft();
  const privacy = document.querySelector('.aiPrivacy');
  if (privacy) {
    const details = document.createElement('details'); details.className = 'connectionPrivacy';
    const summary = document.createElement('summary'); summary.textContent = '密钥保存与使用说明';
    privacy.before(details); details.append(summary, privacy);
  }
  const transcript = document.getElementById('agentTranscript');
  const tools = document.createElement('div'); tools.className = 'transcriptTools';
  for (const [label, action] of [
    ['查看最新对话', () => { transcript.scrollTop = transcript.scrollHeight; }],
    ['收起工具明细', () => { transcript.querySelectorAll('details').forEach(item => { item.open = false; }); }]
  ]) {
    const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.onclick = action; tools.append(control);
  }
  transcript.before(tools);
  const runStatus = document.getElementById('agentInteractionStatus');
  const exportStatus = () => {
    const running = document.getElementById('runAgentRound').disabled && document.getElementById('endAgentInteraction').disabled;
    button.disabled = running;
    status.textContent = `${document.getElementById('agentRoundCount').textContent} 轮已提交 · ${runStatus.textContent} · 刷新或重置前请导出`;
  };
  new MutationObserver(exportStatus).observe(runStatus, { childList: true, characterData: true, subtree: true });
  button.addEventListener('click', () => {
    const data = globalThis.SurvivalAgent.getExperimentArchive();
    if (!data) { status.textContent = '请先开始一次实验会话。'; return; }
    const page = window.open('', '_blank');
    if (!page) { status.textContent = '请允许此网站打开导出窗口，再点击导出。'; return; }
    const doc = page.document;
    doc.title = 'OLORUA 完整实验记录';
    const style = doc.createElement('style');
    style.textContent = '@page{size:A4;margin:18mm}body{font:11pt/1.65 "Microsoft YaHei",sans-serif;color:#182b35;margin:24px}h1{font-size:24pt}h2{border-bottom:1px solid #aab8be;padding-bottom:6px;break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:9pt/1.6 Consolas,"Microsoft YaHei",monospace}section{break-before:page}button{padding:12px 20px}@media print{button{display:none}body{margin:0}}';
    doc.head.append(style);
    const heading = doc.createElement('h1'); heading.textContent = 'OLORUA · 完整实验记录';
    const intro = doc.createElement('p'); intro.textContent = `已完成 ${data.rounds.length} 轮 · 导出时间 ${new Date().toLocaleString()}。使用打印窗口的“另存为 PDF”保存。`;
    const print = doc.createElement('button'); print.textContent = '打印 / 另存为 PDF'; print.onclick = () => page.print();
    doc.body.append(heading, intro, print);
    function section(title, value) {
      const block = doc.createElement('section'); const h = doc.createElement('h2'); const pre = doc.createElement('pre');
      h.textContent = title; pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); block.append(h, pre); doc.body.append(block);
    }
    section('实验初始状态', data.initial);
    for (const round of data.rounds) section(`第 ${round.round} 轮 · 输入、推理、参数与工具记录`, round);
    section('全部事件报告与状态结算', data.reports);
    section('当前状态与完整命令记录', data.current);
    status.textContent = '完整记录已打开，请在新窗口另存为 PDF。';
    page.focus();
  });
  const nav = document.querySelector('.workspaceNav');
  nav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    nav.querySelectorAll('a').forEach(item => item.removeAttribute('aria-current'));
    link.setAttribute('aria-current', 'location');
  });
  const targets = [...nav.querySelectorAll('a')].map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    nav.querySelectorAll('a').forEach(link => {
      if (link.hash === '#' + visible.target.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-75px 0px -45% 0px' });
  targets.forEach(target => observer.observe(target));
})();
