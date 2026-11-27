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
  const MAX_COMPLETION_TOKENS = 1800;
  const CONTINUATION_COMPLETION_TOKENS = 1200;
  const MAX_CONTINUATION_TAIL_CHARS = 1400;
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
  let interactionSession = null;
  let selectedFramework = null;
  let selectedFrameworkFile = '未载入岛屿 JSON';
  let busy = false;
  let modelCalls = 0;
  let visibleLines = 0;
  let roundActive = false;
  let roundCalls = 0;
  let roundResponseLedger = new Map();
  let agentToolDialogueTurns = 0;
  const agentToolDialogueBySystem = new Map();
  let lastAgentRoundNumber = 0;
  let lastAgentRoundState = '等待首次运行';
  let lastAgentRoundError = '';
  let lastAgentRoundResults = [];
  const apiKeyStorageName = 'olorua.sitp.model-api-key';
  const apiBaseUrlStorageName = 'olorua.sitp.model-api-base-url';
  const apiModelStorageName = 'olorua.sitp.model-api-model';
  const apiProviderStorageName = 'olorua.sitp.model-api-preset';

  const survivorAgentRule = '你是本次实验中的求生者 agent。只依据已经提供的文字、事件和自身状态交流，不补造岛屿参数、生理数值或事实。你只能修改当前 system 自己的 parameters、statement、events 和 time_clock；每项状态修改都必须说明 reason。time_clock 只是你自己的标注，不会推进岛屿模拟时钟。可用 send_message 定向给一个或多个 agent，收件人表示希望谁回应；网页会保存完整对话，但下一轮发给模型的历史内容受长度上限约束，过长时只发送最近部分。每轮所有 agent 并行处理同一份开始状态，不能看到同轮其他 agent 的结果。请简洁回答并避免重复已有状态；工具调用每次只提交少量且必要的内容，长任务可以继续分轮完成，不要一次生成很长的工具参数。';

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
    emitMonitorUpdate();
  }

  function emitMonitorUpdate() {
    document.dispatchEvent(new Event('sitp:monitor-update'));
  }

  function saveRememberedKey() {
    if (!el('rememberApiKey').checked) return;
    const key = el('aiApiKey').value.trim();
    try {
      if (key) localStorage.setItem(apiKeyStorageName, key);
      else localStorage.removeItem(apiKeyStorageName);
      saveRememberedConnection();
    } catch {
      el('rememberApiKey').checked = false;
      status('浏览器不允许保存本机密钥；本次仍可在当前页面使用。', 'error');
    }
  }

  function saveRememberedConnection() {
    if (!el('rememberApiKey').checked) return;
    try {
      const baseUrl = el('aiBaseUrl').value.trim();
      const model = el('aiModelName').value.trim();
      const provider = el('tongjiProvider').checked ? 'tongji' : el('aiProvider').value;
      localStorage.setItem(apiProviderStorageName, provider);
      if (baseUrl) localStorage.setItem(apiBaseUrlStorageName, baseUrl);
      else localStorage.removeItem(apiBaseUrlStorageName);
      if (model) localStorage.setItem(apiModelStorageName, model);
      else localStorage.removeItem(apiModelStorageName);
    } catch {
      // Connection details are optional; the key can still be used in this session.
    }
  }

  function handleRememberKeyChange() {
    if (el('rememberApiKey').checked) { saveRememberedKey(); return; }
    try {
      localStorage.removeItem(apiKeyStorageName);
      localStorage.removeItem(apiBaseUrlStorageName);
      localStorage.removeItem(apiModelStorageName);
      localStorage.removeItem(apiProviderStorageName);
    }
    catch { status('无法删除浏览器中已保存的Key；请在浏览器站点设置中清除此网页数据。', 'error'); }
  }

  function loadRememberedKey() {
    try {
      const key = localStorage.getItem(apiKeyStorageName);
      if (key) {
        el('aiApiKey').value = key;
        el('aiBaseUrl').value = localStorage.getItem(apiBaseUrlStorageName) || '';
        el('aiModelName').value = localStorage.getItem(apiModelStorageName) || '';
        const preset = localStorage.getItem(apiProviderStorageName);
        if (preset === 'tongji') el('tongjiProvider').checked = true;
        else if ([...el('aiProvider').options].some(option => option.value === preset)) el('aiProvider').value = preset;
        el('rememberApiKey').checked = true;
      }
      localStorage.removeItem('olorua.sitp.model-api-provider');
      updateConnectionStatus();
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
    el('runAction').disabled = true;
    el('retryAction').disabled = true;
    el('retryAction').hidden = true;
    document.querySelectorAll('.actionComposer select, #startExperiment, #randomSeed').forEach(input => { input.disabled = true; });
    document.querySelectorAll('.aiSettingsGrid input, .aiSettingsGrid select, #discoverModels').forEach(input => { input.disabled = value; });
    el('endExperiment').disabled = true;
    updateFrameworkControls();
    updateAgentInteractionControls();
  }

  function updateAgentInteractionControls() {
    const active = Boolean(interactionSession);
    const pending = active && interactionSession.retryPrompt !== null;
    const showRetry = pending && !busy;
    const loaded = Boolean(selectedFramework && selectedFrameworkFile !== '未载入岛屿 JSON' && selectedFrameworkFile !== '内置框架');
    el('runAgentRound').disabled = busy || Boolean(session) || (!active && !loaded) || pending;
    el('runAgentRound').textContent = active ? '运行第 ' + (interactionSession.round + 1) + ' 轮' : '运行第一轮';
    el('retryAgentRound').hidden = !showRetry;
    el('retryAgentRound').disabled = busy;
    el('endAgentInteraction').disabled = busy || !active;
    el('agentRoundPrompt').disabled = busy || pending || Boolean(session);
  }

  function setAgentStatus(text, kind) {
    const node = el('agentInteractionStatus');
    node.textContent = text;
    node.dataset.kind = kind || '';
    emitMonitorUpdate();
  }

  function interactionAgentIds(frame) {
    const ids = frame ? frame.systems.map(system => system.system_id) : [];
    if (frame && !ids.includes('survivor_agent')) ids.unshift('survivor_agent');
    return ids;
  }

  function renderAgentRoster(frame) {
    const list = el('agentRosterList');
    const count = el('agentRosterCount');
    list.replaceChildren();
    if (!frame) {
      count.textContent = '等待载入';
      const empty = document.createElement('span');
      empty.className = 'agentRosterEmpty';
      empty.textContent = '载入参数框架后自动启用全体 Agent';
      list.append(empty);
      return;
    }
    const ids = interactionAgentIds(frame);
    count.textContent = '全员启用 · ' + ids.length + ' 个';
    for (const id of ids) {
      const tag = document.createElement('span');
      tag.className = 'agentRosterTag';
      tag.textContent = displayAgentName(id);
      list.append(tag);
    }
  }

  function keepIslandObserverReadOnly() {
    document.querySelectorAll('#startExperiment, #endExperiment, #randomSeed, #runAction, #retryAction, #play, [data-step], #nextRain, #collector, #save, #load, #reset, #nearby button').forEach(control => { control.disabled = true; });
  }

  function lockResearchControls(locked) {
    document.querySelectorAll('#play, [data-step], #nextRain, #collector, #reset, #save, #load, #nearby button').forEach(control => { control.disabled = locked; });
    el('endExperiment').hidden = !locked;
  }

  async function fetchWithTimeout(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      return await fetch(url, { ...options, signal: controller.signal, mode: 'cors', credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      const roundNote = label === '模型调用' ? '此轮状态没有提交；可以重试同一轮。' : '可以稍后重试。';
      if (error.name === 'AbortError') throw new Error(label + '等待超过90秒，' + roundNote);
      throw new Error(label + '网络连接失败。请检查网络和服务商跨域设置；' + roundNote + '浏览器提示：' + error.message);
    } finally {
      clearTimeout(timer);
    }
  }

  function classifyApiError(statusCode, data, rawText, apiKey, label) {
    let detail = '';
    if (data && data.error) {
      const error = data.error;
      detail = [error.code, error.type, error.message].filter(value => typeof value === 'string').join(' ');
    }
    if (!detail && data && typeof data.message === 'string') detail = data.message;
    if (!detail) detail = rawText || '';
    if (apiKey) detail = String(detail).split(apiKey).join('[已隐藏密钥]');
    const lower = detail.toLowerCase();
    const code = data && data.error && typeof data.error.code === 'string' ? data.error.code.toLowerCase() : '';
    const modelFailure = /model_not_found|unknown_model|invalid_model|model_not_available/.test(code)
      || (/model/.test(lower) && /not found|does not exist|unknown|invalid|unavailable|not available|unsupported/.test(lower));
    const contextFailure = /maximum context length|context length.{0,24}(exceed|limit)|context window.{0,24}(exceed|limit)|prompt is too long|request too large|input.{0,24}token.{0,24}(limit|maximum)/.test(lower);
    const balanceFailure = /insufficient_quota|insufficient_balance|billing_hard_limit|payment_required/.test(code)
      || /insufficient[_ ](quota|balance)|quota (is )?exceeded|balance (is )?(insufficient|low)|out of credits|billing/.test(lower);
    let reason;
    if (statusCode === 401) reason = 'API Key 无效、已过期或未被服务接受。';
    else if (statusCode === 402 || balanceFailure) reason = '账户余额不足或可用额度已用完。';
    else if (statusCode === 403) reason = 'Key 已被服务识别，但没有调用此接口或模型的权限。';
    else if (modelFailure) reason = '模型名称错误，或此 Key 没有该模型的使用权限。';
    else if (contextFailure) reason = '本次输入超过模型上下文长度；请缩短本轮任务或减少载入的规则内容。';
    else if (statusCode === 404 && label === '模型列表读取') reason = '模型列表接口不可用或 Base URL 路径错误；若服务商文档不提供 /models，请手动填写模型名称后运行一轮。';
    else if (statusCode === 404) reason = '接口地址错误或服务商没有提供该接口；请核对官方 Base URL。';
    else if (statusCode === 429) reason = '请求过于频繁或并发已达限制；请稍后重试。';
    else if (statusCode === 400) reason = '服务商拒绝了请求；请检查模型名、请求格式和接口文档。';
    else if (statusCode >= 500) reason = '服务商接口暂时不可用（HTTP ' + statusCode + '）。';
    else reason = '服务请求失败（HTTP ' + statusCode + '）。';
    const safeDetail = String(detail).replace(/[\r\n\t]+/g, ' ').slice(0, 260);
    return label + '失败：' + reason + (safeDetail ? ' 服务商说明：' + safeDetail : '');
  }

  async function responseJson(response, apiKey, label) {
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* Non-JSON gateway errors are classified by HTTP status below. */ }
    if (!response.ok) throw new Error(classifyApiError(response.status, data, data ? raw : '', apiKey, label));
    if (!data) throw new Error(label + '成功连接，但服务返回的不是 JSON。请确认服务商接口协议。');
    return data;
  }

  function recordAgentResponse(systemId, content, finishReason, segmentType) {
    if (!roundActive || !systemId || typeof content !== 'string') return;
    if (!roundResponseLedger.has(systemId)) roundResponseLedger.set(systemId, []);
    roundResponseLedger.get(systemId).push({ content, finishReason: finishReason || '', segmentType: segmentType || '回复' });
  }

  function updateAgentToolDialogueCounter() {
    const counter = el('agentToolTurnCount');
    if (!counter) return;
    counter.textContent = '工具对话 ' + agentToolDialogueTurns + ' 轮';
    counter.setAttribute('aria-label', '本次会话累计 Agent 工具对话 ' + agentToolDialogueTurns + ' 轮');
    const breakdown = [...agentToolDialogueBySystem.entries()].map(([systemId, count]) => displayAgentName(systemId) + '：' + count + '轮');
    counter.title = breakdown.length ? breakdown.join('\n') : '各 Agent 的累计工具对话轮数';
  }

  function recordAgentToolDialogueTurn(systemId) {
    agentToolDialogueTurns += 1;
    agentToolDialogueBySystem.set(systemId, (agentToolDialogueBySystem.get(systemId) || 0) + 1);
    updateAgentToolDialogueCounter();
  }

  function responseContextExcerpt(messages) {
    const candidates = messages.filter(message => ['system', 'user'].includes(message.role) && typeof message.content === 'string').slice(-4);
    let remaining = 5200;
    const excerpts = [];
    for (const message of candidates) {
      if (remaining <= 0) break;
      const label = message.role === 'system' ? '规则' : '本轮输入';
      const allowance = Math.min(message.content.length, message.role === 'system' ? 1800 : 1700, remaining - 24);
      if (allowance <= 0) continue;
      const marker = message.content.length > allowance ? '\n…上下文节选…\n' : '';
      const body = message.content.length > allowance
        ? message.content.slice(0, Math.ceil((allowance - marker.length) * 0.65)) + marker + message.content.slice(-(allowance - marker.length - Math.ceil((allowance - marker.length) * 0.65)))
        : message.content;
      excerpts.push(label + '：\n' + body);
      remaining -= body.length + label.length + 2;
    }
    return excerpts.join('\n\n');
  }

  function exactOverlapLength(existing, next) {
    const maximum = Math.min(500, existing.length, next.length);
    for (let length = maximum; length >= 24; length -= 1) {
      if (existing.slice(-length) === next.slice(0, length)) return length;
    }
    return 0;
  }

  async function requestCompletion(settings, messages, tools, choice, systemId) {
    const contextExcerpt = responseContextExcerpt(messages);
    const responseSegments = [];
    let continuationCount = 0;
    let accumulated = '';

    async function send(requestMessages, requestTools, requestChoice, maxTokens) {
      if (roundActive) roundCalls += 1;
      modelCalls += 1;
      el('modelCallCount').textContent = String(modelCalls);
      el('agentModelCallCount').textContent = '模型请求 ' + modelCalls;
      emitMonitorUpdate();
      const payload = {
        model: settings.model, messages: requestMessages, max_tokens: maxTokens, stream: false
      };
      if (requestTools && requestTools.length) payload.tools = requestTools;
      if (requestChoice) payload.tool_choice = requestChoice;
      const response = await fetchWithTimeout(settings.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
        body: JSON.stringify(payload)
      }, '模型调用');
      const data = await responseJson(response, settings.apiKey, '模型调用');
      const message = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!message || typeof message !== 'object') throw new Error('模型响应中没有 choices[0].message，无法完成本轮。');
      return { message, finishReason: data.choices[0].finish_reason || '' };
    }

    let current = await send(messages, tools, choice, MAX_COMPLETION_TOKENS);
    const firstToolCalls = Array.isArray(current.message.tool_calls) ? current.message.tool_calls : [];
    const firstOutput = [
      typeof current.message.content === 'string' ? current.message.content : '',
      firstToolCalls.length ? '工具调用：\n' + JSON.stringify(firstToolCalls, null, 2) : ''
    ].filter(Boolean).join('\n\n');
    if (firstOutput) recordAgentResponse(systemId, firstOutput, current.finishReason, '模型回复');
    if (typeof current.message.content === 'string' && current.message.content) {
      accumulated = current.message.content;
      responseSegments.push(accumulated);
    }

    if (current.finishReason === 'length') {
      if (Array.isArray(current.message.tool_calls) && current.message.tool_calls.length) {
        throw new Error('模型在工具调用内容尚未完整时达到单次输出上限；该段原文已保存在本轮失败记录中。请缩短本轮任务或精简该系统规则后重试。');
      }
      while (current.finishReason === 'length') {
        continuationCount += 1;
        const tail = accumulated.slice(-MAX_CONTINUATION_TAIL_CHARS);
        const continuationMessages = [
          { role: 'system', content: '你正在续写一个被单次输出上限截断的回答。遵守给定规则与本轮任务，只续写尚未完成的后续内容，不重复已写内容；保持原语言、格式和结论。' },
          { role: 'user', content: [
            contextExcerpt ? '原始规则和本轮输入节选：\n' + contextExcerpt : '',
            '已生成回答末尾（仅用于衔接）：\n' + tail,
            '请直接从截断处继续；不要重新开头或复述。'
          ].filter(Boolean).join('\n\n') }
        ];
        current = await send(continuationMessages, null, null, CONTINUATION_COMPLETION_TOKENS);
        const next = typeof current.message.content === 'string' ? current.message.content : '';
        recordAgentResponse(systemId, next, current.finishReason, '续写 ' + continuationCount);
        if (next) {
          const overlap = exactOverlapLength(accumulated, next);
          const addition = next.slice(overlap);
          accumulated += addition;
          responseSegments.push(addition);
        }
        if (current.message.tool_calls && current.message.tool_calls.length) {
          throw new Error('模型续写时返回了工具调用，无法安全拼接文本；已保留此前生成的分段。请缩短本轮任务后重试。');
        }
        if (!next || !next.trim()) throw new Error('模型续写请求没有返回文本；此前已生成内容已保存在本轮失败记录中。');
      }
      current.message.content = accumulated;
      current.message._responseSegments = responseSegments.slice();
    } else {
      current.message._responseSegments = responseSegments.slice();
    }
    return current.message;
  }

  function normalizeBaseUrl(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) throw new Error('请填写服务商官方文档提供的 Base URL。');
    let url;
    try { url = new URL(raw); } catch { throw new Error('Base URL 格式无效；请填写完整的 http:// 或 https:// 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 只支持 http:// 或 https:// 地址。');
    if (url.username || url.password) throw new Error('Base URL 不应包含用户名或密码；请只使用服务商文档提供的接口地址。');
    if (url.search || url.hash) throw new Error('Base URL 不应包含查询参数或片段；请核对服务商文档。');
    url.pathname = url.pathname.replace(/\/+$/g, '');
    return url;
  }

  function chatCompletionsEndpoint(rawBaseUrl) {
    const url = normalizeBaseUrl(rawBaseUrl);
    if (!/\/chat\/completions$/i.test(url.pathname)) {
      const basePath = url.pathname === '/' ? '' : url.pathname;
      url.pathname = basePath + '/chat/completions';
    }
    return url.href;
  }

  const providerPresets = {
    modelgo: { name: 'ModelGo', url: 'https://api.modelgo.ai/v1', pattern: /^mgk_\S+$/ },
    openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', pattern: /^sk-or-v1-\S+$/ },
    groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1', pattern: /^gsk_\S+$/ },
    openai: { name: 'OpenAI', url: 'https://api.openai.com/v1' },
    deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com' },
    tongji: { name: '同济大学 AGI', url: 'https://agi.tongji.edu.cn/v1' }
  };
  let modelDiscoveryTimer;
  function detectedProvider(key) { return Object.values(providerPresets).find(provider => provider.pattern && provider.pattern.test(key)); }
  function chosenProvider(key) {
    const choice = el('tongjiProvider').checked ? 'tongji' : el('aiProvider').value;
    return choice === 'auto' ? detectedProvider(key) : providerPresets[choice];
  }

  function prepareAutomaticConnection(keyChanged = false, providerChanged = false) {
    clearTimeout(modelDiscoveryTimer);
    const key = el('aiApiKey').value.trim();
    const provider = chosenProvider(key);
    if (keyChanged || providerChanged) {
      el('aiModelName').value = '';
      if (provider) el('aiBaseUrl').value = provider.url;
      else if (el('aiProvider').value === 'auto' || providerChanged) el('aiBaseUrl').value = '';
    } else if (provider && !el('aiBaseUrl').value.trim()) {
      el('aiBaseUrl').value = provider.url;
    }
    saveRememberedConnection();
    updateConnectionStatus();
    if (key && provider && el('aiBaseUrl').value.trim() === provider.url) {
      modelDiscoveryTimer = setTimeout(discoverModels, 900);
    }
  }

  function resolveConnection() {
    const key = el('aiApiKey').value.trim();
    const baseUrl = el('aiBaseUrl').value.trim();
    if (!key) {
      el('providerStatus').textContent = '请填写非空 API Key；不限制 Key 前缀或长度。';
      emitMonitorUpdate();
      return null;
    }
    if (!baseUrl) {
      el('providerStatus').textContent = el('tongjiProvider').checked
        ? '已选择同济大学 AGI；请检查官方 Base URL。'
        : 'Key 前缀无法唯一识别服务商；请选择服务商，或填写官方 Base URL。';
      emitMonitorUpdate();
      return null;
    }
    try {
      const endpoint = chatCompletionsEndpoint(baseUrl);
      const host = new URL(endpoint).host;
      const preset = chosenProvider(key);
      const provider = preset && baseUrl === preset.url ? preset.name : host;
      el('providerStatus').textContent = provider + ' · ' + host + ' · Key 仅发送到此主机。';
      emitMonitorUpdate();
      return { provider, endpoint };
    } catch (error) {
      el('providerStatus').textContent = error.message || String(error);
      emitMonitorUpdate();
      return null;
    }
  }

  function updateConnectionStatus() {
    clearTimeout(modelDiscoveryTimer);
    modelQuery += 1;
    el('aiModelChoices').replaceChildren(new Option('请测试此地址或手动填写模型名', ''));
    resolveConnection();
    updateBalanceAvailability();
    emitMonitorUpdate();
  }

  function getConnection() {
    const apiKey = el('aiApiKey').value.trim();
    if (!apiKey) throw new Error('请填写非空 API Key。');
    el('aiApiKey').value = apiKey;
    const resolved = resolveConnection();
    if (!resolved) throw new Error(el('providerStatus').textContent);
    return { apiKey, ...resolved };
  }

  function getSettings() {
    const connection = getConnection();
    const model = el('aiModelName').value.trim();
    if (!model) throw new Error('请填写服务商提供的模型名称，或先测试连接并读取模型列表。');
    el('aiModelName').value = model;
    return { ...connection, model };
  }

  function modelsEndpoint(chatEndpoint) {
    const url = new URL(chatEndpoint);
    if (!/\/chat\/completions$/i.test(url.pathname)) throw new Error('无法从 Base URL 生成模型列表地址。');
    url.pathname = url.pathname.replace(/\/chat\/completions$/i, '/models');
    return url.href;
  }

  let balanceQuery = 0;
  let modelQuery = 0;
  function updateBalanceAvailability() {
    balanceQuery += 1;
    const baseUrl = el('aiBaseUrl').value.trim();
    let supported = false;
    if (baseUrl) {
      try { supported = normalizeBaseUrl(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'; }
      catch { supported = false; }
    }
    el('apiBalance').textContent = supported
      ? '仅查询 DeepSeek 官方 API 余额；点击“刷新 API 余额”手动查询。'
      : '当前 Base URL 不支持余额查询；仅支持 DeepSeek 官方 API。';
  }

  async function refreshBalance() {
    const query = ++balanceQuery;
    const output = el('apiBalance');
    const button = el('refreshBalance');
    output.textContent = '正在查询余额…';
    button.disabled = true;
    emitMonitorUpdate();
    try {
      const settings = getConnection();
      const endpoint = new URL(settings.endpoint);
      if (endpoint.hostname !== 'api.deepseek.com') throw new Error('当前服务暂不支持余额查询；目前支持 DeepSeek 官方 API。');
      const response = await fetchWithTimeout(new URL('/user/balance', endpoint).href, {
        method: 'GET', headers: { Authorization: 'Bearer ' + settings.apiKey }
      }, '余额查询');
      const data = await responseJson(response, settings.apiKey, '余额查询');
      if (!Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new Error('服务未返回余额信息。');
      if (query !== balanceQuery) return;
      output.textContent = data.balance_infos.map(item => item.currency + ' ' + item.total_balance + '（赠送 ' + item.granted_balance + '，充值 ' + item.topped_up_balance + '）').join('；') + (data.is_available ? ' · 可用' : ' · 余额不足') + ' · ' + new Date().toLocaleTimeString();
    } catch (error) {
      if (query === balanceQuery) output.textContent = error.message;
    } finally {
      if (query === balanceQuery) {
        button.disabled = false;
        emitMonitorUpdate();
      }
    }
  }

  async function discoverModels() {
    clearTimeout(modelDiscoveryTimer);
    if (busy) return;
    const query = ++modelQuery;
    const select = el('aiModelChoices');
    select.replaceChildren(new Option('正在获取模型…', ''));
    emitMonitorUpdate();
    try {
      const settings = getConnection();
      status('正在读取模型列表……');
      el('providerStatus').textContent = '正在请求 ' + settings.provider + ' 的 OpenAI 兼容模型列表接口。';
      const response = await fetchWithTimeout(modelsEndpoint(settings.endpoint), {
        method: 'GET', headers: { Authorization: 'Bearer ' + settings.apiKey }
      }, '模型列表读取');
      const data = await responseJson(response, settings.apiKey, '模型列表读取');
      if (query !== modelQuery) return;
      if (!Array.isArray(data.data)) throw new Error('返回格式里没有模型列表字段 data。请手动输入模型名。');
      select.replaceChildren(new Option('请选择模型', ''));
      data.data.forEach(item => {
        if (typeof item.id !== 'string' || !item.id) return;
        select.append(new Option(item.name ? item.name + '（' + item.id + '）' : item.id, item.id));
      });
      if (select.options.length > 1) {
        const preferred = [...select.options].find(option => option.value === el('aiModelName').value) || select.options[1];
        select.value = preferred.value;
        if (!el('aiModelName').value.trim()) el('aiModelName').value = preferred.value;
        saveRememberedConnection();
        el('providerStatus').textContent = '已连接 ' + settings.provider + ' · 读取到 ' + (select.options.length - 1) + ' 个模型';
      }
      status('读到 ' + (select.options.length - 1) + ' 个模型。列表不代表当前 Key 一定有调用权限。', 'ok');
    } catch (error) {
      if (query !== modelQuery) return;
      el('providerStatus').textContent = error.message || String(error);
      select.replaceChildren(new Option('未获取到模型，可手动填写', ''));
      status(error.message + ' 仍可手动填写模型名。', 'error');
    } finally {
      emitMonitorUpdate();
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
      (messages, availableTools, choice, systemId) => requestCompletion(settings, messages, availableTools, choice, systemId),
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

  function interactionFrame() {
    if (!selectedFramework || selectedFrameworkFile === '未载入岛屿 JSON' || selectedFrameworkFile === '内置框架') {
      throw new Error('默认参考框架未能载入；请检查网站附带 JSON，或在右侧观测栏手动载入 Olorua systems。');
    }
    if (session) throw new Error('旧版单人实验仍在运行；请先结束它再开始 Agent 交互。');
    const frame = R.normalize(selectedFramework);
    if (frame.systems.some(system => system.system_id === 'survivor_agent')) {
      throw new Error('岛屿 JSON 已使用保留的 system_id “survivor_agent”；请调整该 ID 后再载入。');
    }
    if (frame.systems.length + 1 > R.MAX_SYSTEMS) {
      throw new Error('岛屿 JSON 有 ' + frame.systems.length + ' 个系统；接入求生者 agent 后最多支持 ' + (R.MAX_SYSTEMS - 1) + ' 个岛屿系统。');
    }
    frame.name += ' · Agent 交互';
    frame.systems.unshift({
      // The schema requires a number; this local annotation is not island time or a body parameter.
      system_id: 'survivor_agent', rule: survivorAgentRule, time_clock: 0,
      parameters: [],
      statement: '尚无身体组状态配置；依据当前可见文本参与对话，不补造生理参数。',
      events: []
    });
    R.validate(frame);
    return frame;
  }

  function displayAgentName(systemId) {
    const labels = {
      survivor_agent: '求生者 Agent',
      A_geography_observation: 'A · 地理与空间观测 Agent',
      B_time_weather: 'B · 时间与天气 Agent',
      C_resources_ecology: 'C · 资源、水账与生态 Agent'
    };
    return labels[systemId] || String(systemId);
  }

  function auditValue(value) {
    if (value === null || value === undefined) return '（无）';
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  function changeText(command) {
    const change = command.change;
    return change.field + '：' + auditValue(change.before) + ' → ' + auditValue(change.after) + '；原因：' + change.reason;
  }

  function appendAgentMessage(container, sender, text, label, kind) {
    const article = document.createElement('article');
    const head = document.createElement('div');
    const name = document.createElement('strong');
    const tag = document.createElement('span');
    const body = document.createElement('p');
    article.className = 'agentMessage' + (kind ? ' agentMessage-' + kind : '');
    head.className = 'agentMessageHead';
    name.textContent = sender;
    tag.textContent = label || '';
    body.textContent = text;
    head.append(name, tag);
    article.append(head, body);
    container.append(article);
  }

  function appendAgentRound(roundNumber, researcherPrompt, inference) {
    const block = document.createElement('section');
    const heading = document.createElement('h3');
    const transcript = document.createElement('div');
    block.className = 'agentRoundBlock';
    heading.className = 'agentRoundHeading';
    heading.textContent = '第 ' + roundNumber + ' 轮 · ' + inference.results.length + ' 个 agent 并行';
    transcript.className = 'agentRoundMessages';
    block.append(heading, transcript);
    if (researcherPrompt) appendAgentMessage(transcript, '研究者', researcherPrompt, '全体 Agent 参与 · 对全体可见', 'researcher');
    for (const result of inference.results) {
      const speaker = displayAgentName(result.systemId);
      appendAgentMessage(transcript, speaker, result.finalText || '（本轮没有补充文本发言）', '公开发言', 'agent');
      const responseRecords = roundResponseLedger.get(result.systemId) || [];
      if (responseRecords.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const pre = document.createElement('pre');
        details.className = 'agentToolDetails';
        summary.textContent = '查看逐次模型返回（含工具调用、续写/重试，共 ' + responseRecords.length + ' 次）';
        pre.textContent = responseRecords.map((item, index) => '第 ' + (index + 1) + ' 次 · ' + item.segmentType + (item.finishReason ? ' · ' + item.finishReason : '') + '\n' + item.content).join('\n\n');
        details.append(summary, pre);
        transcript.append(details);
      }
      for (const message of inference.messages.filter(item => item.sender === result.systemId)) {
        if (message.kind !== 'directed') continue;
        const recipients = message.recipients.map(displayAgentName).join('、');
        appendAgentMessage(transcript, speaker, message.text, '希望 ' + recipients + ' 回应 · 全体可见', 'directed');
      }
      const changes = inference.commandLog.filter(command => command.system_id === result.systemId && command.change);
      for (const command of changes) appendAgentMessage(transcript, speaker, changeText(command), '自身状态变化', 'change');
      if (result.toolTrace.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const pre = document.createElement('pre');
        details.className = 'agentToolDetails';
        summary.textContent = '查看工具调用与结果（' + result.toolTrace.length + '）';
        pre.textContent = JSON.stringify(result.toolTrace, null, 2);
        details.append(summary, pre);
        transcript.append(details);
      }
    }
    el('agentTranscript').querySelector('.emptyLog')?.remove();
    el('agentTranscript').append(block);
    el('agentTranscript').scrollTop = el('agentTranscript').scrollHeight;
  }

  function messagesForNextRound(researcherPrompt, researcherRecipients, inference) {
    const messages = [];
    if (researcherPrompt) messages.push({ kind: 'researcher', sender: '研究者', recipients: researcherRecipients, text: researcherPrompt });
    for (const result of inference.results) {
      if (result.finalText) messages.push({ kind: 'speech', sender: result.systemId, text: result.finalText });
      for (const message of inference.messages.filter(item => item.sender === result.systemId && item.kind === 'directed')) {
        messages.push({ kind: 'directed', sender: message.sender, recipients: message.recipients, text: message.text });
      }
      for (const command of inference.commandLog.filter(item => item.system_id === result.systemId && item.change)) {
        messages.push({ kind: 'state_change', sender: command.system_id, ...command.change });
      }
    }
    return messages;
  }

  function formatResponseLedger() {
    if (!roundResponseLedger.size) return '';
    return '\n\n本地已暂存的模型返回（逐次请求原文；续写已逐段追加）：\n' + [...roundResponseLedger.entries()].map(([systemId, records]) =>
      displayAgentName(systemId) + ' · ' + records.length + ' 次\n' + records.map((item, index) => '第 ' + (index + 1) + ' 次 · ' + item.segmentType + (item.finishReason ? ' · ' + item.finishReason : '') + '\n' + item.content).join('\n\n')
    ).join('\n\n');
  }

  async function runAgentInteractionRound(retry) {
    if (busy || session) return;
    let settings;
    try { settings = getSettings(); }
    catch (error) { status(error.message, 'error'); setAgentStatus('先检查模型连接设置', 'error'); return; }
    const existing = interactionSession;
    const researcherPrompt = retry && existing ? existing.retryPrompt : el('agentRoundPrompt').value.trim();
    try {
      if (!interactionSession) {
        const frame = interactionFrame();
        interactionSession = {
          frame, frameworkAnchor: cloneJson(frame), frameworkCommandLog: [], round: 0,
          previousRoundMessages: [], retryPrompt: null, retryRecipients: []
        };
        modelCalls = 0;
        agentToolDialogueTurns = 0;
        agentToolDialogueBySystem.clear();
        updateAgentToolDialogueCounter();
        el('modelCallCount').textContent = '0';
        el('agentModelCallCount').textContent = '模型请求 0';
        el('agentTranscript').replaceChildren();
        renderFramework();
      }
    } catch (error) {
      status(error.message, 'error');
      setAgentStatus(error.message, 'error');
      return;
    }
    const active = interactionSession;
    const researcherRecipients = retry && existing ? existing.retryRecipients : interactionAgentIds(active.frame);
    if (active.retryPrompt !== null && !retry) return;
    if (!retry) {
      active.retryPrompt = researcherPrompt;
      active.retryRecipients = researcherRecipients;
    }
    setBusy(true);
    roundActive = true;
    roundCalls = 0;
    if (!retry) roundResponseLedger = new Map();
    const roundNumber = active.round + 1;
    lastAgentRoundState = '第 ' + roundNumber + ' 轮并行推理中';
    lastAgentRoundError = '';
    setAgentStatus('第 ' + roundNumber + ' 轮并行推理中', '');
    el('agentFailurePanel').hidden = true;
    try {
      const inference = await R.forwardInference(
        active.frame,
        (messages, availableTools, choice, systemId) => requestCompletion(settings, messages, availableTools, choice, systemId),
        'Agent 交互约定：当前 system_id 是你的身份。所有已载入 agent 每轮都必须参与，并从相同回合起始快照并行推理；本轮互相看不到对方正在生成的内容。研究者的问题发送给全体 agent。所有 agent 可以读取其他系统，但只能修改自己 system 的参数、statement、事件队列和 time_clock。每项修改必须通过工具提交并附真实理由。不要通过研究者任务或历史消息绕过这些限制。send_message 可定向给一个或多个系统，表示希望谁回应；网页保存完整上一轮对话，但下一轮发给模型的历史内容最多 8000 字符，超过时只发送最近内容。请优先简洁回答；工具参数只保留完成研究任务所需的字段和说明，避免重复复述已有状态。为降低工具调用内容被单次输出上限截断的概率，每次工具回复只提交少量、简短且必要的操作；长任务可继续分轮完成。网页逐次保存每次 API 返回，并将长文本分段累积；每次回复和续写各自有输出 token 上限。工具对话持续到完成，不设固定轮次上限。',
        {
          mode: 'agent_interaction', round: roundNumber, researcherPrompt,
          researcherRecipients,
          previousRoundMessages: active.previousRoundMessages,
          onToolTurn: systemId => recordAgentToolDialogueTurn(systemId)
        }
      );
      active.frame = inference.frame;
      active.round = roundNumber;
      lastAgentRoundNumber = roundNumber;
      lastAgentRoundState = '第 ' + roundNumber + ' 轮已提交';
      lastAgentRoundResults = inference.results.map(result => ({
        systemId: result.systemId,
        toolCount: result.toolTrace.length,
        toolNames: [...new Set(result.toolTrace.map(item => item.name))]
      }));
      active.frameworkCommandLog.push(...inference.commandLog.map(cloneJson));
      active.previousRoundMessages = messagesForNextRound(researcherPrompt, researcherRecipients, inference);
      active.retryPrompt = null;
      active.retryRecipients = [];
      appendAgentRound(roundNumber, researcherPrompt, inference);
      el('agentRoundCount').textContent = String(active.round);
      refreshBalance();
      renderFramework();
      setAgentStatus('第 ' + roundNumber + ' 轮已提交 · 岛屿时钟未推进', 'ok');
      status('Agent 第 ' + roundNumber + ' 轮已完成。所有状态变化均限于所属 system，并记录了理由。', 'ok');
    } catch (error) {
      active.retryPrompt = researcherPrompt;
      active.retryRecipients = researcherRecipients;
      lastAgentRoundState = '第 ' + roundNumber + ' 轮失败 · 等待重试';
      lastAgentRoundError = error.message || String(error);
      lastAgentRoundResults = [];
      el('agentFailureText').textContent = (error.message || String(error)) + formatResponseLedger() + '\n\n本轮未提交任何 agent 状态；岛屿演示时钟也未推进。可以重试相同任务，或结束会话后重新开始。';
      el('agentFailurePanel').hidden = false;
      setAgentStatus('第 ' + roundNumber + ' 轮失败 · 状态未提交', 'error');
      status(error.message || String(error), 'error');
    } finally {
      roundActive = false;
      setBusy(false);
      updateFrameworkControls();
      updateAgentInteractionControls();
    }
  }

  function endAgentInteraction() {
    if (!interactionSession || busy) return;
    if (!confirm('结束并重置会话会清除本次 Agent 对话和状态修改；载入的原始 JSON 会保留。确定继续吗？')) return;
    interactionSession = null;
    roundResponseLedger = new Map();
    agentToolDialogueTurns = 0;
    agentToolDialogueBySystem.clear();
    updateAgentToolDialogueCounter();
    modelCalls = 0;
    roundCalls = 0;
    lastAgentRoundNumber = 0;
    lastAgentRoundState = '等待首次运行';
    lastAgentRoundError = '';
    lastAgentRoundResults = [];
    el('modelCallCount').textContent = '0';
    el('agentModelCallCount').textContent = '模型请求 0';
    el('agentRoundCount').textContent = '0';
    el('agentRoundPrompt').value = '';
    el('agentTranscript').replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'emptyLog';
    empty.textContent = '已重置本次会话。A/B/C 参考框架仍已载入，可配置模型后重新开始。';
    el('agentTranscript').append(empty);
    el('agentFailurePanel').hidden = true;
    el('agentFailureText').textContent = '';
    setAgentStatus('会话已重置 · 原始 JSON 保留', '');
    renderFramework();
    updateAgentInteractionControls();
  }

  function startExperiment() {
    if (busy || interactionSession) return;
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
    emitMonitorUpdate();
  }

  function updateFrameworkControls() {
    const activeSession = interactionSession || session;
    const currentFrame = interactionSession ? interactionSession.frame : session ? session.body : selectedFramework;
    const hasFrame = Boolean(currentFrame);
    const commandCount = activeSession ? activeSession.frameworkCommandLog.length : 0;
    el('frameworkFile').disabled = busy || Boolean(activeSession);
    el('exportFramework').disabled = !hasFrame || busy;
    el('exportFrameworkLog').disabled = !activeSession || busy;
    el('frameworkReplayIndex').disabled = !activeSession || busy || commandCount === 0;
    el('exportReplaySnapshot').disabled = !activeSession || busy;
    el('frameworkEditor').disabled = busy || Boolean(activeSession);
    el('applyFrameworkEditor').disabled = busy || Boolean(activeSession);
    const locked = busy || Boolean(session && session.pendingAction);
    el('frameworkClockEditors').querySelectorAll('input, button').forEach(control => { control.disabled = locked; });
  }

  function renderFrameworkClockEditors(frame) {
    const box = el('frameworkClockEditors');
    box.replaceChildren();
    if (!frame) return;
    for (const system of frame.systems) {
      const row = document.createElement('div');
      const name = document.createElement('span');
      const clock = document.createElement('span');
      row.className = 'frameworkClockRow';
      name.textContent = system.system_id;
      clock.className = 'frameworkClockValue';
      clock.textContent = 'time_clock · ' + system.time_clock + (system.system_id === 'survivor_agent' ? '（本地初始标注）' : '');
      row.append(name, clock);
      box.append(row);
    }
  }

  function renderFrameworkReplay() {
    const activeSession = interactionSession || session;
    if (!activeSession) {
      el('frameworkReplayCount').textContent = '0 / 0';
      el('frameworkReplay').textContent = '开始实验后可按命令序号回放。';
      updateFrameworkControls();
      return;
    }
    const commands = activeSession.frameworkCommandLog;
    const index = Math.max(0, Math.min(commands.length, Number(el('frameworkReplayIndex').value) || 0));
    try {
      const frame = R.replay(activeSession.frameworkAnchor, commands, index);
      el('frameworkReplayCount').textContent = index + ' / ' + commands.length;
      el('frameworkReplay').textContent = JSON.stringify(frame, null, 2);
    } catch (error) {
      el('frameworkReplayCount').textContent = index + ' / ' + commands.length;
      el('frameworkReplay').textContent = '回放失败：' + (error.message || String(error));
    }
    updateFrameworkControls();
  }

  function renderFramework() {
    const activeSession = interactionSession || session;
    const frame = interactionSession ? interactionSession.frame : session ? session.body : selectedFramework;
    const source = interactionSession ? '本次 Agent 会话' : session ? '本次实验' : selectedFrameworkFile;
    if (!frame) {
      el('frameworkSummary').textContent = '未加载';
      el('frameworkState').textContent = '没有有效框架。';
      renderAgentRoster(null);
      renderFrameworkReplay();
      emitMonitorUpdate();
      return;
    }
    el('frameworkSummary').textContent = frame.name + ' · ' + frame.systems.length + ' 个系统';
    el('frameworkState').textContent = JSON.stringify(frame, null, 2);
    el('frameworkEditor').value = JSON.stringify(frame, null, 2);
    renderAgentRoster(frame);
    renderFrameworkClockEditors(frame);
    const commands = activeSession ? activeSession.frameworkCommandLog : [];
    el('frameworkReplayIndex').max = String(commands.length);
    el('frameworkReplayIndex').value = String(commands.length);
    setFrameworkStatus(
      source + '：' + frame.systems.length + ' 个系统；仿真步长 ' + frame.framework_param.time_delta + '，现实等待参数 ' + frame.framework_param.real_time_delta + '。' +
      (activeSession ? ' 已提交 ' + activeSession.round + ' 个回合、记录 ' + commands.length + ' 条状态命令。' : ' 开始后每个系统将并行读取同一份回合起始状态。'),
      'ok'
    );
    renderFrameworkReplay();
    emitMonitorUpdate();
  }

  function getMonitorSnapshot() {
    const frame = interactionSession ? interactionSession.frame : session ? session.body : selectedFramework;
    const commandLog = interactionSession ? interactionSession.frameworkCommandLog : session && Array.isArray(session.frameworkCommandLog) ? session.frameworkCommandLog : [];
    const systems = frame ? frame.systems.map(system => ({
      systemId: system.system_id,
      displayName: displayAgentName(system.system_id),
      timeClock: system.time_clock,
      statement: String(system.statement || '').slice(0, 500),
      eventCount: Array.isArray(system.events) ? system.events.length : 0,
      parameters: Array.isArray(system.parameters) ? system.parameters.map(parameter => ({
        code: String(parameter.param || '未命名参数'),
        value: parameter.value
      })) : [],
      changeCount: commandLog.filter(command => command.system_id === system.system_id && command.change).length
    })) : [];
    if (!session && frame && !systems.some(system => system.systemId === 'survivor_agent')) {
      systems.unshift({
        systemId: 'survivor_agent', displayName: displayAgentName('survivor_agent'), timeClock: 0,
        statement: '首轮运行时自动接入；当前没有预置身体参数。', eventCount: 0, parameters: [], changeCount: 0,
        waitingForStart: !interactionSession
      });
    }
    return {
      systems,
      lastResults: lastAgentRoundResults.map(result => ({ systemId: result.systemId })),
      run: {
        running: busy && roundActive,
        pendingRetry: Boolean(interactionSession && interactionSession.retryPrompt !== null),
        timeDelta: frame ? frame.framework_param.time_delta : '未载入'
      }
    };
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
    if (session || interactionSession || busy) { setFrameworkStatus('请先结束当前会话，再更换推理框架。', 'error'); return; }
    if (file.size > 2 * 1024 * 1024) { setFrameworkStatus('框架文件超过2MB，请检查文件。', 'error'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      const frame = R.normalize(parsed);
      selectedFramework = frame;
      selectedFrameworkFile = file.name;
      renderFramework();
      setFrameworkStatus('已载入 ' + file.name + '：' + frame.systems.length + ' 个系统。rule 将作为模型系统提示发送。', 'ok');
      setAgentStatus('已载入 ' + frame.systems.length + ' 个岛屿 systems · 配置模型后可开始', 'ok');
      updateAgentInteractionControls();
    } catch (error) {
      setFrameworkStatus('框架未载入：' + (error.message || String(error)), 'error');
    }
  }

  async function loadBundledAgentFramework() {
    try {
      const response = await fetch('./olorua-agent-framework.json?v=4.2.2', { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const frame = R.normalize(await response.json());
      selectedFramework = frame;
      selectedFrameworkFile = '网站附带 A/B/C 参数参考 Agent';
      renderFramework();
      setFrameworkStatus('已自动载入 ' + frame.systems.length + ' 个 A/B/C 参数参考 Agent。数值和规则来自网站/参数快照，模拟设定与待确认项不代表本岛实测。', 'ok');
      setAgentStatus('已载入 A/B/C 参考 Agent · 配置模型后可运行', 'ok');
    } catch (error) {
      setFrameworkStatus('无法自动载入网站附带的 A/B/C Agent 框架（' + (error.message || String(error)) + '）；仍可手动载入其他 Olorua systems JSON。', 'error');
      setAgentStatus('未能自动载入 · 可在侧栏手动载入 JSON', '');
    } finally {
      updateAgentInteractionControls();
    }
  }

  function applyFrameworkEditor() {
    if (session || interactionSession || busy) { setFrameworkStatus('请先结束当前会话，再编辑推理框架。', 'error'); return; }
    try {
      const frame = R.normalize(JSON.parse(el('frameworkEditor').value));
      selectedFramework = frame;
      selectedFrameworkFile = '网页 JSON 编辑器';
      renderFramework();
      setFrameworkStatus('网页编辑的框架已应用：' + frame.systems.length + ' 个系统。', 'ok');
      setAgentStatus('JSON 已应用 · 配置模型后可开始', 'ok');
      updateAgentInteractionControls();
    } catch (error) {
      setFrameworkStatus('框架未应用：' + (error.message || String(error)), 'error');
    }
  }

  function exportFrameworkSnapshot() {
    const frame = interactionSession ? interactionSession.frame : session ? session.body : selectedFramework;
    if (!frame) return;
    downloadJson(safeFilename(frame.name) + '-snapshot.json', R.normalize(frame));
  }

  function exportFrameworkLog() {
    const activeSession = interactionSession || session;
    const frame = interactionSession ? interactionSession.frame : session && session.body;
    if (!activeSession || !frame) return;
    downloadJson(safeFilename(frame.name) + '-commands.json', {
      format: 'SITP-framework-command-log',
      version: 1,
      completed_rounds: activeSession.round,
      initial_snapshot: activeSession.frameworkAnchor,
      commands: activeSession.frameworkCommandLog,
      current_snapshot: frame
    });
  }

  function exportReplaySnapshot() {
    const activeSession = interactionSession || session;
    if (!activeSession) return;
    const index = Number(el('frameworkReplayIndex').value) || 0;
    const frame = R.replay(activeSession.frameworkAnchor, activeSession.frameworkCommandLog, index);
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
    keepIslandObserverReadOnly();
    if (session) refreshOptions();
  }

  el('refreshBalance').addEventListener('click', refreshBalance);
  el('discoverModels').addEventListener('click', discoverModels);
  el('frameworkFile').addEventListener('change', loadFrameworkFile);
  el('applyFrameworkEditor').addEventListener('click', applyFrameworkEditor);
  el('exportFramework').addEventListener('click', exportFrameworkSnapshot);
  el('exportFrameworkLog').addEventListener('click', exportFrameworkLog);
  el('frameworkReplayIndex').addEventListener('input', renderFrameworkReplay);
  el('exportReplaySnapshot').addEventListener('click', exportReplaySnapshot);
  el('aiApiKey').addEventListener('input', () => { saveRememberedKey(); prepareAutomaticConnection(true); });
  el('aiApiKey').addEventListener('change', saveRememberedKey);
  el('aiProvider').addEventListener('change', () => {
    el('tongjiProvider').checked = false;
    prepareAutomaticConnection(false, true);
  });
  el('tongjiProvider').addEventListener('change', () => {
    if (el('tongjiProvider').checked) el('aiProvider').value = 'auto';
    prepareAutomaticConnection(false, true);
  });
  el('aiBaseUrl').addEventListener('input', () => { el('tongjiProvider').checked = false; el('aiProvider').value = 'custom'; el('aiModelName').value = ''; saveRememberedConnection(); updateConnectionStatus(); });
  el('aiBaseUrl').addEventListener('change', updateConnectionStatus);
  el('rememberApiKey').addEventListener('change', () => { handleRememberKeyChange(); emitMonitorUpdate(); });
  el('aiModelChoices').addEventListener('change', event => {
    if (event.target.value) {
      el('aiModelName').value = event.target.value;
      saveRememberedConnection();
    }
    emitMonitorUpdate();
  });
  el('aiModelName').addEventListener('input', () => { saveRememberedConnection(); emitMonitorUpdate(); });
  el('randomSeed').addEventListener('click', randomSeed);
  el('startExperiment').addEventListener('click', startExperiment);
  el('endExperiment').addEventListener('click', endExperiment);
  el('runAgentRound').addEventListener('click', () => runAgentInteractionRound(false));
  el('retryAgentRound').addEventListener('click', () => runAgentInteractionRound(true));
  el('endAgentInteraction').addEventListener('click', endAgentInteraction);
  el('actionKind').addEventListener('change', updateActionFields);
  el('collectSite').addEventListener('change', () => refreshResourceOptions());
  el('runAction').addEventListener('click', () => {
    if (!session || busy) return;
    try { performRound(currentAction()); }
    catch (error) { status(error.message, 'error'); say('输入错误', error.message); }
  });
  el('retryAction').addEventListener('click', () => { if (session && session.pendingAction && !busy) performRound(cloneJson(session.pendingAction)); });
  selectedFramework = null;
  selectedFrameworkFile = '未载入岛屿 JSON';
  setFrameworkStatus('正在载入网站附带的 A/B/C 参数参考 Agent；若自动载入失败，可在此手动选择 JSON。');
  setAgentStatus('正在载入 A/B/C 参考框架…', '');
  renderFramework();
  loadBundledAgentFramework();
  loadRememberedKey();
  prepareAutomaticConnection();
  updateActionFields();
  updateAgentInteractionControls();
  keepIslandObserverReadOnly();
  G.SurvivalAgent = Object.freeze({ refreshAfterIslandRender, getMonitorSnapshot });
  new MutationObserver(refreshAfterIslandRender).observe(el('nearby'), { childList: true });
})(globalThis);
