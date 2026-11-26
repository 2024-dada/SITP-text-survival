(function (G) {
  'use strict';

  const root = document.getElementById('parameterMonitorCards');
  const updated = document.getElementById('monitorUpdated');
  const exactLabels = {
    par_geo_001: '岛屿参考点纬度',
    par_geo_002: '岛屿参考点经度',
    par_geo_003: '细分格边长',
    par_geo_004_weight_power: '地理观测权重指数',
    par_geo_004_edge_fade_m: '海岸边缘淡化距离（米）',
    par_obs_001_near_m: '近景观测距离（米）',
    par_obs_001_mid_m: '中景观测距离（米）',
    par_obs_001_land_patch_max_m: '陆地斑块最大观测距离（米）',
    par_obs_001_day_dry_m: '日间干燥天气观测距离（米）',
    par_obs_001_day_light_rain_m: '日间小雨观测距离（米）',
    par_obs_001_day_heavy_rain_m: '日间大雨观测距离（米）',
    par_obs_001_night_m: '夜间观测距离（米）',
    par_obs_002_r06_max_m: 'R06 最大观测距离（米）',
    par_obs_002_fish_far_threshold_m: '鱼类远距判断阈值（米）',
    epoch_year: '模拟起始年份',
    epoch_month: '模拟起始月份',
    epoch_day: '模拟起始日期',
    epoch_constructor_hour: '模拟起始小时',
    par_time_002: '天气模拟时间步长',
    par_time_003: '天气取样随机种子',
    par_wx_001: '天气参数 001（注册表未附具体释义）',
    par_wx_002: '天气参数 002（注册表未附具体释义）',
    par_wx_004_background_rain: '背景降雨系数',
    par_wx_004_localized_rain: '局部降雨系数',
    par_wx_004_approaching_floor: '接近雨带下限系数',
    par_wx_004_dry_cap: '干燥条件上限参数',
    par_sun_001: '日照参数 001（注册表未附具体释义）',
    par_tide_001_amplitude_m: '潮位振幅（米）',
    par_tide_001_period_hours: '潮位周期（小时）',
    par_tide_001_baseline_m: '潮位基准（米）',
    dataset_ds_b_days: '天气数据总天数',
    dataset_ds_b_rainy_days: '天气数据中的雨日数',
    dataset_ds_b_start_rows: '雨日开始时刻数据行数',
    dataset_ds_b_start_seed: '雨日开始时刻数据种子'
  };
  const words = {
    geo: '地理', obs: '观测', time: '时间', wx: '天气', sun: '日照', tide: '潮位', water: '水量', site: '资源点', eco: '生态', surv: '求生者',
    initial: '初始值', capacity: '容量', rain: '降雨', loss: '损耗', base: '基础', groundwater: '地下水补给', active: '启用', start: '开始', reference: '参考',
    min: '最小', max: '最大', factor: '系数', default: '默认', null: '空值', per: '每', mm: '毫米', day: '日', hour: '小时', hours: '小时',
    amplitude: '振幅', period: '周期', baseline: '基准', browse: '地表取食类', birdfood: '鸟类食源', reeffood: '礁区食源', fishfood: '鱼类食源', crabfood: '蟹类食源',
    stock: '存量', annualregrowth: '年补充量', usable: '可利用比例', condition: '状态系数', stage: '阶段', days: '天数', maturity: '成熟时间',
    intake: '摄入系数', recruits: '补充比例', mortality: '死亡率', step: '步长', wet: '湿季', peak: '峰值', dry: '干季', to: '转', minimum: '最低',
    adults: '成体数', range: '范围', heat: '热应激', slope: '斜率', floor: '下限', speed: '速度', position: '位置', minutes: '分钟', localized: '局地',
    background: '背景', approaching: '接近', threshold: '阈值', far: '远距', fish: '鱼类', vertices: '顶点数', shoreline: '岸线', bounds: '边界',
    zones: '分区', macro: '宏观', dem: '高程点', points: '点数', cells: '格数', sites: '资源点数', days: '天数', rainy: '雨日', rows: '行数', seed: '种子',
    pool: '资源池', pools: '资源池', types: '类型数', habitat: '栖地', habitats: '栖地数', species: '物种', groups: '群组数', cap: '上限',
    sample: '样例', dataset: '数据快照', item: '项', year: '年', month: '月', epoch: '模拟起点', constructor: '初始设置', hour: '小时',
    edge: '边缘', fade: '渐变距离', weight: '权重', power: '指数', near: '近距', mid: '中距', land: '陆地', patch: '斑块', light: '小雨', heavy: '大雨',
    night: '夜间', floor: '下限', flag: '开关', l: '升', m: '米', c: '摄氏度', h: '小时'
  };
  const units = [
    ['_l_per_mm', '升/毫米'], ['_l_per_day', '升/日'], ['_mm_h', '毫米/小时'], ['_m_s', '米/秒'],
    ['_days', '天'], ['_hours', '小时'], ['_minutes', '分钟'], ['_hour', '小时'], ['_m', '米'], ['_l', '升'], ['_c', '℃']
  ];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = safeText(text);
    return node;
  }

  function safeText(value) {
    return String(value).replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,})\b/g, '[API Key 已隐藏]');
  }

  function parameterName(code) {
    if (exactLabels[code]) return exactLabels[code];
    let name = code;
    let unit = '';
    for (const [suffix, label] of units) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        unit = label;
        break;
      }
    }
    const item = code.match(/_item_(\d+)$/i);
    let tokens = name.toLowerCase().split(/[_-]+/).filter(Boolean);
    if (item && tokens.length >= 2) tokens = tokens.slice(0, -2);
    const translated = [];
    for (const token of tokens) {
      if (['par', 'ds', 'a', 'b', 'c', '001', '002', '003', '004'].includes(token)) continue;
      if (/^r\d+$/.test(token)) { translated.push(token.toUpperCase()); continue; }
      if (/^item$/.test(token)) continue;
      if (/^\d+$/.test(token)) { translated.push('编号' + token); continue; }
      translated.push(words[token] || token);
    }
    if (item) translated.push('第' + item[1] + '项');
    let label = translated.join(' · ') || '参数释义待补充';
    if (unit && !label.includes(unit)) label += '（' + unit + '）';
    if (/^par_(geo|obs|time|wx|sun|tide|water|site|eco|surv)_\d+$/i.test(code)) label += '（注册表未附具体释义）';
    return label;
  }

  function parameterValue(code, value) {
    if (value === null || value === undefined) return '未设置';
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'object') return JSON.stringify(value);
    if (/_flag$/i.test(code) && (value === 0 || value === 1)) return String(value) + (value === 1 ? ' · 是' : ' · 否');
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return String(value);
  }

  function fieldRow(label, code, value) {
    const row = element('div', 'monitorFieldRow');
    row.append(element('span', 'monitorFieldLabel', label), element('code', 'monitorFieldCode', code), element('strong', 'monitorFieldValue', value));
    return row;
  }

  function renderAgentCard(system, snapshot) {
    const card = element('article', 'monitorCard monitorAgentCard');
    const heading = element('div', 'monitorCardHeading');
    const title = element('div', 'monitorAgentTitle');
    title.append(element('h3', '', system.displayName), element('code', '', system.systemId));
    const result = snapshot.lastResults.find(item => item.systemId === system.systemId);
    const statusText = snapshot.run.running ? '正在推理' : snapshot.run.pendingRetry ? '本轮失败 · 等待重试' : result ? '最近一轮已参与' : system.waitingForStart ? '首轮启动时接入' : '等待首次运行';
    const badge = element('span', 'monitorStatus', statusText);
    heading.append(title, badge);
    card.append(heading);

    const summary = element('div', 'monitorAgentSummary');
    summary.append(
      fieldRow('本地时钟标注', 'time_clock', system.timeClock),
      fieldRow('参数数量', 'parameters.length', system.parameters.length),
      fieldRow('事件队列', 'events.length', system.eventCount),
      fieldRow('已记录修改', 'frameworkCommandLog', system.changeCount)
    );
    card.append(summary);

    const parameters = element('details', 'monitorDetails');
    parameters.append(element('summary', '', '查看参数值 · ' + system.parameters.length + ' 项'));
    if (system.parameters.length) {
      const list = element('div', 'monitorFieldList');
      for (const parameter of system.parameters) {
        const sensitive = /api[-_]?key|token|secret|password|credential/i.test(parameter.code);
        list.append(fieldRow(parameterName(parameter.code), parameter.code, sensitive ? '已隐藏' : parameterValue(parameter.code, parameter.value)));
      }
      parameters.append(list);
    } else {
      parameters.append(element('p', 'monitorEmpty', '当前没有预置参数；求生者 Agent 会在运行时按规则自行记录状态。'));
    }
    card.append(parameters);

    if (system.statement) {
      const statement = element('details', 'monitorDetails monitorStatement');
      statement.append(element('summary', '', '查看当前状态说明'));
      statement.append(element('p', 'monitorStatementText', system.statement));
      card.append(statement);
    }
    if (result) {
      card.append(fieldRow('最近工具调用', 'toolTrace.length', result.toolCount + (result.toolNames.length ? ' · ' + result.toolNames.join('、') : '')));
    }
    return card;
  }

  function platformCard(title, source, rows, extra) {
    const card = element('article', 'monitorCard monitorPlatformCard');
    const heading = element('div', 'monitorCardHeading');
    heading.append(element('div', 'monitorAgentTitle', ''), element('span', 'monitorStatus', '运行时'));
    heading.firstChild.append(element('h3', '', title), element('code', '', source));
    card.append(heading);
    const list = element('div', 'monitorPlatformFields');
    for (const row of rows) list.append(fieldRow(row[0], row[1], row[2]));
    card.append(list);
    if (extra) card.append(extra);
    return card;
  }

  function render(snapshot) {
    root.replaceChildren();
    if (snapshot.systems.length) {
      for (const system of snapshot.systems) root.append(renderAgentCard(system, snapshot));
    } else {
      root.append(element('article', 'monitorCard monitorEmptyCard', '载入 Agent JSON 后会在这里按 system_id 分组显示参数。'));
    }

    const run = snapshot.run;
    const runtimeRows = [
      ['当前状态', 'lastAgentRoundState', run.state],
      ['已提交回合', 'interactionSession.round', run.round],
      ['本轮模型请求', 'roundCalls', run.roundCalls],
      ['累计模型请求', 'modelCalls', run.modelCalls],
      ['工具循环上限', 'MAX_TOOL_ROUNDS', run.maxToolRounds],
      ['框架系统数上限', 'MAX_SYSTEMS', run.maxSystems],
      ['模拟步长参数', 'framework_param.time_delta', run.timeDelta],
      ['现实等待参数', 'framework_param.real_time_delta', run.realTimeDelta],
      ['状态修改记录', 'frameworkCommandLog.length', run.commandCount]
    ];
    const runtimeExtra = run.error ? element('p', 'monitorRunError', run.error) : null;
    root.append(platformCard('推理运行时', 'framework-runtime.js / survival-agent.js', runtimeRows, runtimeExtra));

    const model = snapshot.model;
    const modelRows = [
      ['服务商', 'resolveProvider()', model.provider + ' · ' + model.providerSelection],
      ['API Key', 'aiApiKey.value', model.apiKeyConfigured ? '已填写 · 不显示密钥' : '未填写'],
      ['记住 Key', 'rememberApiKey.checked', model.rememberKey ? '已开启 · 保存在此浏览器' : '关闭 · 仅当前页面'],
      ['对话模型', 'aiModelName.value', model.modelName],
      ['可选模型数', 'aiModelChoices.options', model.modelCount],
      ['API 余额', 'apiBalance.textContent', model.balance],
      ['连接状态', 'providerStatus.textContent', model.providerStatus]
    ];
    root.append(platformCard('模型连接与调度', 'providerEndpoints / requestCompletion', modelRows));
    updated.textContent = '实时更新 · ' + new Date().toLocaleTimeString();
  }

  function update() {
    if (!G.SurvivalAgent || typeof G.SurvivalAgent.getMonitorSnapshot !== 'function') return;
    render(G.SurvivalAgent.getMonitorSnapshot());
  }

  document.addEventListener('sitp:monitor-update', update);
  update();
})(globalThis);
