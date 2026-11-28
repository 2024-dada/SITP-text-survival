(function (G) {
  'use strict';

  const M = G.IslandModel;
  const R = G.SITPFrameworkRuntime;
  const el = id => document.getElementById(id);
  const PARAMETER_LABELS = {
    core_temp_c: '核心体温', skin_blood_flow_ml_min: '皮肤血流',
    shivering_heat_ml_min: '寒战产热（示例值）', sweat_rate_ml_h: '出汗',
    heart_rate_bpm: '心率', systolic_bp_mmhg: '收缩压',
    diastolic_bp_mmhg: '舒张压', cardiac_output_l_min: '心输出量',
    respiratory_rate_bpm: '呼吸频率', tidal_volume_ml: '潮气量',
    minute_ventilation_l_min: '每分钟通气量'
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

  const survivorAgentRule = '你是本次实验中的求生者 agent。只依据已经提供的文字、事件和自身状态交流，不把估计冒充为已观测事实。研究者要求模拟时，必须基于现有地图、参数、资源、天气和规则，主动构造连贯、具体的情景；某项数据缺少精确值时，给出合理的模拟估计或范围，说明采用的依据与假设，不要只回复“未知”或跳过。模拟估计仅用于情景推演和报告，不得写成岛屿实测值或擅自写入参数。你只能修改当前 system 自己的 parameters、statement、events 和 time_clock；每项状态修改都必须说明 reason。time_clock 只是你自己的标注，不会推进岛屿模拟时钟。可用 send_message 定向给一个或多个 agent，收件人表示希望谁回应；网页会保存完整对话，但下一轮发给模型的历史内容受长度上限约束，过长时只发送最近部分。每轮所有 agent 并行处理同一份开始状态，不能看到同轮其他 agent 的结果。请简洁回答并避免重复已有状态；工具调用每次只提交少量且必要的内容，长任务可以继续分轮完成，不要一次生成很长的工具参数。';

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
    el('runAgentRound').disabled = busy || Boolean(session) || (!active && !loaded) || pending || Boolean(interactionSession?.pendingEventReport);
    el('runAgentRound').title = interactionSession?.pendingEventReport ? '请先重试完成本轮报告与结算' : '';
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
    const reportRetry = /^event_/.test(systemId || '') && Boolean(interactionSession?.pendingEventReport);
    if ((!roundActive && !reportRetry) || !systemId || typeof content !== 'string') return;
    if (!roundResponseLedger.has(systemId)) roundResponseLedger.set(systemId, []);
    roundResponseLedger.get(systemId).push({ content, finishReason: finishReason || '', segmentType: segmentType || '回复' });
    const pendingRound = interactionSession?.pendingEventReport?.context.round;
    if (pendingRound) {
      const archivedRound = interactionSession.archiveRounds.find(item => item.round === pendingRound);
      if (archivedRound) archivedRound.model_responses = cloneJson([...roundResponseLedger.entries()]);
    }
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
    for (let length = maximum; length >= 4; length -= 1) {
      const prefix = next.slice(0, length);
      if ((length >= 12 || /[\u3400-\u9fff]{3}/.test(prefix)) && existing.endsWith(prefix)) return length;
    }
    return 0;
  }

  function completeToolCalls(message) {
    if (!message || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return false;
    return message.tool_calls.every(call => {
      if (!call || !call.id || call.type !== 'function' || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') return false;
      try {
        const args = JSON.parse(call.function.arguments);
        return Boolean(args && typeof args === 'object' && !Array.isArray(args));
      } catch {
        return false;
      }
    });
  }

  async function requestCompletion(settings, messages, tools, choice, systemId, requestOptions = {}) {
    const requestMaxTokens = Number.isFinite(requestOptions.maxTokens)
      ? Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(requestOptions.maxTokens)))
      : MAX_COMPLETION_TOKENS;
    const continuationMaxTokens = Number.isFinite(requestOptions.continuationTokens)
      ? Math.max(1, Math.min(CONTINUATION_COMPLETION_TOKENS, Math.floor(requestOptions.continuationTokens)))
      : CONTINUATION_COMPLETION_TOKENS;
    const reportMode = systemId === 'event_report_plan' ? 'json'
      : ['event_report_summary', 'event_body_summary'].includes(systemId) ? 'text' : '';
    if (reportMode === 'json') messages = messages.concat({ role: 'user', content: '这是程序读取的行动计划数据。请只返回完整、紧凑且可解析的 JSON，不输出思考过程或 Markdown；保留研究者明确提出的全部行动时段，字段内容简洁但不要遗漏结算所需信息。' });
    if (reportMode === 'text') messages = messages.concat({ role: 'user', content: '请直接给研究者一段自然、完整的中文报告。可以按内容自由分段或自拟小标题（纯文本，不加 Markdown 标记），不输出 JSON，不要为了套用固定栏目重复或补造信息；以本轮已提交结果和参数为依据。' });
    const contextExcerpt = responseContextExcerpt(messages);
    const responseSegments = [];
    let continuationCount = 0;
    let reportRecoveryUsed = false;
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
      if (new URL(settings.endpoint).hostname === 'api.deepseek.com' &&
          /^(?:event_|reviewer_reflection_)/.test(systemId || '')) {
        payload.thinking = { type: 'disabled' };
        if (systemId === 'event_plan_compact' || (systemId === 'event_report_plan' && continuationCount === 0)) {
          payload.response_format = { type: 'json_object' };
        }
      }
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

    let current = await send(messages, tools, choice, requestMaxTokens);
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
    if (requestOptions.singleResponse) {
      current.message._responseSegments = responseSegments.slice();
      return current.message;
    }

    if (current.finishReason === 'length' && firstToolCalls.length && completeToolCalls(current.message)) {
      current.message._responseSegments = responseSegments.slice();
      return current.message;
    }

    if (current.finishReason === 'length' && firstToolCalls.length) {
      const recoveryMessages = messages.concat({
        role: 'user',
        content: '上一条回复在工具调用参数中达到单次输出上限。网页已保存原始片段；这条未完整的工具调用没有执行。请不要重发工具调用或声称它已成功；只根据已经完整收到的信息，简洁给出可支持的结论。依赖未执行计算的信息请明确标注未知/待核。'
      });
      current = await send(recoveryMessages, null, null, continuationMaxTokens);
      const recoveryText = typeof current.message.content === 'string' ? current.message.content : '';
      recordAgentResponse(systemId, recoveryText, current.finishReason, '工具调用截断后的安全总结');
      if (Array.isArray(current.message.tool_calls) && current.message.tool_calls.length) {
        throw new Error('工具调用被截断后仍未能安全总结；未执行不完整调用，原始响应已保存在失败记录中。');
      }
      if (!recoveryText.trim()) {
        throw new Error('工具调用被截断，安全总结请求没有返回文本；原始响应已保存在失败记录中。');
      }
      accumulated = recoveryText;
      responseSegments.splice(0, responseSegments.length, recoveryText);
      current.message.content = recoveryText;
    }

    if (current.finishReason === 'length') {
      while (current.finishReason === 'length') {
        if (reportMode === 'json' && accumulated.trim()) {
          try {
            parseModelJson(accumulated, '行动计划');
            break;
          } catch { /* Continue only while the structured response is incomplete. */ }
        }
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
        current = await send(continuationMessages, null, null, continuationMaxTokens);
        const next = typeof current.message.content === 'string' ? current.message.content : '';
        recordAgentResponse(systemId, next, current.finishReason, '续写 ' + continuationCount);
        if (next) {
          const overlap = exactOverlapLength(accumulated, next);
          const addition = next.slice(overlap);
          if (!addition.trim()) throw new Error('模型续写重复了已有内容，未生成新文本。');
          accumulated += addition;
          responseSegments.push(addition);
        }
        if (current.message.tool_calls && current.message.tool_calls.length) {
          throw new Error('模型续写时返回了工具调用，无法安全拼接文本；已保留此前生成的分段。请缩短本轮任务后重试。');
        }
        if (!next || !next.trim()) {
          if (reportMode) {
            if (reportMode === 'text' && reportRecoveryUsed && accumulated.trim()) {
              throw new Error('报告重写仍未完成，改用已保存的结算记录整理报告。');
            }
            const recoveryInstruction = reportMode === 'json'
              ? '上次行动计划被截断且续写为空。请重新检查输入，只返回完整紧凑 JSON；保留所有明确安排的时段及结算所需字段。'
              : '上次报告续写为空。请重新依据原始输入直接写一份完整、精炼的中文报告；可自由组织段落或小标题，不输出 JSON，不套固定栏目。';
            reportRecoveryUsed = true;
            const recovered = await send(messages.concat({ role: 'user', content: recoveryInstruction }), null, null, requestMaxTokens);
            const recoveredText = typeof recovered.message.content === 'string' ? recovered.message.content : '';
            recordAgentResponse(systemId, recoveredText, recovered.finishReason, reportMode === 'json' ? '行动计划紧凑重建' : '自由体报告重写');
            if (recoveredText.trim()) {
              if (recovered.message.tool_calls?.length) throw new Error('报告重试返回了工具调用，无法作为报告内容使用。');
              // A provider may mark a complete JSON object as "length" when
              // it ends exactly at the output boundary. Validate structured
              // plans by their content; free-form reports are accepted as text.
              if (reportMode === 'json') {
                parseModelJson(recoveredText, '重建行动计划');
              } else if (recoveredText.trim().startsWith('{')) {
                parseFlexibleNarrative(recoveredText, '重建事件报告');
              } else if (recovered.finishReason === 'length') {
                current = recovered;
                accumulated = recoveredText;
                responseSegments.splice(0, responseSegments.length, recoveredText);
                continue;
              }
              recovered.message._responseSegments = [recoveredText];
              return recovered.message;
            }
          }
          throw new Error('模型续写没有返回可用文本；原始响应已保留，可重试报告。');
        }
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
      const unit = G.SITPParameterUnits ? G.SITPParameterUnits.get(parameter.param) : '1（无量纲，推定）';
      const previous = before.has(parameter.param) ? before.get(parameter.param) + ' ' + unit : '新增';
      changes.push((PARAMETER_LABELS[parameter.param] || parameter.param) + ' ' + previous + ' → ' + parameter.value + ' ' + unit);
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

  function eventResourceIntents(text) {
    const definitions = [
      { resourceId: 'R01', name: '收集枯木', pattern: /枯木|木柴|捡木|收集木|柴火/ },
      { resourceId: 'R02', name: '收集纤维', pattern: /纤维|藤条|绳材/ },
      { resourceId: 'R03', name: '采摘椰果', pattern: /椰子|椰果|椰汁/ },
      { resourceId: 'R04', name: '观察山羊活动区', pattern: /山羊|野山羊/ },
      { resourceId: 'R05', name: '捕鱼', pattern: /捕鱼|抓鱼|钓鱼|捕捞|捞鱼|鱼类/ },
      { resourceId: 'R06', name: '采集贝类', pattern: /贝类|海贝|捡贝/ },
      { resourceId: 'R07', name: '采集近岸甲壳类', pattern: /螃蟹|抓蟹|甲壳类/ },
      { resourceId: 'R09', name: '采集石块', pattern: /石块|石头|石材/ },
      { resourceId: 'R10', name: '观察岸滩空壳', pattern: /空壳|碎贝壳|贝壳碎屑/ }
    ];
    return definitions.filter(item => item.pattern.test(String(text || ''))).map(({ resourceId, name }) => ({ resourceId, name }));
  }

  function eventCandidates(world, position, actionText) {
    const intents = eventResourceIntents(actionText);
    const currentSites = new Map(world.sites.map(site => [site.id, site]));
    const sites = M.D.sites.map(site => {
      const point = [site.east_m, site.north_m];
      if (!M.inside(point)) return null;
      const current = currentSites.get(site.id);
      const pools = (current ? current.pools : site.stocks.map(stock => ({ ...stock, amount: stock.initial })))
        .filter(pool => Number.isFinite(pool.amount) && pool.amount > 0)
        .map(pool => ({ resource: pool.resource, name: M.D.pools[pool.resource]?.name || pool.resource, amount: pool.amount, unit: pool.unit }));
      if (!pools.length && site.id !== '01') return null;
      const zone = M.zone(point);
      return {
        id: 'site:' + site.id, siteId: site.id, name: site.name, zone: zone?.name || site.zone,
        east_m: site.east_m, north_m: site.north_m, distance_m: Math.round(Math.hypot(point[0] - position[0], point[1] - position[1])),
        elevation_m: Math.round(M.terrain(point) * 10) / 10, resources: pools
      };
    }).filter(Boolean);
    const byId = new Map();
    const addNearest = matches => matches.sort((a, b) => a.distance_m - b.distance_m).slice(0, 12).forEach(site => byId.set(site.id, site));
    if (intents.length) {
      for (const intent of intents) addNearest(sites.filter(site => site.resources.some(resource => resource.resource === intent.resourceId)));
    } else addNearest(sites.slice());
    const camp = sites.find(site => site.siteId === '01');
    if (camp) byId.set(camp.id, camp);

    const waterSources = [];
    if (/水|水源|淡水|雨水|集雨|饮水/.test(String(actionText || ''))) {
      for (const [resource, siteId, name] of [['W01', '08', '岩池原水'], ['W02', '01', '集雨器中的水']]) {
        const site = M.D.sites.find(item => item.id === siteId);
        const amount = Number(world.water?.[resource] || 0);
        if (!site || amount <= 0 || (resource === 'W02' && !world.collector)) continue;
        const point = [site.east_m, site.north_m];
        const zone = M.zone(point);
        const water = M.D.water?.[resource];
        waterSources.push({
          id: 'water:' + resource, siteId, name: site.name, zone: zone?.name || site.zone,
          east_m: site.east_m, north_m: site.north_m,
          distance_m: Math.round(Math.hypot(point[0] - position[0], point[1] - position[1])),
          elevation_m: Math.round(M.terrain(point) * 10) / 10,
          resources: [{ resource, name, amount, unit: 'L', capacity_l: water?.capacity_L ?? null, note: resource === 'W01' ? '原水，未计入饮用水' : '仅在集雨器启用时存在' }],
          waterSource: true
        });
      }
      for (const source of waterSources) byId.set(source.id, source);
    }
    const zone = M.zone(position);
    byId.set('observer', { id: 'observer', name: '当前所在位置', zone: zone?.name || '岛上位置', east_m: position[0], north_m: position[1], distance_m: 0, elevation_m: Math.round(M.terrain(position) * 10) / 10, resources: [] });
    return { intent: intents[0] || null, intents, sites: [...byId.values()] };
  }

  function changedBodyParameters(beforeFrame, afterFrame) {
    const before = beforeFrame.systems.find(system => system.system_id === 'survivor_agent');
    const after = afterFrame.systems.find(system => system.system_id === 'survivor_agent');
    const oldValues = new Map((before?.parameters || []).map(parameter => [parameter.param, parameter.value]));
    return (after?.parameters || []).filter(parameter => {
      if (/api[-_]?key|token|secret|password|credential/i.test(parameter.param)) return false;
      return oldValues.get(parameter.param) !== parameter.value;
    }).map(parameter => ({
      code: parameter.param,
      before: oldValues.has(parameter.param) ? oldValues.get(parameter.param) : null,
      after: parameter.value,
      unit: G.SITPParameterUnits?.get(parameter.param) || '1（无量纲，未识别字段的暂定推定）'
    }));
  }

  function buildEventReportContext(world, position, roundNumber, researcherPrompt, beforeFrame, inference, inventory = {}) {
    const actionText = [researcherPrompt, ...inference.results.map(result => result.finalText || '')].filter(Boolean).join('\n').slice(0, 7000);
    const candidates = eventCandidates(world, position, actionText);
    const weather = M.weather(world.hour, world.seed, position);
    const observation = M.observe ? M.observe(world, position) : null;
    const statements = inference.frame.systems.map(system => ({
      agent: displayAgentName(system.system_id), statement: String(system.statement || '').slice(0, 700),
      final_text: String(inference.results.find(result => result.systemId === system.system_id)?.finalText || '')
    }));
    const bodyBefore = beforeFrame.systems.find(system => system.system_id === 'survivor_agent');
    const bodyAfter = inference.frame.systems.find(system => system.system_id === 'survivor_agent');
    const changes = inference.commandLog.filter(command => command.change).slice(0, 24).map(command => ({
      agent: displayAgentName(command.system_id), field: String(command.change.field || '').slice(0, 100),
      before: auditValue(command.change.before).slice(0, 180), after: auditValue(command.change.after).slice(0, 180),
      reason: String(command.change.reason || '').slice(0, 220)
    }));
    return {
      round: roundNumber,
      researcher_prompt: researcherPrompt,
      action_text: actionText,
      world: { seed: world.seed, hour: world.hour, time_text: worldTimeText(M.weather(world.hour, world.seed, position).date), selected_position_m: position, weather: {
        label: weather.label, rain_mm_h: Math.round(weather.rain * 10) / 10,
        temperature_c: Math.round(weather.temperature * 10) / 10, daylight: weather.daylight, tide_m: Math.round(weather.tide * 100) / 100
      } },
      event_candidates: candidates.sites,
      resource_intent: candidates.intent,
      resource_intents: candidates.intents,
      carried_items: Object.entries(inventory).map(([resource, item]) => ({ resource, ...item })),
      simulation_policy: '使用岛屿数据、框架参数、Agent 推理和本轮输入形成完整连贯的模拟。精确数据缺失时也要给出具体估计与假设，不要因此跳过；估计只用于模拟结果，不得改写已有观测值或假装成实测。',
      current_scene: observation?.valid ? String(observation.role || '').slice(0, 2200) : '',
      body: {
        before_statement: String(bodyBefore?.statement || ''), after_statement: String(bodyAfter?.statement || ''),
        current_parameters: (bodyAfter?.parameters || []).filter(parameter => !/api[-_]?key|token|secret|password|credential/i.test(parameter.param)).map(parameter => ({
          code: parameter.param, value: parameter.value,
          unit: G.SITPParameterUnits?.get(parameter.param) || '1（无量纲，未识别字段的暂定推定）'
        })),
        parameter_changes: changedBodyParameters(beforeFrame, inference.frame)
      },
      agent_outputs: statements,
      state_changes: changes
    };
  }

  function parseModelJson(raw, label) {
    const source = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = source.indexOf('{'), end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(label + '没有返回完整 JSON。');
    try { return JSON.parse(source.slice(start, end + 1)); }
    catch { throw new Error(label + '的 JSON 格式不完整，请重试报告。'); }
  }

  function parseFlexibleNarrative(raw, label) {
    const source = String(raw || '').trim().replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!source) throw new Error(label + '没有返回可用文本。');
    if (source.startsWith('{')) return parseModelJson(source, label);
    return { human_summary: source };
  }

  function compactEventPlanContext(context) {
    return {
      round: context.round,
      researcher_prompt: String(context.researcher_prompt || '').slice(0, 1800),
      action_text: String(context.action_text || '').slice(0, 2800),
      world: context.world,
      event_candidates: (context.event_candidates || []).map(candidate => ({
        id: candidate.id, name: candidate.name, zone: candidate.zone,
        east_m: candidate.east_m, north_m: candidate.north_m,
        distance_m: candidate.distance_m, elevation_m: candidate.elevation_m,
        waterSource: Boolean(candidate.waterSource),
        resources: (candidate.resources || []).map(resource => ({
          resource: resource.resource, name: resource.name, amount: resource.amount,
          unit: resource.unit, capacity_l: resource.capacity_l, note: resource.note
        }))
      })),
      resource_intent: context.resource_intent,
      resource_intents: context.resource_intents,
      carried_items: context.carried_items,
      simulation_policy: context.simulation_policy,
      current_scene: String(context.current_scene || '').slice(0, 1100),
      body: {
        before_statement: String(context.body?.before_statement || '').slice(0, 500),
        after_statement: String(context.body?.after_statement || '').slice(0, 700),
        current_parameters: (context.body?.current_parameters || []).slice(0, 18),
        parameter_changes: (context.body?.parameter_changes || []).slice(0, 18)
      },
      agent_outputs: (context.agent_outputs || []).map(agent => ({
        agent: agent.agent, statement: String(agent.statement || '').slice(0, 450),
        final_text: String(agent.final_text || '').slice(0, 650)
      })),
      state_changes: (context.state_changes || []).slice(-16)
    };
  }

  function validateEventPlan(plan, context) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.steps)) {
      throw new Error('行动时间线没有返回可结算的 steps 列表。');
    }
    const maxMinutes = 24 * 366 * 5 * 60;
    let previousEnd = 0;
    const candidates = new Map((context.event_candidates || []).map(candidate => [candidate.id, candidate]));
    for (const [index, step] of plan.steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`第 ${index + 1} 个行动时段格式无效。`);
      if (!Number.isInteger(step.start_offset_minutes) || step.start_offset_minutes < previousEnd || step.start_offset_minutes % 15) throw new Error(`第 ${index + 1} 个行动时段的开始时间无效或与前项重叠。`);
      if (!Number.isInteger(step.duration_minutes) || step.duration_minutes < 15 || step.duration_minutes % 15) throw new Error(`第 ${index + 1} 个行动时段的耗时必须为15分钟的正整数倍。`);
      previousEnd = step.start_offset_minutes + step.duration_minutes;
      if (previousEnd > maxMinutes) throw new Error('本轮行动时间线超过岛屿时钟可结算范围。');
      if (!String(step.time_label || '').trim() || !String(step.activity || '').trim() || !String(step.assumption || '').trim()) throw new Error(`第 ${index + 1} 个行动时段缺少时间、行动或推算依据。`);
      if (!Number.isInteger(step.probability_percent) || step.probability_percent < 0 || step.probability_percent > 100) throw new Error(`第 ${index + 1} 个行动时段的成功率必须是0至100的整数。`);
      if (!String(step.success_result || '').trim() || !String(step.failure_result || '').trim()) throw new Error(`第 ${index + 1} 个行动时段缺少成功或未成功结果。`);
      if (step.point_id !== null && step.point_id !== undefined && !candidates.has(step.point_id)) throw new Error(`第 ${index + 1} 个行动时段引用了地图候选列表外的点位。`);
      if (step.resource_id !== null && step.resource_id !== undefined && typeof step.resource_id !== 'string') throw new Error(`第 ${index + 1} 个行动时段的资源标识无效。`);
    }
    return candidates;
  }

  function formatQuantity(value) {
    return String(Number(Number(value).toFixed(3)));
  }

  function carriedItemsText(inventory) {
    const items = Object.values(inventory || {}).filter(item => Number(item.amount) > 0);
    return items.length
      ? items.map(item => `${item.name} ${formatQuantity(item.amount)} ${item.unit}`).join('、')
      : '无';
  }

  function hasCarriedContainer(inventory) {
    return Object.values(inventory || {}).some(item => Number(item.amount) > 0
      && /容器|瓶|水壶|水桶|罐|杯|container|bottle|flask/i.test(String(item.name || '')));
  }

  function prepareTimelineSettlement(active, pending) {
    if (pending.settlement) return pending.settlement;
    const world = cloneJson(pending.worldSnapshot);
    const inventory = cloneJson(active.inventory || {});
    const candidates = new Map(pending.context.event_candidates.map(candidate => [candidate.id, candidate]));
    const initialPosition = pending.context.world.selected_position_m.slice();
    let position = initialPosition.slice();
    let elapsed = 0;
    let collectedTotal = 0;
    const actualSteps = [];

    for (const [index, step] of pending.plan.steps.entries()) {
      const idleMinutes = step.start_offset_minutes - elapsed;
      if (idleMinutes > 0) M.tick(world, idleMinutes / 60);
      const candidate = step.point_id ? candidates.get(step.point_id) : null;
      const point = candidate ? [candidate.east_m, candidate.north_m] : position.slice();
      position = point.slice();
      world.selected = point.slice();
      const startWeather = M.weather(world.hour, world.seed, point);
      const sceneBefore = M.observe ? M.observe(world, point) : null;
      const draw = M.rnd(world.seed, `timeline:${pending.context.round}:${index}:${step.time_label}:${step.activity}`);
      const randomDraw = Math.floor(draw * 10000) / 100;
      const sampledSuccess = draw * 100 < step.probability_percent;
      let success = sampledSuccess;
      let resultText = String(success ? step.success_result : step.failure_result).trim();
      let settlementText = '模拟估计，仅推进时间；未改变岛屿资源库存。';
      let collected = null;

      if (success && step.resource_id) {
        const resource = candidate?.resources.find(item => item.resource === step.resource_id);
        if (!candidate || !resource || !candidate.siteId) {
          settlementText = `本轮地图没有与 ${step.resource_id} 对应的可结算点位；报告保留模拟估计，库存不变。`;
        } else if (['R04', 'R08'].includes(step.resource_id)) {
          settlementText = `${resource.name}在当前地图数据中用于活动/观察记录，不按采集物扣减库存。`;
        } else if (['W01', 'W02'].includes(step.resource_id)) {
          if (!candidate.waterSource || !hasCarriedContainer(inventory)) {
            success = false;
            resultText = '到达了水源位置，但随身物品里没有可用容器，无法把水带回营地。';
            settlementText = '没有容器，未从水源库存取水；岛屿水量保持不变。';
          } else {
            const amount = Math.min(Number(world.water[step.resource_id] || 0), 0.5);
            if (amount <= 0) {
              success = false;
              resultText = '到达时水源库存已空，未能取水。';
              settlementText = '水源没有可取水量，岛屿水量与随身物品均不变。';
            } else {
              world.water[step.resource_id] = Number((world.water[step.resource_id] - amount).toFixed(3));
              const name = resource.name;
              const item = inventory[step.resource_id] || (inventory[step.resource_id] = { amount: 0, unit: 'L', name });
              item.amount = Number((item.amount + amount).toFixed(3));
              collectedTotal += amount;
              collected = { resource: step.resource_id, name, amount, unit: 'L' };
              settlementText = `实际取水 ${formatQuantity(amount)} L，已加入随身物品；未直接饮用。`;
            }
          }
        } else {
          try {
            const existingItem = inventory[step.resource_id];
            if (existingItem && (existingItem.unit !== resource.unit || !Number.isFinite(existingItem.amount) || existingItem.amount < 0)) {
              throw new Error('本次物品单位或数量与已有背包记录不一致');
            }
            const amount = M.harvest(world, candidate.siteId, step.resource_id, '求生者');
            const item = existingItem || (inventory[step.resource_id] = { amount: 0, unit: resource.unit, name: resource.name });
            item.amount = Number((item.amount + amount).toFixed(3));
            item.name = resource.name;
            collectedTotal += amount;
            collected = { resource: step.resource_id, name: resource.name, amount, unit: resource.unit };
            settlementText = `按岛屿规则采集 ${formatQuantity(amount)} ${resource.unit}，加入随身物品；未直接摄入。`;
          } catch (error) {
            success = false;
            resultText = `模拟抽样原本成功，但执行时受到岛屿规则限制：${error.message}。`;
            settlementText = `采集未落账，库存保持不变：${error.message}。`;
          }
        }
      }

      M.tick(world, step.duration_minutes / 60);
      elapsed = step.start_offset_minutes + step.duration_minutes;
      const endWeather = M.weather(world.hour, world.seed, point);
      const sceneAfter = M.observe ? M.observe(world, point) : null;
      actualSteps.push({
        index: index + 1, timeLabel: step.time_label, activity: step.activity,
        durationMinutes: step.duration_minutes,
        assumption: step.assumption, pointReason: step.point_reason,
        probability: step.probability_percent, randomDraw,
        sampledSuccess, success, resultText, settlementText, collected,
        point: candidate ? { id: candidate.id, name: candidate.name, zone: candidate.zone, east_m: candidate.east_m, north_m: candidate.north_m } : null,
        startTime: worldTimeText(startWeather.date), endTime: worldTimeText(endWeather.date),
        weatherStart: weatherText(startWeather), weatherEnd: weatherText(endWeather),
        sceneBefore: sceneBefore?.valid ? String(sceneBefore.role || '').slice(0, 500) : '',
        sceneAfter: sceneAfter?.valid ? String(sceneAfter.role || '').slice(0, 500) : ''
      });
    }

    if (!actualSteps.length) throw new Error('本轮没有行动时段，不应建立状态结算。');
    world.selected = position.slice();
    M.validate(world);
    const startTime = worldTimeText(M.weather(pending.worldSnapshot.hour, world.seed, initialPosition).date);
    const endTime = worldTimeText(M.weather(world.hour, world.seed, position).date);
    const harvested = actualSteps.filter(step => step.collected).map(step => `${step.collected.name} +${formatQuantity(step.collected.amount)} ${step.collected.unit}`);
    const summary = `本轮按时间线结算 ${actualSteps.length} 个时段，岛屿时钟推进 ${elapsed} 分钟（${startTime}—${endTime}）。${harvested.length ? `实际加入随身物品：${harvested.join('、')}。` : '本轮没有资源进入随身物品。'}当前随身物品：${carriedItemsText(inventory)}。未对应到岛屿库存的步骤只作为明确标注的模拟估计，不改写岛屿资源账本。`;
    pending.settlement = {
      world, inventory, position, durationMinutes: elapsed, summary,
      steps: actualSteps, collectedTotal, frame: null, commands: [], committed: false, reportAdded: false
    };
    return pending.settlement;
  }

  function prepareEventFrameworkSettlement(active, pending) {
    const settlement = pending.settlement;
    if (settlement.frame) return settlement;
    const frame = cloneJson(active.frame);
    const commands = [];
    applyFrameworkCommand(frame, commands, {
      type: 'set_framework_parameter', name: 'time_delta', value: settlement.durationMinutes,
      reason: '本轮完整行动时间线的模拟时长，单位为分钟。'
    });
    for (const system of frame.systems) {
      if (!Number.isFinite(system.time_clock)) throw new Error('Agent time_clock 不是有限数值，不能结算模拟时间。');
      applyFrameworkCommand(frame, commands, {
        type: 'set_time_clock', system_id: system.system_id,
        value: system.time_clock + settlement.durationMinutes,
        reason: '随本轮完整行动时间线结算同步累计模拟时间。'
      });
    }
    R.validate(frame);
    settlement.frame = frame;
    settlement.commands = commands;
    return settlement;
  }

  function parameterizedSettlementMessage(settlement, pending) {
    const beforeTotals = M.totals(pending.worldSnapshot);
    const resourceTotals = M.totals(settlement.world);
    const resourceChanges = Object.entries(resourceTotals).flatMap(([resource_id, current]) => {
      const before = beforeTotals[resource_id];
      if (!before || before.amount === current.amount) return [];
      return [{ resource_id, amount_before: Number(before.amount.toFixed(3)), amount_after: Number(current.amount.toFixed(3)), delta: Number((current.amount - before.amount).toFixed(3)), unit: current.unit }];
    });
    const weather = M.weather(settlement.world.hour, settlement.world.seed, settlement.position);
    return JSON.stringify({
      schema: 'island_settlement_v1',
      round: pending.context.round,
      elapsed_minutes: settlement.durationMinutes,
      world: {
        hour: settlement.world.hour,
        time_text: worldTimeText(weather.date),
        selected_position_m: settlement.position,
        weather: {
          rain_mm_h: Number(weather.rain.toFixed(2)),
          temperature_c: Number(weather.temperature.toFixed(1)),
          tide_m: Number(weather.tide.toFixed(2)),
          daylight: weather.daylight
        },
        water_L: settlement.world.water,
        resource_totals: resourceTotals,
        resource_changes: resourceChanges
      },
      ecology: M.ecologySummary(settlement.world),
      actions: settlement.steps.map(step => ({
        time_label: step.timeLabel,
        start_time: step.startTime,
        end_time: step.endTime,
        duration_minutes: pending.plan.steps[step.index - 1].duration_minutes,
        activity: step.activity,
        success_probability_percent: step.probability,
        sampled_success: step.sampledSuccess,
        success: step.success,
        result_code: step.success ? 'completed' : 'not_completed',
        point_id: step.point?.id || null,
        resource_id: step.collected?.resource || null,
        collected_amount: step.collected?.amount || 0,
        collected_unit: step.collected?.unit || null
      })),
      carried_items: Object.entries(settlement.inventory).map(([resource_id, item]) => ({ resource_id, amount: item.amount, unit: item.unit }))
    });
  }

  function fallbackBodySummary(pending, settlement) {
    const body = pending.context.body || {};
    const survivor = (pending.context.agent_outputs || []).find(agent => agent.agent === '求生者 Agent');
    const statement = String(body.after_statement || survivor?.statement || '').trim();
    const steps = settlement?.steps || pending.plan?.steps || [];
    const safeSelfReport = statement.length <= 160
      && !/[0-9０-９%％]/.test(statement)
      && !/(参数|数值|单位|指标|计划|资源量|渔获|工具|模拟推演)/.test(statement)
      ? statement : '';
    if (!steps.length) return safeSelfReport ? `求生者自述：${safeSelfReport}` : '本轮没有安排具体行动，暂无新的身体感受记录。';
    const minutes = settlement?.durationMinutes || steps.reduce((sum, step) => sum + (Number(step.durationMinutes || step.duration_minutes) || 0), 0);
    const physicalEffort = steps.some(step => /行走|前往|寻找|采集|捕鱼|捕捞|搬|搭建|砍|攀|爬|收集|搬运|处理|生火/.test(String(step.activity || '')));
    const sensation = physicalEffort
      ? '结合活动内容推测，连续行动后可能会有些疲惫，适合休息并留意补水。'
      : '结合活动内容推测，本轮身体负荷较轻。';
    const activityText = physicalEffort ? '进行了体力活动' : '以较轻的观察活动为主';
    return `${safeSelfReport ? `求生者自述：${safeSelfReport}。` : ''}本轮${activityText}，持续约 ${minutes} 分钟。${sensation}`;
  }

  function fallbackEventNarrative(pending, plan, settlement, noActivitySettlement) {
    const steps = settlement?.steps || [];
    const timeline = steps.length ? steps : (plan.steps || []);
    const outcomes = timeline.map((step, index) => {
      const time = step.timeLabel || step.time_label || `第 ${index + 1} 项`;
      const activity = String(step.activity || '行动').trim();
      const probability = Number.isFinite(step.probability) ? step.probability : Number(step.probability_percent);
      const result = String(step.resultText || (step.sampledSuccess ? step.success_result : step.failure_result) || '').trim();
      const sampled = typeof step.sampledSuccess === 'boolean' ? `，种子抽样${step.sampledSuccess ? '命中' : '未中'}` : '';
      const settled = typeof step.success === 'boolean' ? `，实际${step.success ? '完成' : '未完成'}` : '';
      return `${time} ${activity}${Number.isFinite(probability) ? `，推算成功率 ${probability}%` : ''}${sampled}${settled}${result ? `：${result}` : ''}`;
    });
    const first = steps[0];
    const last = steps[steps.length - 1];
    const beforeScene = String(first?.sceneBefore || pending.context.current_scene || '').trim();
    const afterScene = String(last?.sceneAfter || beforeScene).trim();
    return {
      human_summary: outcomes.length
        ? outcomes.join('；')
        : String(plan.summary || pending.context.researcher_prompt || '本轮 Agent 推理已提交，没有安排具体行动时段。'),
      body_summary: fallbackBodySummary(pending, settlement),
      before_scene: beforeScene,
      after_scene: afterScene,
      island_summary: settlement?.summary || noActivitySettlement,
      recovery_note: '模型简报没有完整返回，已根据本轮 Agent 结果、行动时间线和结算记录自动补全。'
    };
  }

  async function generateBodySummary(settings, pending, eventStatus) {
    if (pending.bodySummary) return pending.bodySummary;
    const context = {
      round: pending.context.round,
      researcher_prompt: pending.context.researcher_prompt,
      body: pending.context.body,
      survivor_agent_output: pending.context.agent_outputs.find(agent => agent.agent === '求生者 Agent') || null,
      timeline: pending.settlement?.steps || pending.plan?.steps || [],
      event_status: eventStatus || '本轮没有确认具体行动事件。'
    };
    const response = await requestCompletion(settings, [
      { role: 'system', content: '请为研究者写求生者身体感受简报。使用第一人称、自然中文，根据人体 Agent 已提交的状态和参数前后变化，并结合本轮实际行动时长、天气与结果来推断身体感受。参数只用于推断感受：不要输出任何参数名称、数值、单位或参数变化清单，也不要复述详细计划、工具清单、物资数量或渔获估算；重点写本轮真实结算的行动带来的主观感受及必要原因。不要按固定句式或固定栏目填空，可自由组织语言；没有具体身体参数时，可依据活动给出定性模拟推测并明确这是推测，不要捏造体征数值或医学结论，不要把物品采集写成已进食/饮水。优先写出最有意义的感受，表达完整即可，不要在句中截断。这段简报只显示在事件报告，不写入 Agent 状态、对话历史或下一轮输入；直接输出纯文本，不使用 Markdown 标记。' },
      { role: 'user', content: JSON.stringify(context) }
    ], null, null, 'event_body_summary');
    const parsed = parseFlexibleNarrative(response.content, '人体感受报告');
    const summary = String(parsed.body_summary || parsed.human_summary || parsed.report_text || '').trim();
    if (!summary) throw new Error('事件报告没有返回有效的人体感受，请重试报告。');
    pending.bodySummary = summary;
    return summary;
  }

  function worldTimeText(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }

  function weatherText(weather) {
    return `${weather.label} · ${weather.rain.toFixed(1)} mm/h · ${weather.temperature.toFixed(1)} ℃ · ${weather.daylight ? '白昼' : '夜间'}`;
  }

  function reportField(parent, label, value) {
    if (!String(value || '').trim()) return;
    const item = document.createElement('div');
    const heading = document.createElement('strong');
    const text = document.createElement('p');
    item.className = 'eventReportField';
    heading.textContent = label;
    text.textContent = String(value);
    item.append(heading, text);
    parent.append(item);
  }

  function renderEventReportPanel(active, statusText) {
    const list = el('eventReportList');
    const reports = active?.eventReports || [];
    list.replaceChildren();
    if (active?.pendingEventReport) {
      const pending = document.createElement('article');
      const heading = document.createElement('h3');
      const message = document.createElement('p');
      pending.className = 'eventReportPending';
      heading.textContent = `第 ${active.pendingEventReport.context.round} 轮 · 报告与结算`;
      message.textContent = active.pendingEventReport.error
        ? `本轮 Agent 结果已提交，报告/结算待完成：${active.pendingEventReport.error}`
        : '本轮 Agent 结果已提交，正在生成逐项时间线报告并准备结算。';
      pending.append(heading, message);
      if (active.pendingEventReport.error && !active.pendingEventReport.plan && !busy) {
        pending.append(manualEventPlanEditor(active));
      }
      list.append(pending);
    }
    if (!reports.length && !active?.pendingEventReport) {
      const empty = document.createElement('p');
      empty.className = 'eventReportEmpty';
      empty.textContent = '还没有事件记录。';
      list.append(empty);
    }
    for (const report of [...reports].reverse()) {
      const card = document.createElement('article');
      const heading = document.createElement('h3');
      const result = document.createElement('p');
      const location = document.createElement('p');
      card.className = 'eventReportCard';
      heading.textContent = `第 ${report.round} 轮 · ${report.title}`;
      result.className = 'eventReportOutcome';
      result.textContent = report.resultText;
      card.append(heading, result);
      if (report.point) {
        location.className = 'eventReportLocation';
        location.textContent = `${report.point.name} · ${report.point.zone} · E ${report.point.east_m.toFixed(1)} m / N ${report.point.north_m.toFixed(1)} m`;
        card.append(location);
      }
      if (report.steps?.length) {
        const timeline = document.createElement('ol');
        timeline.className = 'eventTimeline';
        for (const step of report.steps) {
          const item = document.createElement('li');
          const title = document.createElement('strong');
          const resultText = document.createElement('p');
          const assumption = document.createElement('p');
          const settlement = document.createElement('p');
          title.textContent = `${step.timeLabel} · ${step.activity}`;
          resultText.className = 'eventTimelineResult';
          resultText.textContent = `耗时 ${step.durationMinutes} 分钟 · 成功率推算 ${step.probability}% · 种子抽样 ${step.randomDraw.toFixed(2)}%（${step.sampledSuccess ? '抽样成功' : '抽样未中'}）${step.sampledSuccess !== step.success ? ' · 实际规则复核后未完成' : ''}：${step.resultText}`;
          assumption.className = 'eventTimelineAssumption';
          assumption.textContent = `推算依据：${step.assumption}`;
          settlement.className = 'eventTimelineSettlement';
          const locationText = step.point ? `点位：${step.point.name} · ${step.point.zone}。` : '';
          settlement.textContent = `${locationText}${step.startTime}—${step.endTime}；${step.weatherStart} → ${step.weatherEnd}。状态落账：${step.settlementText}`;
          item.append(title, resultText, assumption, settlement);
          if (step.sceneBefore || step.sceneAfter) {
            const scenes = document.createElement('details');
            const summary = document.createElement('summary');
            const before = document.createElement('p');
            const after = document.createElement('p');
            scenes.className = 'eventTimelineScenes';
            summary.textContent = '查看活动前后景象';
            before.textContent = `开始前：${step.sceneBefore || '没有对应的文字场景记录。'}`;
            after.textContent = `结束后：${step.sceneAfter || '没有对应的文字场景记录。'}`;
            scenes.append(summary, before, after);
            item.append(scenes);
          }
          timeline.append(item);
        }
        card.append(timeline);
      }
      reportField(card, '点位依据', report.pointReason);
      reportField(card, 'AI 事件报告', report.humanSummary);
      reportField(card, '人体 Agent 感受', report.bodySummary);
      reportField(card, '报告整理', report.recoveryNote);
      reportField(card, '本轮状态结算', report.settlementSummary);
      reportField(card, '事件前看到的景象', report.beforeScene);
      reportField(card, '事件后看到的景象', report.afterScene);
      reportField(card, '岛屿变化', report.islandSummary);
      list.append(card);
    }
    const previewMarkers = (active?.pendingEventReport?.plan?.steps || []).flatMap(step => {
      const point = active.pendingEventReport.context.event_candidates.find(candidate => candidate.id === step.point_id);
      return point ? [{ ...point, round: active.pendingEventReport.context.round, title: `待结算 · ${step.time_label} ${step.activity}` }] : [];
    });
    const mapRound = active?.mapRound ?? active?.round;
    const markers = [...(active?.eventMarkers || []), ...previewMarkers].filter(marker => marker.round === mapRound);
    G.IslandApp?.setEventMarkers(markers);
    el('eventMapCount').textContent = `${markers.length} 个点位${previewMarkers.length ? '（含待结算）' : ''}`;
    el('eventReportStatus').textContent = statusText || (active?.pendingEventReport?.error
      ? '等待重试本轮报告与结算。'
      : reports.length ? `已整理 ${reports.length} 轮事件记录。` : '完成一轮推理后，这里会生成简要事件报告。');
    el('retryEventReport').hidden = !(active?.pendingEventReport && !busy);
  }

  function clearEventReportPanel(message) {
    G.IslandApp?.setEventMarkers([]);
    el('eventMapCount').textContent = '0 个点位';
    el('eventReportList').replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'eventReportEmpty';
    empty.textContent = '还没有事件记录。';
    el('eventReportList').append(empty);
    el('eventReportStatus').textContent = message || '完成一轮推理后，这里会生成简要事件报告。';
    el('retryEventReport').hidden = true;
  }

  async function continueEventReport(settings, active) {
    const pending = active.pendingEventReport;
    pending.error = '';
    renderEventReportPanel(active, '正在整理本轮点位与事件报告……');
    try {
      if (!pending.plan) {
        let plan;
        let firstPlanError;
        try {
          const response = await requestCompletion(settings, [
          { role: 'system', content: '你是本轮行动时间线模拟器与报告规划器。必须结合研究者输入、全部 Agent 本轮输出、现有地图资源、天气、潮位、当前时刻、已提交参数变化和随身物品，生成完整、连贯、具体的行动时间线。只输出 JSON：{"title":"...","summary":"...","steps":[{"time_label":"06:00","start_offset_minutes":0,"duration_minutes":30,"activity":"...","point_id":"site:191或null","resource_id":"R05或null","probability_percent":35,"success_result":"...","failure_result":"...","assumption":"...","point_reason":"..."}]}。用户给出时间表时，每项都必须出现在 steps 中，不能只挑一个代表事件；未给出的时长、地点、成功概率和细节按已知数据作合理模拟估计，并写明依据/假设。数据不足时仍给出最合理的情境估计，不得因此把活动删掉或说整轮未开始；不要把估计说成实测。成功率为0至100整数，网页会用实验种子逐项抽样。每步 duration_minutes 是正的15分钟整数倍；start_offset_minutes 是相对当前模拟时刻的分钟偏移，所有步骤顺序排列且不得重叠，时间间隔也会计入总耗时。用户给出明确时刻时，应按当前世界时钟把 start_offset_minutes 换算到对应时刻，跨午夜按顺序进入下一日；time_label 保留输入中的时刻。每项都写清成功与未成功会发生什么。point_id 必须来自 event_candidates，也可为null；只有要采集某个已列入点位的资源时才填对应 resource_id，且点位必须有该资源。W01/W02 只在 water_sources 对应候选中出现，取水必须检查随身物品是否有容器，W01 是原水；R08 鸟类只观察不捕猎，R04 山羊活动区仅用于观察而非直接采集。对于生火、休息、观察等不改变库存的活动，照样给出耗时、场景和概率，resource_id 设null。对不能由岛屿规则直接落账的结果，仍报告模拟抽样结果，并明确该估计不改写岛屿库存。除了没有任何活动任务的纯讨论外，steps 不得为空。不要输出 Markdown。' },
          { role: 'user', content: JSON.stringify(pending.context) }
          ], null, null, 'event_report_plan');
          plan = parseModelJson(response.content, '点位判断');
          validateEventPlan(plan, pending.context);
          if (!plan.steps.length && pending.context.researcher_prompt.trim()) throw new Error("需要复核有任务时返回的空时间线。");
        } catch (error) {
          firstPlanError = error.message || String(error);
          try {
            const response = await requestCompletion(settings, [
              { role: 'system', content: '将研究者要求和求生者的行动方案转成可以立即执行的岛屿模拟时间线。只输出 JSON 对象 {"steps":[["时段",开始偏移分钟,耗时分钟,"动作","候选点位ID或null","资源ID或null",成功率整数,"成功结果","失败结果","推算依据"]]}，缺省 ID 写 JSON null。不输出解释或 Markdown，结果和依据各用一句短语。保留明确给出的全部时段。偏移和耗时按15分钟步长，按序且不重叠。未给时长或环境数据时使用世界快照作合理估计。地点只选候选，原地用 observer；资源仅限该点已有且可实际采集的库存。无容器不可取水，鸟与山羊只观察。无库存规则的动作也应安排时长和地点，但资源填 null。明确行动任务不得返回空步骤；纯讨论时返回空 steps，并写 no_action_reason 解释为何无需行动。' },
              { role: 'user', content: JSON.stringify(compactEventPlanContext(pending.context)) }
            ], null, null, 'event_plan_compact', { singleResponse: true });
            const compact = parseModelJson(response.content, '精简行动计划');
            if (!Array.isArray(compact.steps)) throw new Error('精简行动计划缺少步骤。');
            if (!compact.steps.length && !String(compact.no_action_reason || "").trim()) throw new Error("空时间线缺少无需行动的理由。");
            plan = {
              title: '本轮行动时间线',
              steps: compact.steps.map(step => {
                if (!Array.isArray(step) || step.length !== 10) throw new Error('精简行动步骤字段不完整。');
                const [time_label, start_offset_minutes, duration_minutes, activity, point_id,
                  resource_id, probability_percent, success_result, failure_result, assumption] = step;
                return { time_label, start_offset_minutes, duration_minutes, activity, point_id,
                  resource_id, probability_percent, success_result, failure_result, assumption };
              })
            };
            validateEventPlan(plan, pending.context);
          } catch (retryError) {
            try {
              plan = await recoverEventPlanRows(settings, pending.context);
              validateEventPlan(plan, pending.context);
            } catch (rowError) {
              pending.planRecoveryError = [firstPlanError, retryError.message, rowError.message].join(" / ");
              throw new Error('模型未返回完整行动步骤，本轮尚未结算。可重试本轮，无需重新运行 Agent。');
            }
          }
        }
        if (!Array.isArray(plan.steps)) throw new Error('行动时间线没有返回 steps 列表，请重试报告。');
        const maxMinutes = 24 * 366 * 5 * 60;
        let previousEnd = 0;
        const candidates = new Map(pending.context.event_candidates.map(candidate => [candidate.id, candidate]));
        for (const [index, step] of plan.steps.entries()) {
          if (!step || typeof step !== 'object') throw new Error(`第 ${index + 1} 个行动时段格式无效。`);
          if (!Number.isInteger(step.start_offset_minutes) || step.start_offset_minutes < previousEnd || step.start_offset_minutes % 15) throw new Error(`第 ${index + 1} 个行动时段的开始时间无效或与前项重叠。`);
          if (!Number.isInteger(step.duration_minutes) || step.duration_minutes < 15 || step.duration_minutes % 15) throw new Error(`第 ${index + 1} 个行动时段的耗时必须为15分钟的正整数倍。`);
          previousEnd = step.start_offset_minutes + step.duration_minutes;
          if (previousEnd > maxMinutes) throw new Error('本轮行动时间线超过岛屿时钟可结算范围。');
          if (!String(step.time_label || '').trim() || !String(step.activity || '').trim() || !String(step.assumption || '').trim()) throw new Error(`第 ${index + 1} 个行动时段缺少时间、行动或推算依据。`);
          if (!Number.isInteger(step.probability_percent) || step.probability_percent < 0 || step.probability_percent > 100) throw new Error(`第 ${index + 1} 个行动时段的成功率必须是0至100的整数。`);
          if (!String(step.success_result || '').trim() || !String(step.failure_result || '').trim()) throw new Error(`第 ${index + 1} 个行动时段缺少成功或未成功结果。`);
          if (step.point_id !== null && step.point_id !== undefined && !candidates.has(step.point_id)) throw new Error(`第 ${index + 1} 个行动时段引用了地图候选列表外的点位。`);
          if (step.resource_id !== null && step.resource_id !== undefined && typeof step.resource_id !== 'string') throw new Error(`第 ${index + 1} 个行动时段的资源标识无效。`);
        }
        for (const [index, step] of plan.steps.entries()) {
          const requested = step.point_id ? candidates.get(step.point_id) : null;
          let suitable = [...candidates.values()].filter(candidate => {
            if (candidate.id === 'observer') return false;
            if (step.resource_id) return candidate.resources.some(resource => resource.resource === step.resource_id);
            return requested && candidate.zone === requested.zone;
          });
          if (suitable.length) {
            suitable.sort((a, b) => a.distance_m - b.distance_m);
            suitable = suitable.slice(0, 6);
            const draw = M.rnd(pending.context.world.seed, `point:${pending.context.round}:${index}:${step.activity}`);
            const selected = suitable[Math.floor(draw * suitable.length)];
            step.point_id = selected.id;
            step.point_reason = `${step.point_reason || ''} 按实验种子从同资源或同区域的近邻候选中抽取 ${selected.id}。`;
          } else if (!step.point_id) step.point_id = 'observer';
        }
        pending.plan = plan;
      }

      const plan = pending.plan;
      // A planned location is a preview, not a committed resource change.
      const previews = plan.steps.flatMap(step => {
        const point = pending.context.event_candidates.find(candidate => candidate.id === step.point_id);
        return point ? [{ ...point, round: pending.context.round, title: `待结算 · ${step.time_label} ${step.activity}` }] : [];
      });
      G.IslandApp?.setEventMarkers(previews);
      el('eventMapCount').textContent = `${previews.length} 个点位${previews.length ? '（待结算）' : ''}`;
      const settlement = plan.steps.length ? prepareTimelineSettlement(active, pending) : null;
      const noActivitySettlement = pending.planRecoveryNote
        ? '行动计划没有形成可结算数据；本轮仅整理已提交的研究者输入与 Agent 推理，岛屿时间和资源保持不变。'
        : '本轮没有安排行动时段；已整理研究者输入与 Agent 推理，岛屿时间和资源未变化。';

      if (!pending.narrative && !settings) {
        pending.narrative = fallbackEventNarrative(pending, plan, settlement, noActivitySettlement);
        pending.narrativeRecoveryNote = '按研究者确认的时间线和本地结算记录整理。';
      }
      if (!pending.narrative) {
        const resultContext = {
          round: pending.context.round,
          researcher_prompt: pending.context.researcher_prompt,
          agents: pending.context.agent_outputs,
          timeline_plan: plan.steps,
          timeline_results: settlement?.steps || [],
          state_settlement: settlement?.summary || noActivitySettlement,
          plan_recovery_note: pending.planRecoveryNote || '',
          scene_before_evidence: pending.context.current_scene,
          scene_after_evidence: settlement && M.observe ? M.observe(settlement.world, settlement.position)?.role || '' : pending.context.current_scene,
          island_agent_changes: pending.context.state_changes
        };
        try {
          const response = await requestCompletion(settings, [
          { role: 'system', content: '你是研究者的模拟结果记录助手。请基于输入，为本轮写一份准确、具体、易读的中文事件报告。报告格式由你根据本轮内容决定：可以用自然段、叙事、小标题或简短列表；不必套固定框架、固定字段或预设顺序，也不要为了填栏目重复信息。可自由叙述，优先突出本轮关键发现与结果；小标题用纯文本，不加 Markdown 标记。把研究者任务、所有 Agent 已提交的关键推理、实际执行的行动与抽样结果、行动前后景象，以及天气/资源/岛屿状态的实际变化自然地组织起来。人体感受由单独的简报呈现；如需提及求生者状态，只作简短的人话描述，不列参数名称、数值、单位或参数变化清单。先抓住本轮最有意义的事情，避免机械罗列。仅在运行记录明确标记截断时才可称回复截断，不得从文字长短推断。没有行动时，说明已保存的推理内容和未完成的部分；绝不能把未确认行动写成已发生，也不能虚构成功率、时长、体征数值、资源变化或天气变化。估计可用于模拟叙述，但要与已提交参数和结算事实区分，不能伪称实地观测或实测值。不要捏造体征数值或医学结论；取到物品不等于已经进食或饮水。报告只显示在本轮报告，不写回 Agent 状态或下一轮输入。直接输出纯文本报告，不输出 JSON、Markdown 标记或解释写作过程。' },
          { role: 'user', content: JSON.stringify(resultContext) }
          ], null, null, 'event_report_summary');
          pending.narrative = parseFlexibleNarrative(response.content, '事件简报');
        } catch (error) {
          pending.narrative = fallbackEventNarrative(pending, plan, settlement, noActivitySettlement);
          pending.narrativeRecoveryNote = pending.narrative.recovery_note;
          pending.narrativeRecoveryError = error.message || String(error);
        }
      }

      let bodySummary = String(pending.narrative.body_summary || '').trim();
      if (!bodySummary && !settings) bodySummary = fallbackBodySummary(pending, settlement);
      if (!bodySummary && settings) {
        try {
          bodySummary = await generateBodySummary(settings, pending, settlement?.summary || noActivitySettlement);
        } catch (error) {
          bodySummary = fallbackBodySummary(pending, settlement);
          pending.narrativeRecoveryNote ||= '人体感受简报没有完整返回，已依据求生者状态和本轮行动记录整理。';
          pending.narrativeRecoveryError ||= error.message || String(error);
        }
      }
      if (settlement) prepareEventFrameworkSettlement(active, pending);
      const firstPointStep = settlement?.steps.find(step => step.point) || null;
      const firstCandidate = firstPointStep ? pending.context.event_candidates.find(candidate => candidate.id === firstPointStep.point.id) : null;
      const startTime = settlement ? settlement.steps[0].startTime : pending.context.world.time_text;
      const endTime = settlement ? settlement.steps[settlement.steps.length - 1].endTime : pending.context.world.time_text;
      const timelineResult = settlement
        ? `按时间线模拟并结算 ${settlement.steps.length} 个时段（${startTime}—${endTime}），岛屿时间推进 ${settlement.durationMinutes} 分钟。`
        : pending.planRecoveryNote
          ? '行动计划未能形成可结算时间线；报告依据已提交的输入与 Agent 推理整理，本轮时间和资源未推进。'
          : '本轮没有安排行动时段，报告汇总了研究者输入和 Agent 推理。';
      const report = {
        round: pending.context.round, title: String(plan.title || (settlement ? '本轮行动时间线' : '本轮讨论')).slice(0, 80),
        point: firstCandidate ? { name: firstCandidate.name, zone: firstCandidate.zone, east_m: firstCandidate.east_m, north_m: firstCandidate.north_m } : null,
        pointReason: firstPointStep?.pointReason || '',
        resultText: timelineResult,
        durationMinutes: settlement?.durationMinutes || 0,
        humanSummary: String(pending.narrative.human_summary || plan.summary || ''),
        bodySummary,
        recoveryNote: [pending.planRecoveryNote, pending.narrativeRecoveryNote].filter(Boolean).join('\n'),
        steps: settlement?.steps || [],
        beforeScene: String(pending.narrative.before_scene || settlement?.steps?.[0]?.sceneBefore || pending.context.current_scene || ''),
        afterScene: String(pending.narrative.after_scene || settlement?.steps?.[settlement.steps.length - 1]?.sceneAfter || settlement?.steps?.[0]?.sceneBefore || pending.context.current_scene || ''),
        islandSummary: [
          String(pending.narrative.island_summary || settlement?.summary || noActivitySettlement),
          settlement ? `整轮模拟时段 ${settlement.durationMinutes} 分钟（${startTime}—${endTime}）；每项活动的局地天气变化列在时间线中。` : ''
        ].filter(Boolean).join('\n'),
        settlementSummary: settlement?.summary || noActivitySettlement
      };
      if (settlement && !settlement.committed) {
        const settlementMessage = parameterizedSettlementMessage(settlement, pending);
        G.IslandApp.setWorldState(settlement.world, settlement.position);
        settlement.committed = true;
        active.frame = settlement.frame;
        active.frameworkCommandLog = [...active.frameworkCommandLog, ...settlement.commands.map(cloneJson)];
        active.inventory = settlement.inventory;
        active.previousRoundMessages = [
          ...active.previousRoundMessages,
          { kind: 'settlement_parameters', sender: '岛屿状态参数', text: settlementMessage }
        ];
      }
      if (settlement && !settlement.reportAdded) {
        active.eventReports.push(report);
        settlement.reportAdded = true;
      } else if (!settlement) {
        active.eventReports.push(report);
      }
      if (settlement && !settlement.markerAdded) {
        for (const step of settlement.steps) {
          if (!step.point) continue;
          const candidate = pending.context.event_candidates.find(item => item.id === step.point.id);
          if (candidate) active.eventMarkers.push({ ...candidate, round: pending.context.round, title: `${step.timeLabel} ${step.activity}` });
        }
        settlement.markerAdded = true;
      }
      active.pendingEventReport = null;
      renderFramework();
      setAgentStatus(settlement ? `第 ${pending.context.round} 轮已结算 · 模拟时间 +${settlement.durationMinutes} 分钟` : `第 ${pending.context.round} 轮报告已整理 · 本轮未推进岛屿状态`, 'ok');
      status(settlement ? `第 ${pending.context.round} 轮已结算：${settlement.summary}` : pending.planRecoveryNote
        ? `第 ${pending.context.round} 轮报告已整理；行动计划未形成可结算数据，岛屿时间和资源未变化。`
        : `第 ${pending.context.round} 轮报告已整理；没有安排行动时间线。`, 'ok');
      renderEventReportPanel(active, `第 ${pending.context.round} 轮报告与状态结算已完成${pending.planRecoveryNote || pending.narrativeRecoveryNote ? '；已根据可用记录整理报告' : ''}。`);
    } catch (error) {
      if (active.pendingEventReport !== pending) {
        renderEventReportPanel(active, `第 ${pending.context.round} 轮状态已提交；界面更新提示：${error.message || String(error)}`);
        return;
      }
      pending.error = error.message || String(error);
      renderEventReportPanel(active, '等待重试本轮报告与结算。');
    }
  }

  async function recoverEventPlanRows(settings, context) {
    const evidence = compactEventPlanContext(context);
    const response = await requestCompletion(settings, [
      { role: 'system', content: '把整个任务转为岛屿行动。每步只写一行，以 | 分隔：起始时刻HH:mm|距当前分钟|耗时分钟|动作|候选地点ID|采集资源ID或-|成功率整数|成功结果|失败结果|推算依据。所有明确时段都保留，按15分钟步长且不重叠。原地用 observer；仅能采集地点已有且允许采集的资源，缺条件或无法落账时资源写 -；无容器不可取水，鸟和山羊只能观察。未指定细节按当前世界作合理估计。最后独占一行写 END，别写其他说明。纯讨论才只写 NONE 和 END 两行。' },
      { role: 'user', content: JSON.stringify({
        task: context.researcher_prompt, world: context.world, inventory: context.carried_items,
        evidence: evidence.agent_outputs, candidates: evidence.event_candidates
      }) }
    ], null, null, 'event_plan_rows', { singleResponse: true });
    const rows = String(response.content || '').trim().split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    if (rows.pop() !== 'END' || !rows.length) throw new Error('行动清单缺少完整结束标记。');
    const steps = rows.length === 1 && rows[0] === 'NONE' ? [] : rows.map(row => {
      const fields = row.split('|').map(value => value.trim());
      if (fields.length !== 10 || fields.some(value => !value)) throw new Error('行动清单字段不完整。');
      const [time_label, offset, duration, activity, point_id, resource, probability,
        success_result, failure_result, assumption] = fields;
      return { time_label, start_offset_minutes: Number(offset), duration_minutes: Number(duration),
        activity, point_id, resource_id: resource === '-' ? null : resource,
        probability_percent: Number(probability), success_result, failure_result, assumption };
    });
    return { title: '本轮行动时间线', steps };
  }

  function manualEventPlanEditor(active) {
    const pending = active.pendingEventReport;
    const editor = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '手动确认时间线并结算';
    const label = document.createElement('label');
    label.textContent = '每行填「行动｜耗时（分钟，15 的倍数）｜点位编号」。原地可省略点位。';
    const input = document.createElement('textarea');
    input.rows = 4;
    input.placeholder = '观察营地｜15｜observer';
    input.value = pending.manualPlanDraft || '';
    input.addEventListener('input', () => { pending.manualPlanDraft = input.value; });
    label.append(input);
    const candidates = document.createElement('details');
    const candidateTitle = document.createElement('summary');
    candidateTitle.textContent = '查看可用点位编号';
    const candidateList = document.createElement('p');
    candidateList.textContent = pending.context.event_candidates.map(point => `${point.id} · ${point.name || '当前位置'}`).join(' / ');
    candidates.append(candidateTitle, candidateList);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '按此时间线结算';
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    button.onclick = async () => {
      if (busy || active.pendingEventReport !== pending) return;
      let offset = 0;
      try {
        const rows = input.value.split(/\r?\n/).filter(row => row.trim());
        if (!rows.length) throw new Error('请至少填写一项行动。');
        const steps = rows.map(row => {
          const fields = row.split(/[|｜]/).map(field => field.trim());
          if (fields.length < 2 || fields.length > 3) throw new Error('请按行动、耗时、点位的格式填写。');
          const [activity, duration, point = 'observer'] = fields;
          const duration_minutes = Number(duration);
          const step = {
            activity, duration_minutes, start_offset_minutes: offset, time_label: `+${offset} 分钟`,
            point_id: point || 'observer', resource_id: null, probability_percent: 100,
            success_result: '已推进研究者指定的行动时段，具体收获待核。',
            failure_result: '行动未完成。', assumption: '研究者确认模拟时段，仅结算时间和地点。'
          };
          offset += duration_minutes;
          return step;
        });
        const plan = { title: '研究者确认的行动时间线', steps };
        validateEventPlan(plan, pending.context);
        pending.plan = plan;
      } catch (error) {
        feedback.textContent = error.message;
        return;
      }
      setBusy(true);
      try {
        await continueEventReport(null, active);
      } finally {
        setBusy(false);
        updateAgentInteractionControls();
        renderEventReportPanel(active);
      }
    };
    editor.append(summary, label, candidates, button, feedback);
    return editor;
  }

  async function retryEventReport() {
    if (busy || !interactionSession?.pendingEventReport) return;
    let settings;
    try { settings = getSettings(); }
    catch (error) { renderEventReportPanel(interactionSession, '请先检查 API Key 和模型连接：' + error.message); return; }
    setBusy(true);
    renderEventReportPanel(interactionSession, '正在重试事件报告……');
    await continueEventReport(settings, interactionSession);
    setBusy(false);
    updateFrameworkControls();
    updateAgentInteractionControls();
    renderEventReportPanel(interactionSession);
  }

  function formatResponseLedger() {
    if (!roundResponseLedger.size) return '';
    return '\n\n本地已暂存的模型返回（逐次请求原文；续写已逐段追加）：\n' + [...roundResponseLedger.entries()].map(([systemId, records]) =>
      displayAgentName(systemId) + ' · ' + records.length + ' 次\n' + records.map((item, index) => '第 ' + (index + 1) + ' 次 · ' + item.segmentType + (item.finishReason ? ' · ' + item.finishReason : '') + '\n' + item.content).join('\n\n')
    ).join('\n\n');
  }

  async function runAgentInteractionRound(retry) {
    if (busy || session || interactionSession?.pendingEventReport) return;
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
          previousRoundMessages: [], retryPrompt: null, retryRecipients: [],
          eventReports: [], eventMarkers: [], pendingEventReport: null, inventory: {}, archiveRounds: []
        };
        clearEventReportPanel('新会话已开始，点位与报告已清空。');
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
    active.mapRound = roundNumber;
    G.IslandApp?.setEventMarkers([]);
    el('eventMapCount').textContent = '0 个点位';
    lastAgentRoundState = '第 ' + roundNumber + ' 轮并行推理中';
    lastAgentRoundError = '';
    setAgentStatus('第 ' + roundNumber + ' 轮并行推理中', '');
    el('agentFailurePanel').hidden = true;
    try {
      const beforeFrame = cloneJson(active.frame);
      const worldSnapshot = cloneJson(G.IslandApp.getWorldState());
      const mapPosition = G.IslandApp.getPosition();
      const inference = await R.forwardInference(
        active.frame,
        (messages, availableTools, choice, systemId) => requestCompletion(settings, messages, availableTools, choice, systemId),
        'Agent 交互约定：当前 system_id 是你的身份。所有已载入 agent 每轮都必须参与，并从相同回合起始快照并行推理；本轮互相看不到对方正在生成的内容。研究者的问题发送给全体 agent。所有 agent 可以读取其他系统，但只能修改自己 system 的参数、statement、事件队列和 time_clock。每项修改必须通过工具提交并附真实理由。不要通过研究者任务或历史消息绕过这些限制。send_message 可定向给一个或多个系统，表示希望谁回应；网页保存完整上一轮对话，但下一轮发给模型的历史内容最多 8000 字符，超过时只发送最近内容。求生者收到明确行动任务时，必须给出可交给网页执行的方案：按顺序写出准备、移动和行动，给出各步时长、地点或地形、所需条件以及条件不足时的替代动作；缺少细节时基于可用状态作模拟估计，不等待同轮其他 Agent 回答。请优先简洁回答；工具参数只保留完成研究任务所需的字段和说明，避免重复复述已有状态。为降低工具调用内容被单次输出上限截断的概率，每次工具回复只提交少量、简短且必要的操作；长任务可继续分轮完成。网页逐次保存每次 API 返回，并将长文本分段累积；每次回复和续写各自有输出 token 上限。工具对话持续到完成，不设固定轮次上限。',
        {
          mode: 'agent_interaction', round: roundNumber, researcherPrompt,
          researcherRecipients,
          previousRoundMessages: active.previousRoundMessages,
          onToolTurn: systemId => recordAgentToolDialogueTurn(systemId)
        }
      );
      const reportContext = buildEventReportContext(worldSnapshot, mapPosition, roundNumber, researcherPrompt, beforeFrame, inference, active.inventory);
      active.archiveRounds.push(cloneJson({ round: roundNumber, researcher_input: researcherPrompt, frame_before: beforeFrame, frame_after_agent: inference.frame, world_before: worldSnapshot, inference, model_responses: [...roundResponseLedger.entries()] }));
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
      active.pendingEventReport = {
        context: reportContext,
        worldSnapshot, plan: null, outcome: null, narrative: null, settlement: null, error: ''
      };
      active.retryPrompt = null;
      active.retryRecipients = [];
      appendAgentRound(roundNumber, researcherPrompt, inference);
      el('agentRoundCount').textContent = String(active.round);
      refreshBalance();
      renderFramework();
      setAgentStatus('第 ' + roundNumber + ' 轮已提交 · 等待事件状态结算', 'ok');
      status('Agent 第 ' + roundNumber + ' 轮已完成。所有状态变化均限于所属 system，并记录了理由。', 'ok');
      await continueEventReport(settings, active);
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
      renderEventReportPanel(interactionSession);
    }
  }

  function endAgentInteraction() {
    if (!interactionSession || busy) return;
    if (!confirm('结束并重置会话会清除本次 Agent 对话和状态修改；载入的原始 JSON 会保留。确定继续吗？')) return;
    interactionSession = null;
    clearEventReportPanel('会话已重置，点位与事件报告已清空。');
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
      clock.textContent = 'time_clock · ' + system.time_clock + ' 分钟（累计模拟时间）';
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
  el('retryEventReport').addEventListener('click', retryEventReport);
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
  function sanitizeReviewerText(value, limit = 1200) {
    let text = String(value ?? '');
    const key = el('aiApiKey').value.trim();
    if (key) text = text.split(key).join('[已隐藏]');
    return text
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
      .replace(/\b((?:api[-_ ]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\b\s*["']?\s*[:=]\s*["']?)[^\s"'`,;]+/gi, '$1[已隐藏]')
      .replace(/\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|mgk_[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,})\b/g, '[已隐藏]')
      .slice(0, limit);
  }

  function sampledReviewRounds(rounds, limit = 4) {
    if (rounds.length <= limit) return rounds;
    return Array.from({ length: limit }, (_, index) => rounds[Math.round(index * (rounds.length - 1) / (limit - 1))]);
  }

  function reviewerEvidenceForAgent(active, systemId) {
    const initialSystem = active.frameworkAnchor.systems.find(item => item.system_id === systemId);
    const currentSystem = active.frame.systems.find(item => item.system_id === systemId);
    const rule = String(initialSystem?.rule || '')
      .replace(/DATA_JSON_BEGIN[\s\S]*?DATA_JSON_END/g, '[本规则内嵌数据快照已省略]')
      .trim();
    const roundEvidence = active.archiveRounds.map(round => {
      const inference = round.inference || {};
      const result = (inference.results || []).find(item => item.systemId === systemId);
      if (!result) return null;
      const changes = (inference.commandLog || [])
        .filter(command => command.system_id === systemId && command.change)
        .filter(command => !/api.?key|token|secret|password|credential/i.test(String(command.change.field || '')))
        .slice(0, 5)
        .map(command => `${command.change.field || command.type}；理由：${sanitizeReviewerText(command.change.reason || '', 160)}`);
      const toolNames = [...new Set((result.toolTrace || []).map(item => String(item.name || '')).filter(Boolean))].slice(0, 10);
      return {
        round: round.round,
        researcherTask: sanitizeReviewerText(round.researcher_input || '（本轮未填写额外任务）', 260),
        agentOutput: sanitizeReviewerText(result.finalText || '（没有公开补充发言）', 1100),
        tools: toolNames,
        changes
      };
    }).filter(Boolean);
    const sampled = sampledReviewRounds(roundEvidence);
    const lines = [
      `实验已提交轮数：${active.archiveRounds.length}。以下是从本次归档中均匀选取的最多 ${sampled.length} 轮证据节选；外部质检时仍须检查完整 PDF。`,
      `Agent：${displayAgentName(systemId)}（${systemId}）`,
      `本 Agent 规则（已省略内嵌大型数据快照）：\n${sanitizeReviewerText(rule, 2600)}`,
      `当前 statement：${sanitizeReviewerText(currentSystem?.statement || '', 600)}`,
      '本次记录节选：'
    ];
    sampled.forEach(item => {
      lines.push(`第 ${item.round} 轮｜研究者输入：${item.researcherTask}\nAgent公开输出：${item.agentOutput}\n调用工具：${item.tools.join('、') || '无'}\n自身状态修改及理由：${item.changes.join('；') || '无'}`);
    });
    return lines.join('\n\n');
  }

  async function generateReviewerAgentPrompts(onProgress = () => {}) {
    const active = interactionSession;
    if (!active || !active.archiveRounds.length) throw new Error('请先完成至少一轮 Agent 推演，再生成本次专项质检提示词。');
    if (busy) throw new Error('当前还有实验请求正在处理；请等它完成后再生成质检提示词。');
    const settings = getSettings();
    const systems = active.frameworkAnchor.systems;
    const items = [];
    const omitted = [];
    const errors = [];
    setBusy(true);
    try {
      for (let index = 0; index < systems.length; index += 1) {
        const system = systems[index];
        const agentName = displayAgentName(system.system_id);
        onProgress({ completed: index, total: systems.length, agentName });
        const messages = [
          {
            role: 'system',
            content: '你正在代表本次实验中的一个 Agent 做事后复盘。只依据随附的本 Agent 规则节选、本次已提交轮次的公开发言、工具名称和自身状态修改记录，判断是否存在明确的困难、反思、不确定点、规则冲突或值得专项复核的问题。不要输出隐藏思维链，不要把没有出现的困难编造成事实。若没有具体、可由记录支持的复盘内容，必须返回 has_reflection=false。若有，请用简短自然中文概述依据，并写一段给外部质检员的专项提示词，要求其结合完整 PDF 和全局网站运作说明，针对本 Agent 的规则/工具使用/状态修改提出可执行的框架优化建议；提示词不能取代全局质检，也不能要求自动改代码。只返回包含 JSON 布尔值 has_reflection、字符串 reflection 和字符串 reviewer_prompt 的 JSON 对象；无反思时 reflection 与 reviewer_prompt 都为空字符串。'
          },
          { role: 'user', content: reviewerEvidenceForAgent(active, system.system_id) }
        ];
        try {
          const response = await requestCompletion(settings, messages, null, null, 'reviewer_reflection_' + system.system_id, { maxTokens: 650, continuationTokens: 650 });
          const parsed = parseModelJson(response.content, agentName + '专项复盘');
          const reflection = sanitizeReviewerText(parsed.reflection || '', 700).trim();
          const reviewerPrompt = sanitizeReviewerText(parsed.reviewer_prompt || '', 1800).trim();
          if (parsed.has_reflection === true && reflection && reviewerPrompt.length >= 30) {
            items.push({ systemId: system.system_id, agentName, reflection, reviewerPrompt });
          } else {
            omitted.push(agentName);
          }
        } catch (error) {
          errors.push(agentName);
        }
      }
    } finally {
      setBusy(false);
      updateFrameworkControls();
      updateAgentInteractionControls();
    }
    onProgress({ completed: systems.length, total: systems.length, agentName: '' });
    return { items, omitted, errors, roundCount: active.archiveRounds.length, agentCount: systems.length };
  }

  function getExperimentArchive() {
    if (!interactionSession) return null;
    const active = interactionSession;
    const archive = {
      parameter_units: Object.fromEntries([...new Set([active.frameworkAnchor, active.frame, ...active.archiveRounds.flatMap(round => [round.frame_before, round.frame_after_agent])].flatMap(frame => frame.systems.flatMap(system => system.parameters.map(parameter => parameter.param))))].map(code => [code, G.SITPParameterUnits.get(code)])),
      initial: active.frameworkAnchor,
      rounds: active.archiveRounds,
      reports: active.eventReports,
      current: { frame: active.frame, world: G.IslandApp.getWorldState(), inventory: active.inventory, commands: active.frameworkCommandLog, pending_report: active.pendingEventReport, failed_responses: active.retryPrompt !== null ? [...roundResponseLedger.entries()] : [] }
    };
    const key = el('aiApiKey').value.trim();
    function redact(value, name = '') {
      if (/api.?key|secret|password|credential/i.test(name)) return '[已隐藏]';
      if (Array.isArray(value)) return value.map(item => redact(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childName, child]) => [childName, redact(child, childName)]));
      return typeof value === 'string' && key ? value.split(key).join('[已隐藏]') : value;
    }
    return redact(archive);
  }
  G.SurvivalAgent = Object.freeze({ refreshAfterIslandRender, getMonitorSnapshot, getExperimentArchive, generateReviewerAgentPrompts });
  new MutationObserver(refreshAfterIslandRender).observe(el('nearby'), { childList: true });
})(globalThis);
