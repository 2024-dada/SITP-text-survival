(function (G) {
  'use strict';

  const MAX_SYSTEMS = 32;
  const MAX_RECENT_TOOL_TURNS = 4;
  const MAX_TOOL_RESULT_CHARS = 2400;
  const MAX_PREVIOUS_ROUND_CONTEXT_CHARS = 8000;

  function makeTool(name, description, properties, required) {
    return {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false }
      }
    };
  }

  const tools = [
    makeTool('list_systems', '列出框架内所有系统的编号、状态和参数名。', {}, []),
    makeTool('read_system', '读取一个系统在本轮开始时的完整状态。', {
      system_id: { type: 'string' }
    }, ['system_id']),
    makeTool('edit_parameters', '为当前负责的系统排队添加、修改或删除参数；修改会在本轮全体系统成功后应用。', {
      ops: { type: 'array', items: { type: 'object', properties: {
        op: { type: 'string', enum: ['add', 'change', 'remove'] },
        name: { type: 'string' },
        value: { type: 'number' }
      }, required: ['op', 'name', 'value'], additionalProperties: false } }
    }, ['ops']),
    makeTool('set_statement', '排队更新当前负责系统的一句话状态。', {
      statement: { type: 'string' }
    }, ['statement']),
    makeTool('deliver_event', '排队向另一个系统发送事件；该系统下一轮才会看到。', {
      target_system_id: { type: 'string' },
      event_description: { type: 'string' },
      delta_parameters: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' },
        value: { type: 'number' }
      }, required: ['name', 'value'], additionalProperties: false } }
    }, ['target_system_id', 'event_description', 'delta_parameters']),
    makeTool('consume_events', '排队清空当前负责系统已经处理的事件。', {}, []),
    makeTool('math_eval', '计算兼容 libmatheval 的表达式：数字、常数、变量、括号、+ - * / ^（也接受 **）及单变量初等函数。单个表达式最多240字符且不能换行；复杂计算拆成短表达式分步调用，不要把整批坐标写成一个长公式。', {
      expression: { type: 'string', description: '一个独立短表达式，最多240字符且不能换行。' },
      variables: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' },
        value: { type: 'number' }
      }, required: ['name', 'value'], additionalProperties: false } }
    }, ['expression', 'variables'])
  ];

  const interactionTools = [
    ...tools.filter(tool => ['list_systems', 'read_system', 'math_eval'].includes(tool.function.name)),
    makeTool('edit_parameters', '只修改当前负责系统自己的数值参数；每项修改都必须说明理由。修改会在本轮全体系统成功后应用。', {
      ops: { type: 'array', items: { type: 'object', properties: {
        op: { type: 'string', enum: ['add', 'change', 'remove'] },
        name: { type: 'string' },
        value: { type: 'number' },
        reason: { type: 'string' }
      }, required: ['op', 'name', 'value', 'reason'], additionalProperties: false } }
    }, ['ops']),
    makeTool('set_statement', '更新当前负责系统自己的 statement；必须说明为什么这样更新。', {
      statement: { type: 'string' }, reason: { type: 'string' }
    }, ['statement', 'reason']),
    makeTool('set_time_clock', '只更新当前负责系统自己的 time_clock 标注；不会推进岛屿时钟，必须说明为什么这样更新。', {
      value: { type: 'number' }, reason: { type: 'string' }
    }, ['value', 'reason']),
    makeTool('consume_events', '清空当前系统已经处理的事件；必须说明清理原因。', {
      reason: { type: 'string' }
    }, ['reason']),
    makeTool('send_message', '向一个或多个系统定向发送公开文本消息。收件对象表示希望谁回应，但不会停用其他系统；网页保存完整对话，下一轮发送给模型的历史内容受长度上限约束。此工具不会修改收件系统的参数。', {
      target_system_ids: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' }
    }, ['target_system_ids', 'message'])
  ];

  const INTERACTION_TOOL_GUIDANCE = '工具调用参数应保持简短。math_eval 的单个 expression 最多240字符且不能换行；不要把完整地图、整批数据或长坐标列表塞进一个公式。确需长计算时，拆成与问题直接相关的短计算，分多次工具往返完成；如果当前数据不支持精确结论，就说明未知，不要用过度计算补造结论。每次回复只提交少量必要工具调用，工具对话没有固定总轮数上限。';
  const A_GEOGRAPHY_GUIDANCE = '空间数据边界：fixed_scene_data.ring 是岛屿外边界，不是连续沙滩路线或可通行跑道。岸带网格标签也不能证明某段沙滩连续、无障碍且可跑。遇到“沿沙滩跑3公里”等问题，只有数据明确标出经核验路线和通行条件时才能判断；否则标注未知/待核，不得把整圈外边界周长当作跑道长度。';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function validate(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('框架必须是 JSON 对象。');
    if (typeof frame.name !== 'string' || !frame.name.trim()) throw new Error('框架 name 不能为空。');
    const params = frame.framework_param;
    if (!params || !Number.isFinite(params.time_delta) || params.time_delta < 0 || !Number.isFinite(params.real_time_delta) || params.real_time_delta < 0) {
      throw new Error('framework_param.time_delta 与 real_time_delta 必须是有限的非负数。');
    }
    if (!Array.isArray(frame.systems) || frame.systems.length < 1) throw new Error('框架至少要有一个系统。');
    if (frame.systems.length > MAX_SYSTEMS) throw new Error('网页最多同时运行32个系统，以控制并行模型请求数量。');

    const ids = new Set();
    for (const system of frame.systems) {
      if (!system || typeof system !== 'object' || Array.isArray(system)) throw new Error('系统条目必须是 JSON 对象。');
      if (typeof system.system_id !== 'string' || !system.system_id.trim()) throw new Error('system_id 不能为空。');
      if (ids.has(system.system_id)) throw new Error('system_id 重复：' + system.system_id + '。');
      ids.add(system.system_id);
      if (typeof system.rule !== 'string' || !system.rule.trim()) throw new Error(system.system_id + ' 的 rule 不能为空。');
      if (!Number.isFinite(system.time_clock)) throw new Error(system.system_id + ' 的 time_clock 必须是有限数值。');
      if (typeof system.statement !== 'string' || !system.statement.trim()) throw new Error(system.system_id + ' 的 statement 不能为空。');
      if (!Array.isArray(system.parameters)) throw new Error(system.system_id + ' 的 parameters 必须是数组。');
      if (!Array.isArray(system.events)) throw new Error(system.system_id + ' 的 events 必须是数组。');

      const names = new Set();
      for (const parameter of system.parameters) {
        if (!parameter || typeof parameter.param !== 'string' || !parameter.param.trim() || !Number.isFinite(parameter.value)) {
          throw new Error(system.system_id + ' 存在参数名为空或数值非法的项目。');
        }
        if (names.has(parameter.param)) throw new Error(system.system_id + ' 的参数名重复：' + parameter.param + '。');
        names.add(parameter.param);
      }

      for (const event of system.events) {
        if (!event || typeof event.event_description !== 'string' || !event.event_description.trim() || !Array.isArray(event.delta_parameters)) {
          throw new Error(system.system_id + ' 存在格式不完整的事件。');
        }
        for (const parameter of event.delta_parameters) {
          if (!parameter || typeof parameter.param !== 'string' || !parameter.param.trim() || !Number.isFinite(parameter.value)) {
            throw new Error(system.system_id + ' 的事件参数名或数值非法。');
          }
        }
      }
    }
    return true;
  }

  function normalize(frame) {
    validate(frame);
    return {
      name: frame.name.trim(),
      framework_param: {
        time_delta: frame.framework_param.time_delta,
        real_time_delta: frame.framework_param.real_time_delta
      },
      systems: frame.systems.map(system => ({
        system_id: system.system_id,
        rule: system.rule,
        time_clock: system.time_clock,
        parameters: system.parameters.map(parameter => ({ param: parameter.param, value: parameter.value })),
        statement: system.statement,
        events: system.events.map(event => ({
          event_description: event.event_description,
          delta_parameters: event.delta_parameters.map(parameter => ({ param: parameter.param, value: parameter.value }))
        }))
      }))
    };
  }

  function systemState(frame, system) {
    return {
      system_id: system.system_id,
      framework_param: { time_delta: frame.framework_param.time_delta },
      time_clock: system.time_clock,
      parameters: system.parameters,
      statement: system.statement,
      events: system.events
    };
  }

  function evaluateMath(expression, variables) {
    if (typeof expression !== 'string' || expression.length > 240 || /[\r\n]/.test(expression) || !Array.isArray(variables)) throw new Error('math_eval输入格式不合法（表达式最多240字符且不能换行）；请拆分为短计算，不要合并大量点位。');
    const values = new Map(variables.map(item => {
      if (!item || typeof item.name !== 'string' || !item.name || !Number.isFinite(item.value)) throw new Error('math_eval变量名或数值不合法。');
      return [item.name, item.value];
    }));
    const constants = new Map([
      ['e', Math.E], ['log2e', Math.LOG2E], ['log10e', Math.LOG10E], ['ln2', Math.LN2],
      ['ln10', Math.LN10], ['pi', Math.PI], ['pi_2', Math.PI / 2], ['pi_4', Math.PI / 4],
      ['1_pi', 1 / Math.PI], ['2_pi', 2 / Math.PI], ['2_sqrtpi', 2 / Math.sqrt(Math.PI)],
      ['sqrt', Math.SQRT2], ['sqrt1_2', Math.SQRT1_2]
    ]);
    const erf = value => {
      if (!Number.isFinite(value)) return Math.sign(value);
      const sign = value < 0 ? -1 : 1;
      const x = Math.abs(value);
      const t = 1 / (1 + 0.3275911 * x);
      // JavaScript has no built-in erf; use the standard 5-term approximation.
      const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
      return sign * (1 - polynomial * Math.exp(-x * x));
    };
    const functions = new Map([
      ['exp', Math.exp], ['log', Math.log], ['sqrt', Math.sqrt], ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan],
      ['cot', value => 1 / Math.tan(value)], ['sec', value => 1 / Math.cos(value)], ['csc', value => 1 / Math.sin(value)],
      ['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan],
      ['acot', value => value >= 0 ? Math.atan(1 / value) : Math.atan(1 / value) + Math.PI],
      ['asec', value => Math.acos(1 / value)], ['acsc', value => Math.asin(1 / value)],
      ['sinh', Math.sinh], ['cosh', Math.cosh], ['tanh', Math.tanh],
      ['coth', value => 1 / Math.tanh(value)], ['sech', value => 1 / Math.cosh(value)], ['csch', value => 1 / Math.sinh(value)],
      ['asinh', Math.asinh], ['acosh', Math.acosh], ['atanh', Math.atanh],
      ['acoth', value => Math.atanh(1 / value)], ['asech', value => Math.acosh(1 / value)], ['acsch', value => Math.asinh(1 / value)],
      ['abs', Math.abs], ['step', value => value >= 0 ? 1 : 0],
      ['delta', value => value === 0 ? Infinity : 0], ['nandelta', value => value === 0 ? NaN : 0], ['erf', erf]
    ]);
    const tokens = [];
    const pattern = /\s*(?:(1_pi|2_pi|2_sqrtpi)|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[()+\-*/^]))/gy;
    let index = 0;
    while (index < expression.length) {
      if (!expression.slice(index).trim()) break;
      pattern.lastIndex = index;
      const match = pattern.exec(expression);
      if (!match || match.index !== index) throw new Error('math_eval表达式含不支持的字符；请使用数字、libmatheval常数/函数、变量、括号及 + - * / ^。');
      tokens.push(match[1] || match[2] || match[3] || match[4]);
      index = pattern.lastIndex;
    }
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = () => tokens[cursor++];
    function primary() {
      const token = take();
      if (token === '(') {
        const value = sum();
        if (take() !== ')') throw new Error('math_eval括号不匹配。');
        return value;
      }
      if (token === undefined) throw new Error('math_eval表达式不完整。');
      if (functions.has(token) && peek() === '(') {
        take();
        const value = sum();
        if (take() !== ')') throw new Error('math_eval函数括号不匹配。');
        return functions.get(token)(value);
      }
      if (constants.has(token)) return constants.get(token);
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

  function parseArguments(call) {
    if (!call || !call.function || typeof call.function.arguments !== 'string') throw new Error('工具调用参数缺失。');
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new Error('工具参数不是合法 JSON。'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象。');
    return args;
  }

  function pendingParameterNames(snapshotSystem, operations) {
    const names = new Set(snapshotSystem.parameters.map(parameter => parameter.param));
    for (const operation of operations) {
      if (operation.type !== 'edit_parameter') continue;
      if (operation.op === 'add') names.add(operation.name);
      else if (operation.op === 'remove') names.delete(operation.name);
    }
    return names;
  }

  function executeTool(snapshot, self, operations, name, args, availableTools, requireReasons) {
    if (!availableTools.some(tool => tool.function.name === name)) throw new Error('当前模式不支持工具 ' + String(name) + '。');
    const systems = snapshot.systems;
    const findSystem = id => systems.find(system => system.system_id === id);
    if (name === 'list_systems') return { ok: true, systems: systems.map(system => ({
      system_id: system.system_id,
      statement: system.statement,
      parameters: system.parameters.map(parameter => parameter.param)
    })) };
    if (name === 'read_system') {
      if (typeof args.system_id !== 'string') throw new Error('read_system.system_id 必须是文本。');
      const system = findSystem(args.system_id);
      if (!system) throw new Error('不存在系统 ' + args.system_id + '。');
      return { ok: true, ...clone(systemState(snapshot, system)) };
    }
    if (name === 'edit_parameters') {
      if (!Array.isArray(args.ops)) throw new Error('edit_parameters.ops 必须是数组。');
      const known = pendingParameterNames(self, operations);
      const queued = [];
      let ignored = 0;
      for (const operation of args.ops) {
        if (!operation || !['add', 'change', 'remove'].includes(operation.op) || typeof operation.name !== 'string' || !operation.name.trim() || !Number.isFinite(operation.value)) {
          throw new Error('edit_parameters 中存在不合法操作、参数名或数值。');
        }
        if (requireReasons && (typeof operation.reason !== 'string' || !operation.reason.trim())) throw new Error('每项 edit_parameters 修改都必须填写 reason。');
        if (operation.op === 'change' && !known.has(operation.name)) { ignored += 1; continue; }
        if (operation.op === 'remove' && !known.has(operation.name)) { ignored += 1; continue; }
        queued.push({ type: 'edit_parameter', op: operation.op, name: operation.name, value: operation.value, reason: requireReasons ? operation.reason.trim() : undefined });
        if (operation.op === 'add') known.add(operation.name);
        if (operation.op === 'remove') known.delete(operation.name);
      }
      operations.push(...queued);
      return { ok: true, queued: queued.length, ignored };
    }
    if (name === 'set_statement') {
      if (typeof args.statement !== 'string' || !args.statement.trim()) throw new Error('set_statement 需要非空的状态说明。');
      if (requireReasons && (typeof args.reason !== 'string' || !args.reason.trim())) throw new Error('set_statement 必须填写 reason。');
      operations.push({ type: 'set_statement', statement: args.statement.trim(), reason: requireReasons ? args.reason.trim() : undefined });
      return { ok: true, queued: true };
    }
    if (name === 'set_time_clock') {
      if (!Number.isFinite(args.value)) throw new Error('set_time_clock.value 必须是有限数值。');
      if (requireReasons && (typeof args.reason !== 'string' || !args.reason.trim())) throw new Error('set_time_clock 必须填写 reason。');
      operations.push({ type: 'set_time_clock', value: args.value, reason: requireReasons ? args.reason.trim() : undefined });
      return { ok: true, queued: true, island_clock_unchanged: true };
    }
    if (name === 'deliver_event') {
      if (typeof args.target_system_id !== 'string') throw new Error('deliver_event.target_system_id 必须是文本。');
      const target = findSystem(args.target_system_id);
      if (!target) throw new Error('deliver_event 目标不存在：' + args.target_system_id + '。');
      if (target.system_id === self.system_id) throw new Error('deliver_event 只能发送给其他系统。');
      if (typeof args.event_description !== 'string' || !args.event_description.trim() || !Array.isArray(args.delta_parameters)) {
        throw new Error('deliver_event 描述或参数格式不合法。');
      }
      const delta = args.delta_parameters.map(parameter => {
        if (!parameter || typeof parameter.name !== 'string' || !parameter.name.trim() || !Number.isFinite(parameter.value)) throw new Error('事件参数名不能为空且数值必须有限。');
        return { param: parameter.name, value: parameter.value };
      });
      operations.push({
        type: 'deliver_event', target_system_id: target.system_id,
        event: { event_description: args.event_description.trim(), delta_parameters: delta }
      });
      return { ok: true, queued: true, visible_next_round: true };
    }
    if (name === 'consume_events') {
      if (requireReasons && (typeof args.reason !== 'string' || !args.reason.trim())) throw new Error('consume_events 必须填写 reason。');
      operations.push({ type: 'consume_events', reason: requireReasons ? args.reason.trim() : undefined });
      return { ok: true, queued: true };
    }
    if (name === 'send_message') {
      if (!Array.isArray(args.target_system_ids) || !args.target_system_ids.length || typeof args.message !== 'string' || !args.message.trim()) {
        throw new Error('send_message 需要一个或多个收件系统和非空消息。');
      }
      const targets = [...new Set(args.target_system_ids)];
      if (targets.length !== args.target_system_ids.length) throw new Error('send_message 收件系统不能重复。');
      for (const id of targets) {
        if (typeof id !== 'string' || !findSystem(id)) throw new Error('send_message 目标系统不存在：' + String(id) + '。');
        if (id === self.system_id) throw new Error('send_message 只能发给其他系统。');
      }
      operations.push({ type: 'send_message', target_system_ids: targets, message: args.message.trim() });
      return { ok: true, queued: true, visible_next_round: true, visible_to_all_agents: true };
    }
    if (name === 'math_eval') return { ok: true, value: evaluateMath(args.expression, args.variables) };
    throw new Error('不支持的工具：' + String(name));
  }

  function systemPrompt(system, suffix, interactionMode) {
    const additions = [suffix];
    if (interactionMode) {
      additions.push(INTERACTION_TOOL_GUIDANCE);
      if (system.system_id === 'A_geography_observation') additions.push(A_GEOGRAPHY_GUIDANCE);
    }
    return [system.rule, ...additions].filter(value => typeof value === 'string' && value.trim()).join('\n\n');
  }

  function shortenContextText(value, maxChars) {
    if (value.length <= maxChars) return value;
    const marker = '\n…中间内容已省略…\n';
    const contentChars = Math.max(0, maxChars - marker.length);
    const headChars = Math.ceil(contentChars * 0.6);
    const tailChars = contentChars - headChars;
    return value.slice(0, headChars) + marker + (tailChars ? value.slice(-tailChars) : '');
  }

  function compactPreviousRoundMessages(messages) {
    const compact = messages.map(message => {
      const item = { kind: message.kind, sender: message.sender };
      if (Array.isArray(message.recipients)) item.recipients = message.recipients;
      if (typeof message.text === 'string') item.text = message.text;
      if (message.kind === 'state_change') {
        item.field = message.field;
        item.before = message.before;
        item.after = message.after;
        item.reason = message.reason || '';
      }
      return item;
    });
    if (compact.reduce((sum, item) => sum + JSON.stringify(item).length, 0) <= MAX_PREVIOUS_ROUND_CONTEXT_CHARS) return compact;

    const note = { kind: 'context_note', sender: '网页', text: '完整上一轮对话保存在本地会话；为控制请求长度，本次仅发送最近内容。' };
    let remaining = MAX_PREVIOUS_ROUND_CONTEXT_CHARS - JSON.stringify(note).length;
    const recent = [];
    for (let index = compact.length - 1; index >= 0 && remaining > 0; index -= 1) {
      let item = compact[index];
      let serialized = JSON.stringify(item);
      if (serialized.length > remaining && typeof item.text === 'string') {
        const fixedChars = serialized.length - item.text.length;
        const textBudget = remaining - fixedChars;
        if (textBudget < 48) continue;
        item = { ...item, text: shortenContextText(item.text, textBudget) };
        serialized = JSON.stringify(item);
      }
      if (serialized.length > remaining) continue;
      recent.unshift(item);
      remaining -= serialized.length;
    }
    return [note, ...recent];
  }

  function compactToolMessage(message) {
    if (message.role !== 'tool' || typeof message.content !== 'string' || message.content.length <= MAX_TOOL_RESULT_CHARS) return message;
    const headChars = 1600;
    const tailChars = 420;
    return {
      ...message,
      content: JSON.stringify({
        truncated_for_model: true,
        note: '完整工具结果保存在本地工具记录中；需要具体字段时请重新读取。',
        preview_start: message.content.slice(0, headChars),
        omitted_characters: message.content.length - headChars - tailChars,
        preview_end: message.content.slice(-tailChars)
      })
    };
  }

  function summarizeOperation(operation) {
    const type = operation && operation.type || 'unknown';
    if (type === 'edit_parameter') return `${type} ${operation.name}=${String(operation.value).slice(0, 80)}`;
    if (type === 'send_message') return `${type} -> ${(operation.target_system_ids || []).join(',')} (${String(operation.message || '').slice(0, 80)})`;
    if (type === 'deliver_event') return `${type} -> ${operation.target_system_id} (${String(operation.event && operation.event.event_description || '').slice(0, 80)})`;
    if (type === 'set_statement') return `${type} (${String(operation.statement || '').slice(0, 80)})`;
    return type;
  }

  function requestMessagesForSystem(baseMessages, toolTurns, toolTrace, operations) {
    const recentTurns = toolTurns.slice(-MAX_RECENT_TOOL_TURNS);
    const recentCallCount = recentTurns.reduce((sum, turn) => sum + turn.callCount, 0);
    const olderCallCount = Math.max(0, toolTrace.length - recentCallCount);
    const messages = baseMessages.slice();
    if (olderCallCount) {
      const olderTrace = toolTrace.slice(0, olderCallCount).slice(-16);
      const oldCalls = olderTrace.map(item => `${item.name}:${item.result && item.result.ok === false ? '未成功' : '已返回'}`).join('、');
      const stagedOperations = operations.slice(-12).map(summarizeOperation).join('；');
      const summary = [
        '本轮较早的工具调用完整记录保存在本地；不要重复已完成的操作。',
        oldCalls ? `较早工具：${oldCalls}` : '',
        stagedOperations ? `已暂存操作：${stagedOperations}` : ''
      ].filter(Boolean).join('\n').slice(-1800);
      messages.push({ role: 'user', content: summary });
    }
    for (const turn of recentTurns) messages.push(...turn.messages.map(compactToolMessage));
    return messages;
  }

  async function runSystem(snapshot, system, requestCompletion, suffix, context, availableTools, interactionMode, onToolTurn) {
    const initialState = systemState(snapshot, system);
    if (context) initialState.interaction_context = clone(context);
    const baseMessages = [
      { role: 'system', content: systemPrompt(system, suffix, interactionMode) },
      { role: 'user', content: JSON.stringify(initialState) }
    ];
    const toolTurns = [];
    let toolRoundCount = 0;
    const operations = [];
    const toolsUsed = [];
    const toolTrace = [];
    while (true) {
      const requestMessages = requestMessagesForSystem(baseMessages, toolTurns, toolTrace, operations);
      const message = await requestCompletion(requestMessages, availableTools, 'auto', system.system_id);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        return {
          systemId: system.system_id,
          operations,
          toolsUsed,
          toolTrace,
          finalText: typeof message.content === 'string' ? message.content : '',
          responseSegments: Array.isArray(message._responseSegments) ? message._responseSegments.slice() : []
        };
      }
      toolRoundCount += 1;
      if (onToolTurn) onToolTurn(system.system_id, toolRoundCount, calls.length);
      const turnMessages = [{
        role: 'assistant',
        content: message.content === undefined ? null : message.content,
        tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: call.function }))
      }];
      for (const call of calls) {
        if (!call.id || call.type !== 'function' || !call.function || typeof call.function.name !== 'string') {
          throw new Error(system.system_id + ' 返回了不完整的工具调用记录。');
        }
        let result;
        let traceArgs = null;
        try {
          const args = parseArguments(call);
          traceArgs = clone(args);
          result = executeTool(snapshot, system, operations, call.function.name, args, availableTools, interactionMode);
          toolsUsed.push(call.function.name);
        } catch (error) {
          result = { ok: false, error: error.message || String(error) };
        }
        toolTrace.push({ name: call.function.name, args: traceArgs, result: clone(result) });
        turnMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      toolTurns.push({ messages: turnMessages, callCount: calls.length });
      if (toolTurns.length > MAX_RECENT_TOOL_TURNS) toolTurns.shift();
    }
  }

  function findSystem(frame, id) {
    const system = frame.systems.find(item => item.system_id === id);
    if (!system) throw new Error('回放记录引用了不存在的系统：' + id + '。');
    return system;
  }

  function applyLoggedCommand(frame, command) {
    if (command.type === 'set_framework_parameter') {
      frame.framework_param[command.name] = command.value;
      return;
    }
    if (command.type === 'replace_parameters') {
      findSystem(frame, command.system_id).parameters = clone(command.parameters);
      return;
    }
    if (command.type === 'set_statement') {
      findSystem(frame, command.system_id).statement = command.statement;
      return;
    }
    if (command.type === 'set_time_clock') {
      findSystem(frame, command.system_id).time_clock = command.value;
      return;
    }
    if (command.type === 'append_event') {
      findSystem(frame, command.system_id).events.push(clone(command.event));
      return;
    }
    if (command.type === 'edit_parameter') {
      const system = findSystem(frame, command.system_id);
      const index = system.parameters.findIndex(parameter => parameter.param === command.name);
      if (command.op === 'add') {
        if (index < 0) system.parameters.push({ param: command.name, value: command.value });
        else system.parameters[index].value = command.value;
      } else if (command.op === 'change') {
        if (index >= 0) system.parameters[index].value = command.value;
      } else if (command.op === 'remove' && index >= 0) system.parameters.splice(index, 1);
      return;
    }
    if (command.type === 'consume_events') {
      findSystem(frame, command.system_id).events = [];
      return;
    }
    if (command.type === 'deliver_event') {
      findSystem(frame, command.target_system_id).events.push(clone(command.event));
      return;
    }
    throw new Error('未知的框架命令：' + command.type + '。');
  }

  function withChangeAudit(frame, command) {
    const audited = clone(command);
    const system = command.system_id ? findSystem(frame, command.system_id) : null;
    if (!system) return audited;
    if (command.type === 'edit_parameter') {
      const previous = system.parameters.find(item => item.param === command.name);
      audited.change = {
        field: 'parameters.' + command.name,
        before: previous ? previous.value : null,
        after: command.op === 'remove' ? null : command.value,
        reason: command.reason || ''
      };
    } else if (command.type === 'set_statement') {
      audited.change = { field: 'statement', before: system.statement, after: command.statement, reason: command.reason || '' };
    } else if (command.type === 'set_time_clock') {
      audited.change = { field: 'time_clock', before: system.time_clock, after: command.value, reason: command.reason || '' };
    } else if (command.type === 'consume_events') {
      audited.change = { field: 'events', before: system.events.length + ' 条事件', after: '已清空', reason: command.reason || '' };
    }
    return audited;
  }

  async function forwardInference(frame, requestCompletion, suffix, options) {
    validate(frame);
    const interactionMode = Boolean(options && options.mode === 'agent_interaction');
    const availableTools = interactionMode ? interactionTools : tools;
    const interactionContext = interactionMode ? {
      round: options.round,
      researcher_prompt: options.researcherPrompt || '',
      researcher_recipients: Array.isArray(options.researcherRecipients) ? options.researcherRecipients : [],
      previous_round_messages: compactPreviousRoundMessages(Array.isArray(options.previousRoundMessages) ? options.previousRoundMessages : [])
    } : null;
    const onToolTurn = interactionMode && typeof options.onToolTurn === 'function' ? options.onToolTurn : null;
    const snapshot = clone(frame);
    const settled = await Promise.allSettled(snapshot.systems.map(system => runSystem(snapshot, system, requestCompletion, suffix, interactionContext, availableTools, interactionMode, onToolTurn)));
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) {
      const summary = failures.map(result => {
        const failedIndex = settled.indexOf(result);
        const failedSystem = snapshot.systems[failedIndex];
        return (failedSystem ? failedSystem.system_id + '：' : '') + (result.reason && result.reason.message || String(result.reason));
      }).join('；');
      throw new Error('框架回合全成全败：' + failures.length + ' 个系统未完成。' + summary);
    }

    const results = settled.map(result => result.value);
    const staged = clone(snapshot);
    const commandLog = [];
    const messages = [];
    for (const result of results) {
      for (const operation of result.operations) {
        if (operation.type === 'deliver_event') continue;
        if (operation.type === 'send_message') {
          messages.push({ kind: 'directed', sender: result.systemId, recipients: clone(operation.target_system_ids), text: operation.message });
          continue;
        }
        const command = { ...clone(operation), system_id: result.systemId };
        const audited = withChangeAudit(staged, command);
        applyLoggedCommand(staged, audited);
        commandLog.push(audited);
      }
    }
    for (const result of results) {
      for (const operation of result.operations) {
        if (operation.type !== 'deliver_event') continue;
        const command = {
          type: 'deliver_event',
          system_id: result.systemId,
          target_system_id: operation.target_system_id,
          event: clone(operation.event)
        };
        const target = findSystem(staged, operation.target_system_id);
        const previousCount = target.events.length;
        applyLoggedCommand(staged, command);
        command.change = { field: 'events', before: previousCount + ' 条事件', after: (previousCount + 1) + ' 条事件', reason: '定向事件送达；由收件 agent 下一轮处理' };
        commandLog.push(command);
        messages.push({
          kind: 'event', sender: result.systemId, recipients: [operation.target_system_id],
          text: operation.event.event_description, delta_parameters: clone(operation.event.delta_parameters)
        });
      }
    }
    validate(staged);
    return { frame: staged, results, commandLog, messages };
  }

  function replay(anchor, commands, count) {
    validate(anchor);
    if (!Array.isArray(commands)) throw new Error('命令记录必须是数组。');
    const end = Math.max(0, Math.min(commands.length, Math.floor(Number(count) || 0)));
    const frame = clone(anchor);
    for (const command of commands.slice(0, end)) applyLoggedCommand(frame, command);
    validate(frame);
    return frame;
  }

  G.SITPFrameworkRuntime = Object.freeze({
    MAX_SYSTEMS,
    tools,
    interactionTools,
    clone,
    validate,
    normalize,
    systemState,
    forwardInference,
    applyLoggedCommand,
    replay
  });
})(globalThis);
