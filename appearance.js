(() => {
  'use strict';
  const key = 'olorua.appearance.v1';
  const defaults = { theme: 'tide', mode: 'dark', size: '16', strength: '55', motion: true };
  let settings = { ...defaults };
  try { const saved = JSON.parse(localStorage.getItem(key)); if (saved && typeof saved === 'object') settings = { ...defaults, ...saved }; } catch (_) { /* Unavailable storage uses defaults. */ }
  if (!['tide', 'forest', 'ember'].includes(settings.theme)) settings.theme = defaults.theme;
  if (!['dark', 'light'].includes(settings.mode)) settings.mode = defaults.mode;
  settings.size = String(Math.min(20, Math.max(14, Number(settings.size) || 16)));
  settings.strength = String(Math.min(100, Math.max(0, Number(settings.strength) || 0)));
  settings.motion = settings.motion !== false;
  const root = document.documentElement;
  function apply() {
    root.dataset.theme = settings.theme;
    root.dataset.mode = settings.mode;
    root.dataset.motion = settings.motion ? 'on' : 'off';
    root.style.setProperty('--reading-size', settings.size + 'px');
    root.style.setProperty('--atmosphere', String(Number(settings.strength) / 100));
    root.style.colorScheme = settings.mode;
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'appearanceDialog';
    dialog.setAttribute('aria-labelledby', 'appearanceTitle');
    dialog.innerHTML = `<div class="appearanceHead"><div><span class="appearanceKicker">PERSONAL SPACE</span><h2 id="appearanceTitle">让观察更舒适</h2><p>选择你的岛屿工作台。修改即时生效。</p></div><button type="button" id="closeAppearance" aria-label="关闭外观设置">✕</button></div>
      <fieldset class="themeChoices"><legend>视觉主题</legend>
      <button type="button" class="themeChoice" data-choice="tide"><span class="themePreview previewTide"><i></i><i></i><i></i></span><strong>深潮 · Tide</strong><small>深海蓝与薄荷青，安静专注</small></button>
      <button type="button" class="themeChoice" data-choice="forest"><span class="themePreview previewForest"><i></i><i></i><i></i></span><strong>雾林 · Forest</strong><small>林绿与苔金，柔和自然</small></button>
      <button type="button" class="themeChoice" data-choice="ember"><span class="themePreview previewEmber"><i></i><i></i><i></i></span><strong>暮岸 · Ember</strong><small>岩紫与暖杏，温润沉稳</small></button></fieldset>
      <div class="appearanceOptions"><label>界面明暗<select id="appearanceMode"><option value="dark">夜间 · 低眩光</option><option value="light">日间 · 柔和浅色</option></select></label><label>阅读字号 <output id="appearanceSizeValue"></output><input id="appearanceSize" type="range" min="14" max="20" step="1"></label><label>背景氛围 <output id="appearanceStrengthValue"></output><input id="appearanceStrength" type="range" min="0" max="100" step="5"></label><label class="appearanceToggle"><input id="appearanceMotion" type="checkbox">启用轻微过渡动画</label></div><div class="appearanceFoot"><span id="appearanceSaved" role="status">设置仅保存在此浏览器，不包含 API Key。</span><button type="button" id="resetAppearance">恢复默认</button></div>`;
    document.body.append(dialog);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'appearanceTrigger'; button.textContent = '◐ 外观'; button.setAttribute('aria-haspopup', 'dialog');
    document.querySelector('.headRight').prepend(button);
    button.addEventListener('click', () => dialog.showModal());
    dialog.querySelector('#closeAppearance').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
    function sync() {
      dialog.querySelectorAll('[data-choice]').forEach(card => card.setAttribute('aria-pressed', String(card.dataset.choice === settings.theme)));
      dialog.querySelector('#appearanceMode').value = settings.mode;
      dialog.querySelector('#appearanceSize').value = settings.size;
      dialog.querySelector('#appearanceStrength').value = settings.strength;
      dialog.querySelector('#appearanceMotion').checked = settings.motion;
      dialog.querySelector('#appearanceSizeValue').textContent = settings.size + ' px';
      dialog.querySelector('#appearanceStrengthValue').textContent = settings.strength + '%';
    }
    function update() { apply(); sync(); try { localStorage.setItem(key, JSON.stringify(settings)); dialog.querySelector('#appearanceSaved').textContent = '已保存 · 刷新后自动恢复'; } catch (_) { dialog.querySelector('#appearanceSaved').textContent = '当前浏览器无法保存；设置在本页仍有效。'; } }
    dialog.querySelectorAll('[data-choice]').forEach(card => card.addEventListener('click', () => { settings.theme = card.dataset.choice; update(); }));
    [['appearanceMode', 'mode'], ['appearanceSize', 'size'], ['appearanceStrength', 'strength']].forEach(([id, field]) => dialog.querySelector('#' + id).addEventListener('input', event => { settings[field] = event.target.value; update(); }));
    dialog.querySelector('#appearanceMotion').addEventListener('change', event => { settings.motion = event.target.checked; update(); });
    dialog.querySelector('#resetAppearance').addEventListener('click', () => { settings = { ...defaults }; update(); });
    sync();
  });
})();
