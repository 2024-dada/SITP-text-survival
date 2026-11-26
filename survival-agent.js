(function (G) {
  'use strict';

  const M = G.IslandModel;
  const R = G.SITPFrameworkRuntime;
  const el = id => document.getElementById(id);
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

  let session = null;
  let selectedFramework = null;
  let selectedFrameworkFile = '内置框架';
  let busy = false;
  let modelCalls = 0;
  let visibleLines = 0;
  let roundActive = false;
  let roundCalls = 0;
  let roundCallsLimit = 0;
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
    updateFrameworkControls();
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
    if (roundActive && roundCalls >= roundCallsLimit) throw new Error('本轮模型请求达到框架系统数对应的上限；岛屿和身体状态均未提交。');
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
    if (!R) throw new Error('没有读取到 framework-runtime.js。');
    return R.validate(frame);
  }

  function cloneJson(value) { return R.clone(value); }

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

  function applyFrameworkCommand(frame, commandLog, command) {
    R.applyLoggedCommand(frame, command);
    commandLog.push(cloneJson(command));
  }

  async function processBody(settings, frame, action, context) {
    const commandLog = [];
    applyFrameworkCommand(frame, commandLog, {
      type: 'set_framework_parameter', name: 'time_delta', value: action.durationMin
    });

    const external = frame.systems.find(system => system.system_id === 'external');
    if (external) {
      const parameters = cloneJson(external.parameters);
      for (const item of context.parameters) {
        const index = parameters.findIndex(parameter => parameter.param === item.param);
        if (index < 0) parameters.push({ param: item.param, value: item.value });
        else parameters[index].value = item.value;
      }
      applyFrameworkCommand(frame, commandLog, {
        type: 'replace_parameters', system_id: external.system_id, parameters
      });
      applyFrameworkCommand(frame, commandLog, {
        type: 'set_statement', system_id: external.system_id,
        statement: context.systemText
      });
    }

    const inputEvent = {
      event_description: '岛屿端本轮上下文（环境与动作事实；不是已经量化的人体变化）：' + context.actionDescription + ' ' + context.systemText,
      delta_parameters: []
    };
    for (const system of frame.systems) {
      applyFrameworkCommand(frame, commandLog, {
        type: 'append_event', system_id: system.system_id, event: inputEvent
      });
    }

    const inferenceStartedAt = performance.now();
    const inference = await R.forwardInference(
      frame,
      (messages, availableTools, choice) => requestCompletion(settings, messages, availableTools, choice),
      '网页实验约定：time_delta 与 time_clock 单位为分钟；每个系统只读取本轮开始时的状态快照。事件中的 delta_parameters 为空时只提供环境/动作事实，不代表量化的人体变化。只通过工具提交当前系统的修改；不得诊断疾病、决定死亡或把未由岛屿端提供的参数称为本岛实测。'
    );
    await honorRealTimeDelta(frame, inferenceStartedAt);
    frame.framework_param = inference.frame.framework_param;
    frame.systems = inference.frame.systems;
    commandLog.push(...inference.commandLog.map(cloneJson));
    R.validate(frame);
    return { results: inference.results, commandLog };
  }

  async function honorRealTimeDelta(frame, startedAt) {
    const minimumMs = frame.framework_param.real_time_delta * 1000;
    let remaining = minimumMs - (performance.now() - startedAt);
    while (remaining > 0) {
      setSimulationStatus('系统处理完成 · 等待现实节奏 · 模拟时间暂停');
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 1000)));
      remaining = minimumMs - (performance.now() - startedAt);
    }
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
    const systemText = '模拟时间 ' + startDate + ' 至 ' + endDate + '；位置东 ' + outcome.endPosition[0].toFixed(1) + ' 米、北 ' + outcome.endPosition[1].toFixed(1) + ' 米；海拔插值 ' + elevation.toFixed(1) + ' 米。' + actionDescription + ' 岛屿端未提供风速与空气湿度；若导入框架仍含相关数值，它们仅是该框架的实验设定，不是本岛实测。';
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
    roundCallsLimit = 1 + R.MAX_TOOL_ROUNDS * session.body.systems.length;
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
      const bodyResult = await processBody(settings, bodyStage, normalized, context);
      const results = bodyResult.results;
      M.validate(islandStage);
      if (!M.inside(outcome.endPosition)) throw new Error('岛屿裁决返回了海面坐标，拒绝提交。');
      G.IslandApp.setWorldState(islandStage, outcome.endPosition);
      session.world = islandStage;
      session.body = bodyStage;
      session.frameworkCommandLog.push(...bodyResult.commandLog.map(cloneJson));
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
      renderFramework();
      setSimulationStatus('回合已统一提交');
      say('岛屿端', outcomeText(normalized, outcome));
      for (const result of results) {
        const after = bodyStage.systems.find(system => system.system_id === result.systemId);
        const before = beforeBody.systems.find(system => system.system_id === result.systemId);
        const changes = changedParameters(before, after);
        const details = changes.length ? after.statement + '\n本轮参数：' + changes.join('；') : after.statement;
        say('身体端 · ' + result.systemId, details + (result.finalText ? '\n模型补充：' + result.finalText : ''));
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
      if (!R || !selectedFramework) throw new Error('没有读取到有效的推理框架。');
      body = R.normalize(selectedFramework);
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
    session = {
      seed, world, body, frameworkAnchor: cloneJson(body), frameworkCommandLog: [],
      position: position.slice(), inventory: {}, round: 0, pendingAction: null
    };
    G.IslandApp.setWorldState(world, position);
    updateSurvivorMarker(position, true);
    lockResearchControls(true);
    el('simControls').hidden = false;
    setSimulationStatus('已开始 · 等待操作');
    status('实验已初始化。模型只在发送操作时调用；失败时保留同一回合输入并允许重试。', 'ok');
    el('simClock').textContent = formatClock(world);
    renderInventory();
    renderFramework();
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
    renderFramework();
  }

  function setFrameworkStatus(text, kind) {
    const node = el('frameworkStatus');
    node.textContent = text;
    node.dataset.kind = kind || '';
  }

  function updateFrameworkControls() {
    const hasFrame = Boolean(session ? session.body : selectedFramework);
    const commandCount = session ? session.frameworkCommandLog.length : 0;
    el('frameworkFile').disabled = busy || Boolean(session);
    el('exportFramework').disabled = !hasFrame || busy;
    el('exportFrameworkLog').disabled = !session || busy;
    el('frameworkReplayIndex').disabled = !session || busy || commandCount === 0;
    el('exportReplaySnapshot').disabled = !session || busy;
    el('frameworkEditor').disabled = busy || Boolean(session);
    el('applyFrameworkEditor').disabled = busy || Boolean(session);
    const locked = busy || Boolean(session && session.pendingAction);
    el('frameworkClockEditors').querySelectorAll('input, button').forEach(control => { control.disabled = locked; });
  }

  function renderFrameworkClockEditors(frame) {
    const box = el('frameworkClockEditors');
    box.replaceChildren();
    if (!frame) return;
    for (const system of frame.systems) {
      const row = document.createElement('div');
      const label = document.createElement('label');
      const name = document.createElement('span');
      const input = document.createElement('input');
      const button = document.createElement('button');
      row.className = 'frameworkClockRow';
      name.textContent = system.system_id;
      input.type = 'number';
      input.step = 'any';
      input.value = String(system.time_clock);
      input.setAttribute('aria-label', system.system_id + ' time_clock');
      button.type = 'button';
      button.textContent = '设定';
      button.addEventListener('click', () => {
        const value = input.valueAsNumber;
        if (!Number.isFinite(value)) { setFrameworkStatus(system.system_id + ' 的 time_clock 必须是有限数值。', 'error'); return; }
        const command = { type: 'set_time_clock', system_id: system.system_id, value };
        const target = session ? session.body : selectedFramework;
        try {
          R.applyLoggedCommand(target, command);
          if (session) session.frameworkCommandLog.push(cloneJson(command));
          else selectedFramework = R.normalize(target);
          renderFramework();
          setFrameworkStatus(system.system_id + ' 的 time_clock 已设为 ' + value + '；该字段不会自动推进。', 'ok');
        } catch (error) {
          setFrameworkStatus('未能设定 time_clock：' + (error.message || String(error)), 'error');
        }
      });
      label.append(name, input);
      row.append(label, button);
      box.append(row);
    }
  }

  function renderFrameworkReplay() {
    if (!session) {
      el('frameworkReplayCount').textContent = '0 / 0';
      el('frameworkReplay').textContent = '开始实验后可按命令序号回放。';
      updateFrameworkControls();
      return;
    }
    const commands = session.frameworkCommandLog;
    const index = Math.max(0, Math.min(commands.length, Number(el('frameworkReplayIndex').value) || 0));
    try {
      const frame = R.replay(session.frameworkAnchor, commands, index);
      el('frameworkReplayCount').textContent = index + ' / ' + commands.length;
      el('frameworkReplay').textContent = JSON.stringify(frame, null, 2);
    } catch (error) {
      el('frameworkReplayCount').textContent = index + ' / ' + commands.length;
      el('frameworkReplay').textContent = '回放失败：' + (error.message || String(error));
    }
    updateFrameworkControls();
  }

  function renderFramework() {
    const frame = session ? session.body : selectedFramework;
    const source = session ? '本次实验' : selectedFrameworkFile;
    if (!frame) {
      el('frameworkSummary').textContent = '未加载';
      el('frameworkState').textContent = '没有有效框架。';
      renderFrameworkReplay();
      return;
    }
    el('frameworkSummary').textContent = frame.name + ' · ' + frame.systems.length + ' 个系统';
    el('frameworkState').textContent = JSON.stringify(frame, null, 2);
    el('frameworkEditor').value = JSON.stringify(frame, null, 2);
    renderFrameworkClockEditors(frame);
    const commands = session ? session.frameworkCommandLog : [];
    el('frameworkReplayIndex').max = String(commands.length);
    el('frameworkReplayIndex').value = String(commands.length);
    setFrameworkStatus(
      source + '：' + frame.systems.length + ' 个系统；仿真步长 ' + frame.framework_param.time_delta + '，现实等待参数 ' + frame.framework_param.real_time_delta + '。' +
      (session ? ' 已提交 ' + session.round + ' 个回合、记录 ' + commands.length + ' 条状态命令。' : ' 开始实验后每个系统将并行读取同一份回合起始状态。'),
      'ok'
    );
    renderFrameworkReplay();
  }

  function safeFilename(value) {
    return String(value || 'framework').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'framework';
  }

  function downloadJson(filename, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadFrameworkFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (session || busy) { setFrameworkStatus('请先结束当前实验，再更换推理框架。', 'error'); return; }
    if (file.size > 2 * 1024 * 1024) { setFrameworkStatus('框架文件超过2MB，请检查文件。', 'error'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      const frame = R.normalize(parsed);
      selectedFramework = frame;
      selectedFrameworkFile = file.name;
      renderFramework();
      setFrameworkStatus('已载入 ' + file.name + '：' + frame.systems.length + ' 个系统。rule 将作为模型系统提示发送。', 'ok');
    } catch (error) {
      setFrameworkStatus('框架未载入：' + (error.message || String(error)), 'error');
    }
  }

  function applyFrameworkEditor() {
    if (session || busy) { setFrameworkStatus('请先结束当前实验，再编辑推理框架。', 'error'); return; }
    try {
      const frame = R.normalize(JSON.parse(el('frameworkEditor').value));
      selectedFramework = frame;
      selectedFrameworkFile = '网页 JSON 编辑器';
      renderFramework();
      setFrameworkStatus('网页编辑的框架已应用：' + frame.systems.length + ' 个系统。', 'ok');
    } catch (error) {
      setFrameworkStatus('框架未应用：' + (error.message || String(error)), 'error');
    }
  }

  function exportFrameworkSnapshot() {
    const frame = session ? session.body : selectedFramework;
    if (!frame) return;
    downloadJson(safeFilename(frame.name) + '-snapshot.json', R.normalize(frame));
  }

  function exportFrameworkLog() {
    if (!session) return;
    downloadJson(safeFilename(session.body.name) + '-commands.json', {
      format: 'SITP-framework-command-log',
      version: 1,
      completed_rounds: session.round,
      initial_snapshot: session.frameworkAnchor,
      commands: session.frameworkCommandLog,
      current_snapshot: session.body
    });
  }

  function exportReplaySnapshot() {
    if (!session) return;
    const index = Number(el('frameworkReplayIndex').value) || 0;
    const frame = R.replay(session.frameworkAnchor, session.frameworkCommandLog, index);
    downloadJson(safeFilename(frame.name) + '-replay-' + index + '.json', frame);
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
  el('frameworkFile').addEventListener('change', loadFrameworkFile);
  el('applyFrameworkEditor').addEventListener('click', applyFrameworkEditor);
  el('exportFramework').addEventListener('click', exportFrameworkSnapshot);
  el('exportFrameworkLog').addEventListener('click', exportFrameworkLog);
  el('frameworkReplayIndex').addEventListener('input', renderFrameworkReplay);
  el('exportReplaySnapshot').addEventListener('click', exportReplaySnapshot);
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
  try {
    selectedFramework = R.normalize(G.SITPBodyFramework);
  } catch (error) {
    selectedFramework = null;
    setFrameworkStatus('内置框架不可用：' + (error.message || String(error)), 'error');
  }
  renderFramework();
  loadRememberedKey();
  if (el('aiApiKey').value.trim()) discoverModels();
  updateActionFields();
  G.SurvivalAgent = Object.freeze({ refreshAfterIslandRender });
  new MutationObserver(refreshAfterIslandRender).observe(el('nearby'), { childList: true });
})(globalThis);
