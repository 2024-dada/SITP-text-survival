(function (G) {
  'use strict';

  const root = document.getElementById('parameterMonitorCards');
  const updated = document.getElementById('monitorUpdated');
  const exactLabels = {
    par_geo_001: '岛屿参考点纬度',
    par_geo_002: '岛屿参考点经度',
    par_geo_003: '细分格边长',
    par_geo_004_weight_power: '地理观测权重指数',
    par_geo_004_edge_fade_m: '海岸边缘淡化距离',
    par_obs_001_near_m: '近景观测距离',
    par_obs_001_mid_m: '中景观测距离',
    par_obs_001_land_patch_max_m: '陆地斑块最大观测距离',
    par_obs_001_day_dry_m: '日间干燥天气观测距离',
    par_obs_001_day_light_rain_m: '日间小雨观测距离',
    par_obs_001_day_heavy_rain_m: '日间大雨观测距离',
    par_obs_001_night_m: '夜间观测距离',
    par_obs_002_r06_max_m: 'R06 最大观测距离',
    par_obs_002_fish_far_threshold_m: '鱼类远距判断阈值',
    epoch_year: '模拟起始年份',
    epoch_month: '模拟起始月份',
    epoch_day: '模拟起始日期',
    epoch_constructor_hour: '模拟起始小时',
    par_time_002: '天气模拟时间步长',
    par_time_003: '天气取样随机种子',
    par_wx_001: '天气更新时间步长（按规则推定）',
    par_wx_002: '降雨持续时间（按规则推定）',
    par_wx_004_background_rain: '背景降雨系数',
    par_wx_004_localized_rain: '局部降雨系数',
    par_wx_004_approaching_floor: '接近雨带下限系数',
    par_wx_004_dry_cap: '干燥条件上限参数',
    par_sun_001: '日照时刻偏移（按字段推定）',
    par_tide_001_amplitude_m: '潮位振幅',
    par_tide_001_period_hours: '潮位周期',
    par_tide_001_baseline_m: '潮位基准',
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
  const unitSuffixes = ['_l_per_mm', '_l_per_day', '_mm_h', '_m_s', '_days', '_hours', '_minutes', '_hour', '_m', '_l', '_c'];

  const exactUnits = {
    par_geo_001: '°（纬度；负值为南）', par_geo_002: '°（经度；负值为西）', par_geo_003: '米',
    par_geo_004_weight_power: '1（幂指数）', par_time_002: '小时', par_time_003: '编号（随机种子）',
    par_wx_001: '小时（步长推定）', par_wx_002: '小时（持续时间推定）', par_sun_001: '小时（日照时刻偏移推定）',
    skin_blood_flow_ml_min: '毫升/分钟', shivering_heat_ml_min: '毫升/分钟', sweat_rate_ml_h: '毫升/小时',
    heart_rate_bpm: '次/分钟', systolic_bp_mmhg: 'mmHg', diastolic_bp_mmhg: 'mmHg',
    cardiac_output_l_min: '升/分钟', respiratory_rate_bpm: '次/分钟', tidal_volume_ml: '毫升', minute_ventilation_l_min: '升/分钟',
    par_tide_001_amplitude_m: '米', par_tide_001_period_hours: '小时', par_tide_001_baseline_m: '米',
    par_water_003_min_factor: '1（温度影响倍率）', par_water_003_max_factor: '1（温度影响倍率）',
    par_site_001_default_if_null: '1（湿润度比例）', par_site_001_min: '1（湿润度比例）', par_site_001_max: '1（湿润度比例）',
    par_site_001_rain_per_hour: '小时⁻¹（湿润度变化率）', par_site_001_dry_per_hour: '小时⁻¹（湿润度变化率）',
    par_eco_003_wet_peak: '1（季节生长倍率）', par_eco_003_wet_to_dry: '1（季节生长倍率）',
    par_eco_003_dry: '1（季节生长倍率）', par_eco_003_dry_to_wet: '1（季节生长倍率）',
    par_eco_004_minimum_adults: '个成体单位（R05 按千克生物量计）',
    par_eco_004_condition_range_item_1: '1（状态比例下限）', par_eco_004_condition_range_item_2: '1（状态比例上限）',
    par_eco_004_heat_start_c: '℃', par_eco_004_heat_slope: '℃⁻¹（温度修正斜率）', par_eco_004_heat_floor: '1（最低保留倍率）',
    par_surv_001_rain_factor: '1（雨天移动速度倍率）',
    dataset_ds_a_shoreline_vertices: '个岸线顶点', dataset_ds_a_macro_zones: '个宏观分区',
    dataset_ds_a_dem_points: '个高程点', dataset_ds_a_cells: '个网格单元', dataset_ds_a_sites: '个资源点',
    dataset_ds_b_days: '天', dataset_ds_b_rainy_days: '天', dataset_ds_b_start_rows: '行', dataset_ds_b_start_seed: '编号（随机种子）',
    dataset_ds_c_sites: '个资源点', dataset_ds_c_pool_types: '种资源类型', dataset_ds_c_water_points: '个蓄水点',
    dataset_ds_eco_habitats: '类栖地', dataset_ds_eco_species_groups: '组物种', dataset_ds_sample_seed: '编号（随机种子）'
  };

  function foodUnit(code) {
    return /browse/i.test(code) ? '千克干物质' : '千克食源折算';
  }

  function parameterUnit(code) {
    const key = String(code).toLowerCase();
    if (exactUnits[key]) return exactUnits[key];
    if (key === 'epoch_year') return '年';
    if (key === 'epoch_month') return '月';
    if (key === 'epoch_day') return '日';
    if (key === 'epoch_constructor_hour') return '时';
    if (/_active_at_start_flag$|_flag$/.test(key)) return '0/1（布尔开关）';
    if (/_l_per_mm(?:_item_\d+)?$/.test(key)) return '升/毫米';
    if (/_l_per_day(?:_item_\d+)?$/.test(key)) return '升/日';
    if (/_mm_h(?:_item_\d+)?$/.test(key)) return '毫米/小时';
    if (/_m_s$/.test(key)) return '米/秒';
    if (/_annualregrowth$/.test(key)) return foodUnit(key) + '/年';
    if (/_stock$|_capacity$/.test(key) && /par_eco_001/.test(key)) return foodUnit(key);
    if (/_usable$|_condition$/.test(key) && /par_eco_001/.test(key)) return '1（比例）';
    const intake = key.match(/par_eco_002_(r\d+)_intake$/);
    if (intake) {
      if (intake[1] === 'r04') return '千克干物质/（成年等效只·日）';
      if (intake[1] === 'r05') return '千克食源折算/（千克鱼体生物量·日）';
      if (intake[1] === 'r06') return '千克食源折算/（个贝·日）';
      if (intake[1] === 'r07') return '千克食源折算/（只·日）';
      return '千克食源折算/（只·日）';
    }
    const recruits = key.match(/par_eco_002_(r\d+)_recruits$/);
    if (recruits) return recruits[1] === 'r05' ? '年⁻¹（单位生物量补充率）' : '新个体/（成年个体·年）';
    if (/par_eco_002_r\d+_mortality_item_\d+$/.test(key)) return '年⁻¹（年死亡率）';
    if (/par_eco_002_r\d+_(?:stage_days_item_\d+|maturity)$/.test(key)) return '天';
    if (/par_eco_002_r05_step$/.test(key)) return '千克鱼体生物量';
    if (/par_eco_004_condition_range_item_\d+$/.test(key)) return '1（状态比例边界）';
    if (/par_eco_004_heat_start_c$/.test(key)) return '℃';
    if (/par_eco_004_heat_slope$/.test(key)) return '℃⁻¹（温度修正斜率）';
    if (/par_eco_004_heat_floor$/.test(key)) return '1（最低保留倍率）';
    if (/par_wx_004_/.test(key) || /_factor$|_probability$|_ratio$|_coefficient$/.test(key)) return '1（无量纲比例或系数）';
    if (/_position_m_item_\d+$|_bounds_m_item_\d+$|_m_item_\d+$|_m$/.test(key)) return '米';
    if (/_l$/.test(key)) return '升';
    if (/_c$/.test(key)) return '℃';
    if (/_hours?(?:_item_\d+)?$/.test(key)) return '小时';
    if (/_minutes?(?:_item_\d+)?$/.test(key)) return '分钟';
    if (/_days?(?:_item_\d+)?$/.test(key)) return '天';
    if (/_seed$/.test(key)) return '编号（随机种子）';
    if (/_rows$/.test(key)) return '行';
    if (/_vertices$|_points$|_cells$|_sites$|_zones$|_habitats$|_groups$|_types$/.test(key)) return '个（数量）';
    // Unknown numeric fields from user-loaded frameworks still get an explicit
    // dimensionless unit instead of silently showing a blank unit.
    return '1（无量纲，未识别字段的暂定推定）';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = safeText(text);
    return node;
  }

  function safeText(value) {
    return String(value).replace(/\b(?:mgk_live_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,})\b/g, '[API Key 已隐藏]');
  }

  function parameterName(code) {
    if (exactLabels[code]) return exactLabels[code];
    const item = code.match(/_item_(\d+)$/i);
    let name = code.replace(/_item_\d+$/i, '');
    for (const suffix of unitSuffixes) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        break;
      }
    }
    let tokens = name.toLowerCase().split(/[_-]+/).filter(Boolean);
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

  function fieldRow(label, code, value, unit) {
    const row = element('div', 'monitorFieldRow');
    const valueGroup = element('span', 'monitorFieldValueGroup');
    valueGroup.append(element('strong', 'monitorFieldValue', value));
    if (unit) valueGroup.append(element('small', 'monitorFieldUnit', unit));
    row.append(element('span', 'monitorFieldLabel', label), element('code', 'monitorFieldCode', code), valueGroup);
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
      fieldRow('本地时钟标注', 'time_clock', system.timeClock, '模拟时间'),
      fieldRow('参数数量', 'parameters.length', system.parameters.length, '项'),
      fieldRow('事件队列', 'events.length', system.eventCount, '条'),
      fieldRow('已记录修改', 'frameworkCommandLog', system.changeCount, '项')
    );
    card.append(summary);

    const parameters = element('details', 'monitorDetails');
    parameters.append(element('summary', '', '查看参数值 · ' + system.parameters.length + ' 项'));
    if (system.parameters.length) {
      const list = element('div', 'monitorFieldList');
      for (const parameter of system.parameters) {
        const sensitive = /api[-_]?key|token|secret|password|credential/i.test(parameter.code);
        list.append(fieldRow(parameterName(parameter.code), parameter.code, sensitive ? '已隐藏' : parameterValue(parameter.code, parameter.value), parameterUnit(parameter.code)));
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
    return card;
  }

  function platformCard(title, source, rows, extra) {
    const card = element('article', 'monitorCard monitorPlatformCard');
    const heading = element('div', 'monitorCardHeading');
    heading.append(element('div', 'monitorAgentTitle', ''), element('span', 'monitorStatus', '运行时'));
    heading.firstChild.append(element('h3', '', title), element('code', '', source));
    card.append(heading);
    const list = element('div', 'monitorPlatformFields');
    for (const row of rows) list.append(fieldRow(row[0], row[1], row[2], row[3]));
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

    root.append(platformCard('全局实验参数', 'framework_param', [
      ['仿真步长', 'framework_param.time_delta', snapshot.run.timeDelta, '分钟']
    ]));
    updated.textContent = '实时更新 · ' + new Date().toLocaleTimeString();
  }

  function update() {
    if (!G.SurvivalAgent || typeof G.SurvivalAgent.getMonitorSnapshot !== 'function') return;
    render(G.SurvivalAgent.getMonitorSnapshot());
  }

  G.SITPParameterUnits = Object.freeze({ get: parameterUnit });
  document.addEventListener('sitp:monitor-update', update);
  update();
})(globalThis);
