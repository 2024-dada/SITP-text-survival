(function (G) {
  'use strict';

  const MAX_TOOL_ROUNDS = 6;
  const MAX_SYSTEMS = 32;

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
    makeTool('math_eval', '计算兼容 libmatheval 的表达式：数字、常数、变量、括号、+ - * / ^（也接受 **）及单变量初等函数。', {
      expression: { type: 'string' },
      variables: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' },
        value: { type: 'number' }
      }, required: ['name', 'value'], additionalProperties: false } }
    }, ['expression', 'variables'])
  ];

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
    if (typeof expression !== 'string' || expression.length > 240 || /[\r\n]/.test(expression) || !Array.isArray(variables)) throw new Error('math_eval输入格式不合法（表达式最多240字符且不能换行）。');
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

  function executeTool(snapshot, self, operations, name, args) {
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
        if (operation.op === 'change' && !known.has(operation.name)) { ignored += 1; continue; }
        if (operation.op === 'remove' && !known.has(operation.name)) { ignored += 1; continue; }
        queued.push({ type: 'edit_parameter', op: operation.op, name: operation.name, value: operation.value });
        if (operation.op === 'add') known.add(operation.name);
        if (operation.op === 'remove') known.delete(operation.name);
      }
      operations.push(...queued);
      return { ok: true, queued: queued.length, ignored };
    }
    if (name === 'set_statement') {
      if (typeof args.statement !== 'string' || !args.statement.trim()) throw new Error('set_statement 需要非空的状态说明。');
      operations.push({ type: 'set_statement', statement: args.statement.trim() });
      return { ok: true, queued: true };
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
      operations.push({ type: 'consume_events' });
      return { ok: true, queued: true };
    }
    if (name === 'math_eval') return { ok: true, value: evaluateMath(args.expression, args.variables) };
    throw new Error('不支持的工具：' + String(name));
  }

  function systemPrompt(system, suffix) {
    return system.rule + (suffix ? '\n\n' + suffix : '');
  }

  async function runSystem(snapshot, system, requestCompletion, suffix) {
    const messages = [
      { role: 'system', content: systemPrompt(system, suffix) },
      { role: 'user', content: JSON.stringify(systemState(snapshot, system)) }
    ];
    const operations = [];
    const toolsUsed = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const message = await requestCompletion(messages, tools, 'auto');
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        return {
          systemId: system.system_id,
          operations,
          toolsUsed,
          finalText: typeof message.content === 'string' ? message.content : ''
        };
      }
      messages.push({
        role: 'assistant',
        content: message.content === undefined ? null : message.content,
        tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: call.function }))
      });
      for (const call of calls) {
        if (!call.id || call.type !== 'function' || !call.function || typeof call.function.name !== 'string') {
          throw new Error(system.system_id + ' 返回了不完整的工具调用记录。');
        }
        let result;
        try {
          const args = parseArguments(call);
          result = executeTool(snapshot, system, operations, call.function.name, args);
          toolsUsed.push(call.function.name);
        } catch (error) {
          result = { ok: false, error: error.message || String(error) };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error(system.system_id + ' 连续调用达到6次 API 往返上限，未完成本轮。');
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

  async function forwardInference(frame, requestCompletion, suffix) {
    validate(frame);
    const snapshot = clone(frame);
    const settled = await Promise.allSettled(snapshot.systems.map(system => runSystem(snapshot, system, requestCompletion, suffix)));
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) {
      const summary = failures.map(result => result.reason && result.reason.message || String(result.reason)).join('；');
      throw new Error('框架回合全成全败：' + failures.length + ' 个系统未完成。' + summary);
    }

    const results = settled.map(result => result.value);
    const staged = clone(snapshot);
    const commandLog = [];
    for (const result of results) {
      for (const operation of result.operations) {
        if (operation.type === 'deliver_event') continue;
        const command = { ...clone(operation), system_id: result.systemId };
        applyLoggedCommand(staged, command);
        commandLog.push(command);
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
        applyLoggedCommand(staged, command);
        commandLog.push(command);
      }
    }
    validate(staged);
    return { frame: staged, results, commandLog };
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
    MAX_TOOL_ROUNDS,
    MAX_SYSTEMS,
    tools,
    clone,
    validate,
    normalize,
    systemState,
    forwardInference,
    applyLoggedCommand,
    replay
  });
})(globalThis);
