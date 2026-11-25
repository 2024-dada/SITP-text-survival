(function (G) {
  'use strict';

  const M = G.IslandModel;
  const el = id => document.getElementById(id);
  const SYSTEM_IDS = ['external', 'thermoregulation', 'cardiovascular', 'respiratory'];
  const PARAMETER_LABELS = {
    core_temp_c: '核心体温（℃）', skin_blood_flow_ml_min: '皮肤血流（ml/min）',
    shivering_heat_ml_min: '寒战产热（示例值）', sweat_rate_ml_h: '出汗（ml/h）',
    heart_rate_bpm: '心率（次/min）', systolic_bp_mmhg: '收缩压（mmHg）',
    diastolic_bp_mmhg: '舒张压（mmHg）', cardiac_output_l_min: '心输出量（L/min）',
    respiratory_rate_bpm: '呼吸频率（次/min）', tidal_volume_ml: '潮气量（ml）',
    minute_ventilation_l_min: '每分钟通气量（L/min）'
  };
  const activityMET = { move: 3, collect: 2, rest: 1 };
  const actionTool = {
    type: 'function',
    function: {
      name: 'normalize_selected_action',
      description: '只把研究者已经选择的固定操作整理成标准参数，不得改动作、改方向、改目标或自行决定行动。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['move', 'collect', 'rest'] },
          direction: { type: 'string', enum: ['north', 'east', 'south', 'west', 'none'] },
          duration_min: { type: 'integer' },
          site_id: { type: 'string' },
          resource_id: { type: 'string' },
          exercise_intensity_met: { type: 'number' },
          summary: { type: 'string' }
        },
        required: ['operation', 'direction', 'duration_min', 'site_id', 'resource_id', 'exercise_intensity_met', 'summary']
      }
    }
  };

  function makeTool(name, description, properties, required) {
    return {
      type: 'function',
      function: {
        name, description,
        parameters: { type: 'object', properties, required, additionalProperties: false }
      }
    };
  }
  const frameworkTools = [
    makeTool('list_systems', '列出身体框架内的系统编号、状态和参数名。', {}, []),
    makeTool('read_system', '读取一个系统本轮开始时的状态。', { system_id: { type: 'string' } }, ['system_id']),
    makeTool('edit_parameters', '为当前负责的系统排队添加、修改或删除参数；变化只在该系统推理结束后应用。', {
      ops: { type: 'array', items: { type: 'object', properties: {
        op: { type: 'string', enum: ['add', 'change', 'remove'] }, name: { type: 'string' }, value: { type: 'number' }
      }, required: ['op', 'name', 'value'], additionalProperties: false } }
    }, ['ops']),
    makeTool('deliver_event', '排队向另一个身体系统发送事件；身体系统之间本轮新发出的事件在下一回合读取。', {
      target_system_id: { type: 'string' }, event_description: { type: 'string' },
      delta_parameters: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, value: { type: 'number' }
      }, required: ['name', 'value'], additionalProperties: false } }
    }, ['target_system_id', 'event_description', 'delta_parameters']),
    makeTool('consume_events', '排队清空当前负责系统已经处理的事件。', {}, []),
    makeTool('set_statement', '排队更新当前负责系统给研究者看的简短文字状态。', { statement: { type: 'string' } }, ['statement']),
    makeTool('math_eval', '计算只包含数字、变量、括号及 + - * / ^ 或 ** 的数学表达式。', {
      expression: { type: 'string' },
      variables: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, value: { type: 'number' }
      }, required: ['name', 'value'], additionalProperties: false } }
    }, ['expression', 'variables'])
  ];

  let session = null;
  let busy = false;
  let modelCalls = 0;
  let visibleLines = 0;
  let roundActive = false;
  let roundCalls = 0;
  const apiKeyStorageName = 'olorua.sitp.model-api-key';

  function say(role, text) {
    const box = el('simLog');
    const line = document.createElement('p');
    const speaker = document.createElement('span');
    const body = document.createElement('span');
    line.className = 'dialogueLine';
    line.dataset.role = role;
    speaker.className = 'dialogueSpeaker';
    speaker.textContent = role;
    body.className = 'dialogueText';
    body.textContent = String(text);
    line.append(speaker, body);
    box.append(line);
    visibleLines += 1;
    while (visibleLines > 240) {
      const first = box.querySelector('.dialogueLine');
      if (!first) break;
      first.remove();
      visibleLines -= 1;
    }
    box.scrollTop = box.scrollHeight;
  }

  function status(text, kind) {
    el('aiStatus').textContent = text;
    el('aiStatus').dataset.kind = kind || '';
  }

  function saveRememberedKey() {
    if (!el('rememberApiKey').checked) return;
    const key = el('aiApiKey').value.trim();
    try {
      if (key) localStorage.setItem(apiKeyStorageName, key);
      else localStorage.removeItem(apiKeyStorageName);
    } catch {
      el('rememberApiKey').checked = false;
      status('浏览器不允许保存本机密钥；本次仍可在当前页面使用。', 'error');
    }
  }

  function handleRememberKeyChange() {
    if (el('rememberApiKey').checked) { saveRememberedKey(); return; }
    try { localStorage.removeItem(apiKeyStorageName); }
    catch { status('无法删除浏览器中已保存的Key；请在浏览器站点设置中清除此网页数据。', 'error'); }
  }

  function loadRememberedKey() {
    try {
      const key = localStorage.getItem(apiKeyStorageName);
      if (key) {
        el('aiApiKey').value = key;
        el('rememberApiKey').checked = true;
      }
    } catch {
      status('浏览器不允许读取本机已保存的密钥；请重新输入。', 'error');
    }
  }

  function setSimulationStatus(text, kind) {
    el('simStatus').textContent = text;
    el('simStatus').dataset.kind = kind || '';
  }

  function setBusy(value) {
    busy = value;
    el('runAction').disabled = value || !session || Boolean(session && session.pendingAction);
    el('retryAction').disabled = value;
    el('retryAction').hidden = value || !session || !session.pendingAction;
    document.querySelectorAll('.actionComposer select, #startExperiment, #randomSeed').forEach(input => { input.disabled = value || Boolean(session && session.pendingAction); });
    document.querySelectorAll('.aiSettingsGrid input, .aiSettingsGrid select, #discoverModels').forEach(input => { input.disabled = value; });
    el('endExperiment').disabled = value;
  }

  function lockResearchControls(locked) {
    document.querySelectorAll('#play, [data-step], #nextRain, #collector, #reset, #save, #load, #nearby button').forEach(control => { control.disabled = locked; });
    el('endExperiment').hidden = !locked;
  }

  function normalizeEndpoint(raw) {
    let url;
    try { url = new URL(raw.trim()); } catch { throw new Error('API 地址不是有效的网址。'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('API 地址必须使用 HTTPS；只有本机 localhost 可以用 HTTP。');
    if (url.username || url.password) throw new Error('API 地址不能把账号或密钥写在网址里。');
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.toLowerCase().endsWith('/chat/completions')) url.pathname += '/chat/completions';
    return url.href;
  }

  function getConnection() {
    const apiKey = el('aiApiKey').value.trim();
    if (!apiKey) throw new Error('请先在“模型连接设置”中填写 API Key。');
    const endpoint = normalizeEndpoint(el('aiEndpoint').value);
    return { apiKey, endpoint };
  }

  function getSettings() {
    const { apiKey, endpoint } = getConnection();
    const model = el('aiModelName').value.trim();
    if (!model) throw new Error('请填写模型名，或先获取模型列表再选择。');
    return { apiKey, endpoint, model };
  }

  function modelsEndpoint(chatEndpoint) {
    const url = new URL(chatEndpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions$/i, '/models');
    return url.href;
  }

  async function fetchWithTimeout(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      return await fetch(url, { ...options, signal: controller.signal, mode: 'cors', credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      const roundNote = label === '模型调用' ? '此轮状态没有提交；可以重试同一动作。' : '可以稍后重试。';
      if (error.name === 'AbortError') throw new Error(label + '等待超过90秒，' + roundNote);
      throw new Error(label + '网络连接失败。请检查网络、API 地址和服务商跨域设置；' + roundNote + '浏览器提示：' + error.message);
    } finally {
      clearTimeout(timer);
    }
  }

  async function responseJson(response, apiKey, label) {
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(label + '返回的不是 JSON（HTTP ' + response.status + '）。'); }
    if (!response.ok) {
      let message = data && data.error && data.error.message || data && data.message || 'HTTP ' + response.status;
      if (apiKey) message = String(message).split(apiKey).join('[已隐藏密钥]');
      throw new Error(label + '失败：' + String(message).slice(0, 500));
    }
    return data;
  }

  async function requestCompletion(settings, messages, tools, choice) {
    if (roundActive && roundCalls >= 32) throw new Error('本轮模型请求达到32次上限；为控制调用量，岛屿和身体状态均未提交。');
    if (roundActive) roundCalls += 1;
    modelCalls += 1;
    el('modelCallCount').textContent = String(modelCalls);
    const payload = {
      model: settings.model, messages, tools, tool_choice: choice, max_tokens: 1800, stream: false
    };
    if (new URL(settings.endpoint).hostname.toLowerCase().endsWith('deepseek.com')) payload.thinking = { type: 'disabled' };
    const response = await fetchWithTimeout(settings.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
      body: JSON.stringify(payload)
    }, '模型调用');
    const data = await responseJson(response, settings.apiKey, '模型调用');
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!message || typeof message !== 'object') throw new Error('模型响应中没有 choices[0].message，无法完成本轮。');
    if (data.choices[0].finish_reason === 'length') throw new Error('模型输出达到长度上限，未完成本轮；请稍后重试。');
    return message;
  }

  async function discoverModels() {
    if (busy) return;
    const select = el('aiModelChoices');
    select.replaceChildren(new Option('正在获取模型…', ''));
    try {
      const settings = getConnection();
      status('正在读取模型列表……');
      const response = await fetchWithTimeout(modelsEndpoint(settings.endpoint), {
        method: 'GET', headers: { Authorization: 'Bearer ' + settings.apiKey }
      }, '模型列表读取');
      const data = await responseJson(response, settings.apiKey, '模型列表读取');
      if (!Array.isArray(data.data)) throw new Error('返回格式里没有模型列表字段 data。请手动输入模型名。');
      select.replaceChildren(new Option('请选择模型', ''));
      data.data.forEach(item => {
        if (typeof item.id !== 'string' || !item.id) return;
        select.append(new Option(item.name ? item.name + '（' + item.id + '）' : item.id, item.id));
      });
      status('读到 ' + (select.options.length - 1) + ' 个模型。列表不代表当前 Key 一定有调用权限。', 'ok');
    } catch (error) {
      select.replaceChildren(new Option('未获取到模型，可手动填写', ''));
      status(error.message + ' 仍可手动填写模型名。', 'error');
    }
  }

  function validateBodyFramework(frame) {
    if (!frame || !frame.framework_param || !Number.isFinite(frame.framework_param.time_delta) || !Number.isFinite(frame.framework_param.real_time_delta) || !Array.isArray(frame.systems)) throw new Error('身体框架文件缺少合法的 framework_param 或 systems 列表。');
    const ids = frame.systems.map(system => system.system_id);
    if (ids.length !== SYSTEM_IDS.length || new Set(ids).size !== ids.length || SYSTEM_IDS.some(id => !ids.includes(id))) throw new Error('身体框架系统与网页当前接入的系统不完全一致，或系统编号重复。');
    for (const system of frame.systems) {
      if (typeof system.rule !== 'string' || !system.rule || !Array.isArray(system.parameters) || !Array.isArray(system.events) || !Number.isFinite(system.time_clock) || typeof system.statement !== 'string') throw new Error('身体框架 ' + system.system_id + ' 的规则、时钟、状态文字、参数或事件格式不完整。');
      const names = system.parameters.map(parameter => parameter.param);
      if (new Set(names).size !== names.length) throw new Error('身体框架 ' + system.system_id + ' 中有重复参数名。');
      for (const parameter of system.parameters) if (typeof parameter.param !== 'string' || !parameter.param || !Number.isFinite(parameter.value)) throw new Error('身体框架 ' + system.system_id + ' 存在不合法参数。');
      for (const event of system.events) if (!event || typeof event.event_description !== 'string' || !Array.isArray(event.delta_parameters)) throw new Error('身体框架 ' + system.system_id + ' 存在不合法事件。');
    }
  }

  function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

  function formatClock(world) {
    const date = M.weather(world.hour, world.seed).date;
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' · 第 ' + (session ? session.round : 0) + ' 回合 · 已推进 ' + world.hour.toFixed(2) + ' 小时';
  }

  function renderInventory() {
    if (!session) { el('inventoryStatus').textContent = ''; return; }
    const entries = Object.entries(session.inventory);
    el('inventoryStatus').textContent = entries.length
      ? '随身物品（仅采集，不自动食用）：' + entries.map(([rid, item]) => M.D.pools[rid].name + ' ' + item.amount.toFixed(item.unit === 'kg' ? 1 : 0) + ' ' + item.unit).join('；')
      : '随身物品：空。采集只进入物品栏，不代表已经饮水或进食。';
  }

  function currentAction() {
    const kind = el('actionKind').value;
    const action = { kind, direction: 'none', durationMin: 15, siteId: '', resourceId: '' };
    if (kind === 'move') {
      action.direction = el('moveDirection').value;
      action.durationMin = Number(el('moveDuration').value);
    } else if (kind === 'rest') action.durationMin = Number(el('restDuration').value);
    else {
      action.siteId = el('collectSite').value;
      action.resourceId = el('collectResource').value;
      if (!action.siteId || !action.resourceId) throw new Error('求生者当前位置附近没有可采集的资源点。请先移动到资源点附近。');
      const site = M.D.sites.find(item => item.id === action.siteId);
      if (!site || Math.hypot(site.east_m - session.position[0], site.north_m - session.position[1]) > 35) throw new Error('采集目标已不在求生者附近，请刷新目标后重选。');
    }
    if (!Number.isInteger(action.durationMin) || ![15, 60].includes(action.durationMin)) throw new Error('动作时长必须是15分钟或60分钟。');
    return action;
  }

  function actionText(action) {
    if (action.kind === 'move') return '移动：向' + { north: '北', east: '东', south: '南', west: '西' }[action.direction] + '走 ' + action.durationMin + ' 分钟';
    if (action.kind === 'rest') return '原地休息 ' + action.durationMin + ' 分钟';
    const site = M.D.sites.find(item => item.id === action.siteId);
    return '在 ' + action.siteId + ' · ' + site.name + ' 采集 ' + M.D.pools[action.resourceId].name + '（15分钟）';
  }

  function refreshOptions(world, position) {
    if (!session) return;
    world = world || session.world;
    position = position || session.position;
    const siteSelect = el('collectSite');
    const selectedBefore = siteSelect.value;
    const nearby = M.D.sites.map(site => ({ site, distance: Math.hypot(site.east_m - position[0], site.north_m - position[1]) }))
      .filter(item => item.distance <= 35)
      .sort((a, b) => a.distance - b.distance);
    siteSelect.replaceChildren();
    const available = nearby.filter(({ site }) => {
      const current = world.sites.find(item => item.id === site.id);
      return current && current.pools.some(pool => pool.resource !== 'R08' && pool.amount > 0);
    });
    if (!available.length) siteSelect.append(new Option('附近没有采集点', ''));
    for (const item of available) siteSelect.append(new Option(item.site.id + ' · ' + item.site.name + '（约' + Math.round(item.distance) + '米）', item.site.id));
    if (selectedBefore && [...siteSelect.options].some(option => option.value === selectedBefore)) siteSelect.value = selectedBefore;
    refreshResourceOptions(world);
    el('actionPreview').textContent = available.length
      ? '资源点按人物位置和当前库存筛出；能否采集还要通过时间、潮位等规则检查。'
      : '角色当前位置附近35米内没有可采集的资源点。可先移动，再查看新位置附近的目标。';
  }

  function refreshResourceOptions(world) {
    if (!session) return;
    world = world || session.world;
    const siteId = el('collectSite').value;
    const select = el('collectResource');
    select.replaceChildren();
    const site = world.sites.find(item => item.id === siteId);
    const options = site ? site.pools.filter(pool => pool.resource !== 'R08' && pool.amount > 0) : [];
    if (!options.length) select.append(new Option('没有可采集库存', ''));
    for (const pool of options) select.append(new Option(M.D.pools[pool.resource].name + '（剩余' + pool.amount.toFixed(pool.unit === 'kg' ? 1 : 0) + ' ' + pool.unit + '）', pool.resource));
  }

  function updateActionFields() {
    const kind = el('actionKind').value;
    el('moveFields').hidden = kind !== 'move';
    el('collectFields').hidden = kind !== 'collect';
    el('restFields').hidden = kind !== 'rest';
    if (!session) return;
    el('actionPreview').textContent = kind === 'collect'
      ? '采集会扣除岛屿库存并进入随身物品，不会自动摄入。'
      : kind === 'move' ? '移动距离由演示速度、局部坡度和降雨粗略结算；身体组能力尚未接入。'
        : '休息期间世界时间照常推进；身体变化由身体框架处理。';
  }

  function expectedAction(action) {
    return {
      operation: action.kind,
      direction: action.kind === 'move' ? action.direction : 'none',
      duration_min: action.durationMin,
      site_id: action.kind === 'collect' ? action.siteId : '',
      resource_id: action.kind === 'collect' ? action.resourceId : '',
      exercise_intensity_met: activityMET[action.kind]
    };
  }

  function parseArguments(call) {
    try { return JSON.parse(call.function.arguments); }
    catch { throw new Error('模型工具 ' + call.function.name + ' 的参数不是合法 JSON。'); }
  }

  async function normalizeAction(settings, action, world) {
    const expected = expectedAction(action);
    const weather = M.weather(world.hour, world.seed, session.position);
    const input = {
      observer_selected_action: actionText(action), fixed_form_values: expected,
      current_simulation_time_hours: world.hour, current_position_east_north_m: session.position,
      local_weather: { temperature_c: weather.temperature, local_rain_mm_h: weather.rain, daylight: weather.daylight },
      instruction: '只核对并标准化这条已经选定的操作。不能提出别的行动、改变时长、方向或资源目标。summary用一句简短中文说明标准参数。'
    };
    const message = await requestCompletion(settings, [
      { role: 'system', content: '你是操作指令格式化器，不是行动决策者。必须调用 normalize_selected_action，照抄固定表单参数；只允许补一句简短说明。MET是原型演示输入值。' },
      { role: 'user', content: JSON.stringify(input) }
    ], [actionTool], { type: 'function', function: { name: 'normalize_selected_action' } });
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 1 || message.tool_calls[0].function.name !== 'normalize_selected_action') throw new Error('AI没有按要求返回唯一的动作参数；岛屿未结算。');
    const args = parseArguments(message.tool_calls[0]);
    for (const [key, value] of Object.entries(expected)) if (args[key] !== value) throw new Error('AI改动了观测者选定的动作参数 ' + key + '；本轮已取消。');
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 140) throw new Error('AI没有返回合规的简短操作说明。');
    return { ...action, met: expected.exercise_intensity_met, summary: args.summary.trim() };
  }

  function terrainMovement(start, direction, durationMin, weatherSamples, world) {
    const vector = { north: [0, 1], east: [1, 0], south: [0, -1], west: [-1, 0] }[direction];
    const requested = 0.42 * durationMin * 60;
    const count = Math.max(1, Math.floor(requested / 10));
    let heightGain = 0, previousHeight = M.terrain(start), lastDistance = 0;
    for (let i = 1; i <= count; i++) {
      const distance = requested * i / count;
      const point = [start[0] + vector[0] * distance, start[1] + vector[1] * distance];
      if (!M.inside(point)) break;
      const height = M.terrain(point);
      heightGain += Math.max(0, height - previousHeight);
      previousHeight = height;
      lastDistance = distance;
    }
    const gradeFactor = Math.max(0.45, Math.min(1, 1 - heightGain / Math.max(1, lastDistance) * 1.4));
    const rain = weatherSamples.reduce((sum, item) => sum + item.rain, 0) / weatherSamples.length;
    const observation = M.observe(world, start);
    const wet = Number.isFinite(observation.local.wet) ? observation.local.wet : 0;
    const rainFactor = rain > 0 ? 0.82 : 1;
    const wetFactor = 1 - 0.12 * wet;
    const distanceLimit = requested * gradeFactor * rainFactor * wetFactor;
    let moved = 0;
    for (let distance = 1; distance <= distanceLimit; distance++) {
      const point = [start[0] + vector[0] * distance, start[1] + vector[1] * distance];
      if (!M.inside(point)) break;
      moved = distance;
    }
    return {
      position: [start[0] + vector[0] * moved, start[1] + vector[1] * moved],
      distance_m: moved, distanceLimit, gradeFactor, rainFactor, wetFactor
    };
  }

  function actionWeather(world, start, end, durationMin) {
    const samples = [];
    const count = durationMin / 15;
    for (let i = 0; i < count; i++) {
      const fraction = (i + 0.5) / count;
      const point = [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
      samples.push(M.weather(world.hour + durationMin / 60 * fraction, world.seed, point));
    }
    return {
      temperature_c: samples.reduce((sum, item) => sum + item.temperature, 0) / samples.length,
      local_rain_mm_h: samples.reduce((sum, item) => sum + item.rain, 0) / samples.length,
      daylight_fraction: samples.filter(item => item.daylight).length / samples.length,
      start: samples[0], end: samples[samples.length - 1]
    };
  }

  function resolveIslandAction(world, action, startPosition, inventory) {
    let endPosition = startPosition.slice(), movement = null, collected = null;
    if (action.kind === 'move') {
      const weatherAtStart = actionWeather(world, startPosition, startPosition, action.durationMin);
      movement = terrainMovement(startPosition, action.direction, action.durationMin, [weatherAtStart.start, weatherAtStart.end], world);
      endPosition = movement.position;
    } else if (action.kind === 'collect') {
      const amount = M.harvest(world, action.siteId, action.resourceId, '求生者');
      const pool = world.sites.find(site => site.id === action.siteId).pools.find(item => item.resource === action.resourceId);
      const item = inventory[action.resourceId] || (inventory[action.resourceId] = { amount: 0, unit: pool.unit });
      item.amount += amount;
      collected = { amount, unit: pool.unit, name: M.D.pools[action.resourceId].name };
    }
    const exposure = actionWeather(world, startPosition, endPosition, action.durationMin);
    M.tick(world, action.durationMin / 60);
    world.selected = endPosition.slice();
    return {
      endPosition, durationHours: action.durationMin / 60, movement, collected, exposure,
      obs: M.observe(world, endPosition), weatherAfter: M.weather(world.hour, world.seed, endPosition)
    };
  }

  function systemState(frame, system) {
    return {
      system_id: system.system_id,
      framework_param: { time_delta: frame.framework_param.time_delta },
      time_clock: system.time_clock, parameters: system.parameters,
      statement: system.statement, events: system.events
    };
  }

  async function runBodySystem(settings, frame, systemId) {
    const system = frame.systems.find(item => item.system_id === systemId);
    const initial = cloneJson(systemState(frame, system));
    const commands = { parameterOps: [], events: [], statement: null, consumeEvents: false };
    const messages = [
      { role: 'system', content: system.rule + '\n\n网页移植约定：time_delta 与 time_clock 单位均为分钟；当前回合时长已写在 framework_param.time_delta 中。带“岛屿端本轮上下文”且 delta_parameters 为空的事件只提供环境/动作事实，不代表量化的人体变化。只通过工具提交当前系统的修改；不得诊断疾病、决定死亡或编造未提供的风速/空气湿度。' },
      { role: 'user', content: JSON.stringify(initial) }
    ];
    for (let round = 0; round < 6; round++) {
      const message = await requestCompletion(settings, messages, frameworkTools, 'auto');
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length > 12) throw new Error(systemId + ' 单次响应的工具调用超过12项上限，未提交本轮。');
      if (!calls.length) {
        if (commands.statement === null) throw new Error(systemId + ' 没有调用 set_statement，未提交状态。');
        if (initial.events.length && !commands.consumeEvents) throw new Error(systemId + ' 没有处理并清空本轮事件，未提交状态。');
        return { systemId, commands, finalText: typeof message.content === 'string' ? message.content : '' };
      }
      messages.push({ role: 'assistant', content: message.content === undefined ? null : message.content, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: call.function })) });
      for (const call of calls) {
        if (!call.id || call.type !== 'function') throw new Error(systemId + ' 返回了不完整的工具调用记录。');
        const args = parseArguments(call);
        const result = executeBodyTool(frame, system, commands, call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error(systemId + ' 连续调用工具达到6轮上限，未完成本轮。');
  }

  function executeBodyTool(frame, self, commands, name, args) {
    const systems = frame.systems;
    const findSystem = id => systems.find(system => system.system_id === id);
    if (name === 'list_systems') return { ok: true, systems: systems.map(system => ({
      system_id: system.system_id, statement: system.statement, parameters: system.parameters.map(parameter => parameter.param)
    })) };
    if (name === 'read_system') {
      const system = findSystem(args.system_id);
      if (!system) throw new Error(self.system_id + ' 请求读取不存在的系统 ' + args.system_id + '。');
      return { ok: true, ...cloneJson(systemState(frame, system)) };
    }
    if (name === 'edit_parameters') {
      if (!Array.isArray(args.ops) || args.ops.length > 24) throw new Error('edit_parameters.ops 必须是最多24项的数组。');
      const known = new Set(self.parameters.map(parameter => parameter.param));
      const changed = new Set();
      for (const operation of args.ops) {
        if (!['add', 'change', 'remove'].includes(operation.op) || typeof operation.name !== 'string' || !operation.name || operation.name.length > 100 || !Number.isFinite(operation.value) || Math.abs(operation.value) > 1000000) throw new Error('edit_parameters 中存在不合法操作、参数名或数值。');
        if (changed.has(operation.name)) throw new Error(self.system_id + '.' + operation.name + ' 在同一批操作中被重复修改。');
        changed.add(operation.name);
        const exists = known.has(operation.name);
        if (operation.op === 'add' && exists) throw new Error(self.system_id + '.' + operation.name + ' 已存在，不能重复添加。');
        if (operation.op !== 'add' && !exists) throw new Error(self.system_id + '.' + operation.name + ' 不存在，不能修改或删除。');
        if (operation.op === 'add') known.add(operation.name);
        if (operation.op === 'remove') known.delete(operation.name);
        commands.parameterOps.push({ op: operation.op, name: operation.name, value: operation.value });
      }
      return { ok: true, queued: true };
    }
    if (name === 'deliver_event') {
      const target = findSystem(args.target_system_id);
      if (!target) throw new Error('deliver_event 目标 ' + args.target_system_id + ' 不存在。');
      if (typeof args.event_description !== 'string' || !args.event_description.trim() || args.event_description.length > 1200 || !Array.isArray(args.delta_parameters) || args.delta_parameters.length > 24) throw new Error('deliver_event 描述或参数格式不合法。');
      const delta = args.delta_parameters.map(parameter => {
        if (typeof parameter.name !== 'string' || !parameter.name || parameter.name.length > 100 || !Number.isFinite(parameter.value) || Math.abs(parameter.value) > 1000000) throw new Error('事件参数名不能为空且数值必须有限。');
        if (!target.parameters.some(current => current.param === parameter.name)) throw new Error('目标系统 ' + target.system_id + ' 没有参数 ' + parameter.name + '。');
        return { param: parameter.name, value: parameter.value };
      });
      commands.events.push({ target_system_id: target.system_id, event_description: args.event_description.trim(), delta_parameters: delta });
      return { ok: true, queued: true };
    }
    if (name === 'consume_events') { commands.consumeEvents = true; return { ok: true, queued: true }; }
    if (name === 'set_statement') {
      if (typeof args.statement !== 'string' || !args.statement.trim() || args.statement.length > 400) throw new Error('set_statement需要1至400字的状态说明。');
      commands.statement = args.statement.trim();
      return { ok: true, queued: true };
    }
    if (name === 'math_eval') return { ok: true, value: evaluateMath(args.expression, args.variables) };
    throw new Error(self.system_id + ' 调用了不支持的工具 ' + name + '。');
  }

  function evaluateMath(expression, variables) {
    if (typeof expression !== 'string' || expression.length > 240 || !Array.isArray(variables)) throw new Error('math_eval输入格式不合法。');
    const values = new Map(variables.map(item => {
      if (typeof item.name !== 'string' || !item.name || !Number.isFinite(item.value)) throw new Error('math_eval变量名或数值不合法。');
      return [item.name, item.value];
    }));
    const tokens = [];
    const pattern = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[()+\-*/^]))/gy;
    let index = 0;
    while (index < expression.length) {
      pattern.lastIndex = index;
      const match = pattern.exec(expression);
      if (!match || match.index !== index) throw new Error('math_eval只支持数字、变量、括号和 + - * / ^ 或 **。');
      tokens.push(match[1] || match[2] || match[3]);
      index = pattern.lastIndex;
    }
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = () => tokens[cursor++];
    function primary() {
      const token = take();
      if (token === '(') { const value = sum(); if (take() !== ')') throw new Error('math_eval括号不匹配。'); return value; }
      if (token === undefined) throw new Error('math_eval表达式不完整。');
      if (/^(?:\d|\.)/.test(token)) return Number(token);
      if (/^[A-Za-z_]/.test(token)) {
        if (!values.has(token)) throw new Error('math_eval缺少变量 ' + token + '。');
        return values.get(token);
      }
      throw new Error('math_eval表达式不完整。');
    }
    function power() { const left = primary(); if (peek() === '^' || peek() === '**') { take(); return left ** unary(); } return left; }
    function unary() { if (peek() === '+') { take(); return unary(); } if (peek() === '-') { take(); return -unary(); } return power(); }
    function product() {
      let value = unary();
      while (peek() === '*' || peek() === '/') {
        const op = take(), right = unary();
        if (op === '/' && right === 0) throw new Error('math_eval不能除以0。');
        value = op === '*' ? value * right : value / right;
      }
      return value;
    }
    function sum() {
      let value = product();
      while (peek() === '+' || peek() === '-') {
        const op = take(), right = product();
        value = op === '+' ? value + right : value - right;
      }
      return value;
    }
    const result = sum();
    if (cursor !== tokens.length || !Number.isFinite(result)) throw new Error('math_eval表达式多余或结果不是有限数值。');
    return result;
  }

  function applyCommands(frame, result) {
    const self = frame.systems.find(system => system.system_id === result.systemId);
    for (const operation of result.commands.parameterOps) {
      const index = self.parameters.findIndex(parameter => parameter.param === operation.name);
      if (operation.op === 'add') self.parameters.push({ param: operation.name, value: operation.value });
      else if (operation.op === 'change') self.parameters[index].value = operation.value;
      else self.parameters.splice(index, 1);
    }
    if (result.commands.statement !== null) self.statement = result.commands.statement;
    if (result.commands.consumeEvents) self.events = [];
    for (const event of result.commands.events) {
      frame.systems.find(system => system.system_id === event.target_system_id).events.push({
        event_description: event.event_description,
        delta_parameters: event.delta_parameters.map(parameter => ({ ...parameter }))
      });
    }
  }

  function validateBodyState(frame) {
    validateBodyFramework(frame);
    for (const system of frame.systems) {
      if (!Number.isFinite(system.time_clock) || system.time_clock < 0 || typeof system.statement !== 'string') throw new Error(system.system_id + ' 的时钟或文字状态不合法。');
      for (const parameter of system.parameters) if (!Number.isFinite(parameter.value)) throw new Error(system.system_id + '.' + parameter.param + ' 不是有限数值。');
      for (const event of system.events) {
        if (!event.event_description || !Array.isArray(event.delta_parameters)) throw new Error(system.system_id + ' 存在格式不合法的事件。');
        for (const parameter of event.delta_parameters) if (!Number.isFinite(parameter.value)) throw new Error(system.system_id + ' 的事件数值不是有限数值。');
      }
    }
  }

  async function processBody(settings, frame, action, context) {
    frame.framework_param.time_delta = action.durationMin;
    frame.framework_param.real_time_delta = 0;
    const external = frame.systems.find(system => system.system_id === 'external');
    external.parameters = context.parameters.map(item => ({ param: item.param, value: item.value }));
    external.statement = context.systemText;
    const inputEvent = {
      event_description: '岛屿端本轮上下文（事实输入，不是已经量化的人体变化）：' + context.actionDescription + ' ' + context.systemText,
      delta_parameters: []
    };
    external.events.push(cloneJson(inputEvent));
    SYSTEM_IDS.filter(id => id !== 'external').forEach(id => frame.systems.find(system => system.system_id === id).events.push(cloneJson(inputEvent)));

    const externalResult = await runBodySystem(settings, frame, 'external');
    applyCommands(frame, externalResult);
    const ids = SYSTEM_IDS.filter(id => id !== 'external');
    const settled = await Promise.allSettled(ids.map(id => runBodySystem(settings, frame, id)));
    const failed = settled.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    const results = settled.map(item => item.value);
    results.forEach(result => applyCommands(frame, result));
    frame.systems.forEach(system => { system.time_clock += action.durationMin; });
    validateBodyState(frame);
    return [externalResult, ...results];
  }

  function changedParameters(oldSystem, newSystem) {
    const before = new Map(oldSystem.parameters.map(parameter => [parameter.param, parameter.value]));
    const changes = [];
    for (const parameter of newSystem.parameters) if (before.get(parameter.param) !== parameter.value) {
      changes.push((PARAMETER_LABELS[parameter.param] || parameter.param) + ' ' + (Number.isFinite(before.get(parameter.param)) ? before.get(parameter.param) : '新增') + ' → ' + parameter.value);
    }
    for (const parameter of oldSystem.parameters) if (!newSystem.parameters.some(item => item.param === parameter.param)) changes.push((PARAMETER_LABELS[parameter.param] || parameter.param) + ' 已移除');
    return changes;
  }

  function makeEventContext(action, outcome, world) {
    const startDate = M.weather(world.hour - outcome.durationHours, world.seed).date.toISOString();
    const endDate = M.weather(world.hour, world.seed).date.toISOString();
    const elevation = M.terrain(outcome.endPosition);
    const movement = outcome.movement
      ? '实际移动' + outcome.movement.distance_m + '米（演示速度0.42米/秒；坡度因子' + outcome.movement.gradeFactor.toFixed(2) + '；降雨因子' + outcome.movement.rainFactor.toFixed(2) + '；地表湿润因子' + outcome.movement.wetFactor.toFixed(2) + '）'
      : '本轮未发生位置移动';
    const item = outcome.collected
      ? '采集' + outcome.collected.name + ' ' + outcome.collected.amount + ' ' + outcome.collected.unit + '并加入物品；未直接摄入'
      : '本轮没有采集物品';
    const weather = '行动期间平均气温' + outcome.exposure.temperature_c.toFixed(1) + '℃、当地平均雨强' + outcome.exposure.local_rain_mm_h.toFixed(2) + '毫米/小时、白昼比例' + Math.round(outcome.exposure.daylight_fraction * 100) + '%';
    const actionDescription = actionText(action) + '；AI格式化说明：' + action.summary + '；' + movement + '；' + item + '；' + weather + '。';
    const parameters = [
      ['ambient_temp_c', outcome.exposure.temperature_c],
      ['local_rain_mm_h', outcome.exposure.local_rain_mm_h],
      ['daylight_fraction', outcome.exposure.daylight_fraction],
      ['elevation_m', elevation],
      ['exercise_intensity_met', action.met],
      ['action_duration_min', action.durationMin],
      ['actual_movement_m', outcome.movement ? outcome.movement.distance_m : 0]
    ].map(pair => ({ param: pair[0], value: pair[1] }));
    const systemText = '模拟时间 ' + startDate + ' 至 ' + endDate + '；位置东 ' + outcome.endPosition[0].toFixed(1) + ' 米、北 ' + outcome.endPosition[1].toFixed(1) + ' 米；海拔插值 ' + elevation.toFixed(1) + ' 米。' + actionDescription + ' 风速与空气湿度：当前网站未提供，视为未知，不可当作0。';
    return { actionDescription, systemText, parameters };
  }

  function outcomeText(action, outcome) {
    const lines = [action.summary, '岛屿规则结算：' + actionText(action) + '。'];
    if (outcome.movement) lines.push('实际移动 ' + outcome.movement.distance_m + ' 米；' + (outcome.movement.distance_m < outcome.movement.distanceLimit ? '到达海岸或岛界后停止。' : '本轮未碰到岛界。'));
    if (outcome.collected) lines.push('物品变化：' + outcome.collected.name + ' +' + outcome.collected.amount + ' ' + outcome.collected.unit + '；没有自动吃喝。');
    lines.push('地点：东 ' + outcome.endPosition[0].toFixed(1) + ' 米、北 ' + outcome.endPosition[1].toFixed(1) + ' 米；海拔插值 ' + M.terrain(outcome.endPosition).toFixed(1) + ' 米。');
    lines.push('岛屿文字观察：\n' + outcome.obs.role);
    return lines.join('\n');
  }

  async function performRound(action) {
    if (!session || busy) return;
    let settings;
    try { settings = getSettings(); }
    catch (error) { status(error.message, 'error'); say('输入错误', error.message); return; }
    session.pendingAction = cloneJson(action);
    setBusy(true);
    roundActive = true;
    roundCalls = 0;
    setSimulationStatus('双方处理中 · 模拟时间暂停');
    let committed = false;
    try {
      say('观测者', actionText(action));
      const islandStage = cloneJson(session.world);
      const bodyStage = cloneJson(session.body);
      const inventoryStage = cloneJson(session.inventory);
      const startPosition = session.position.slice();
      const normalized = await normalizeAction(settings, action, islandStage);
      say('操作解析 AI', normalized.summary + '；标准操作=' + normalized.kind + '；时长=' + normalized.durationMin + '分钟；体力强度输入=' + normalized.met + ' MET（演示值）。');
      const outcome = resolveIslandAction(islandStage, normalized, startPosition, inventoryStage);
      const context = makeEventContext(normalized, outcome, islandStage);
      const beforeBody = cloneJson(bodyStage);
      const results = await processBody(settings, bodyStage, normalized, context);
      M.validate(islandStage);
      if (!M.inside(outcome.endPosition)) throw new Error('岛屿裁决返回了海面坐标，拒绝提交。');
      G.IslandApp.setWorldState(islandStage, outcome.endPosition);
      session.world = islandStage;
      session.body = bodyStage;
      session.inventory = inventoryStage;
      session.position = outcome.endPosition.slice();
      session.round += 1;
      session.pendingAction = null;
      committed = true;
      el('simRound').textContent = String(session.round);
      el('simClock').textContent = formatClock(session.world);
      renderInventory();
      refreshOptions();
      updateSurvivorMarker(session.position, true);
      setSimulationStatus('回合已统一提交');
      say('岛屿端', outcomeText(normalized, outcome));
      for (const result of results) {
        const after = bodyStage.systems.find(system => system.system_id === result.systemId);
        const before = beforeBody.systems.find(system => system.system_id === result.systemId);
        const changes = changedParameters(before, after);
        say('身体端 · ' + result.systemId, changes.length ? after.statement + '\n本轮参数：' + changes.join('；') : after.statement);
      }
      say('系统', '第 ' + session.round + ' 回合完成。岛屿状态与身体框架均已更新，模拟时间统一推进 ' + normalized.durationMin + ' 分钟。');
    } catch (error) {
      if (committed) {
        setSimulationStatus('回合已提交 · 界面刷新有误', 'error');
        say('界面错误', '本轮状态已经统一提交并推进时间，但部分文字未能刷新：' + (error.message || String(error)));
        status('本轮已经提交；发生界面刷新错误：' + (error.message || String(error)), 'error');
      } else {
        setSimulationStatus('本轮未提交 · 时间未推进', 'error');
        say('系统错误', error.message || String(error));
        status((error.message || String(error)) + ' API Key只用于当前页面请求，不会写入存档。', 'error');
      }
    } finally {
      roundActive = false;
      setBusy(false);
      if (session) el('simClock').textContent = formatClock(session.world);
    }
  }

  function startExperiment() {
    if (busy) return;
    try { getSettings(); }
    catch (error) { status(error.message, 'error'); return; }
    const seed = Number(el('simSeed').value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) { status('随机种子必须是0至2147483647之间的整数。', 'error'); return; }
    if (session && !confirm('开始新实验分支会重置当前网页里的岛屿和身体演示状态。请确认是否重新开始。')) return;
    let body;
    try {
      if (!G.SITPBodyFramework) throw new Error('没有读取到 body-framework.js。');
      body = cloneJson(G.SITPBodyFramework);
      validateBodyFramework(body);
    } catch (error) { status(error.message, 'error'); return; }
    const position = G.IslandApp.getPosition();
    if (!M.inside(position)) { status('研究者当前选择在海面上，请先在地图陆地上选择一个位置。', 'error'); return; }
    const world = M.create(seed);
    world.selected = position.slice();
    M.validate(world);
    modelCalls = 0;
    visibleLines = 0;
    el('modelCallCount').textContent = '0';
    el('simRound').textContent = '0';
    el('simLog').replaceChildren();
    session = { seed, world, body, position: position.slice(), inventory: {}, round: 0, pendingAction: null };
    G.IslandApp.setWorldState(world, position);
    updateSurvivorMarker(position, true);
    lockResearchControls(true);
    el('simControls').hidden = false;
    setSimulationStatus('已开始 · 等待操作');
    status('实验已初始化。模型只在发送操作时调用；失败时保留同一回合输入并允许重试。', 'ok');
    el('simClock').textContent = formatClock(world);
    renderInventory();
    refreshOptions();
    updateActionFields();
    const weather = M.weather(world.hour, world.seed, position);
    const observation = M.observe(world, position);
    say('系统', '新实验分支已创建：种子 ' + seed + '；一个求生者；当前位置东 ' + position[0].toFixed(1) + ' 米、北 ' + position[1].toFixed(1) + ' 米。模拟时间只在双方处理成功后推进。');
    say('岛屿端', '初始环境：' + weather.temperature.toFixed(1) + '℃；' + weather.label + '；' + (observation.zone ? observation.zone.name : '岸缘') + '。\n' + observation.role);
    body.systems.forEach(system => say('身体端 · ' + system.system_id, system.statement));
    setBusy(false);
  }

  function endExperiment() {
    if (!session || busy) return;
    if (!confirm('结束后保留当前岛屿状态；本次页面里的身体框架状态不会写入岛屿存档。确定结束吗？')) return;
    session = null;
    el('simControls').hidden = true;
    lockResearchControls(false);
    updateSurvivorMarker(G.IslandApp.getPosition(), false);
    setSimulationStatus('已结束');
    el('simClock').textContent = '';
    renderInventory();
  }

  function randomSeed() {
    if (!G.crypto || !G.crypto.getRandomValues) { status('当前浏览器没有安全随机数功能，请手动输入种子。', 'error'); return; }
    const values = new Uint32Array(1);
    G.crypto.getRandomValues(values);
    el('simSeed').value = String(values[0] % 2147483648);
  }

  function updateSurvivorMarker(position, visible) {
    const marker = el('survivorMarker');
    if (!marker) return;
    marker.style.display = visible ? '' : 'none';
    if (visible) marker.setAttribute('transform', 'translate(' + position[0] + ',' + -position[1] + ')');
  }

  function refreshAfterIslandRender() {
    lockResearchControls(Boolean(session));
    if (session) refreshOptions();
  }

  el('discoverModels').addEventListener('click', discoverModels);
  el('aiApiKey').addEventListener('input', saveRememberedKey);
  el('aiApiKey').addEventListener('change', () => { if (el('aiApiKey').value.trim()) discoverModels(); });
  el('aiEndpoint').addEventListener('change', () => { if (el('aiApiKey').value.trim()) discoverModels(); });
  el('rememberApiKey').addEventListener('change', handleRememberKeyChange);
  el('aiModelChoices').addEventListener('change', event => { if (event.target.value) el('aiModelName').value = event.target.value; });
  el('randomSeed').addEventListener('click', randomSeed);
  el('startExperiment').addEventListener('click', startExperiment);
  el('endExperiment').addEventListener('click', endExperiment);
  el('actionKind').addEventListener('change', updateActionFields);
  el('collectSite').addEventListener('change', () => refreshResourceOptions());
  el('runAction').addEventListener('click', () => {
    if (!session || busy) return;
    try { performRound(currentAction()); }
    catch (error) { status(error.message, 'error'); say('输入错误', error.message); }
  });
  el('retryAction').addEventListener('click', () => { if (session && session.pendingAction && !busy) performRound(cloneJson(session.pendingAction)); });
  loadRememberedKey();
  if (el('aiApiKey').value.trim()) discoverModels();
  updateActionFields();
  G.SurvivalAgent = Object.freeze({ refreshAfterIslandRender });
  new MutationObserver(refreshAfterIslandRender).observe(el('nearby'), { childList: true });
})(globalThis);
