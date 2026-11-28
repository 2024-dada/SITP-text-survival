(function () {
  'use strict';

  function hex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function pdfText(text) {
    let encoded = '';
    for (let index = 0; index < text.length; index++) {
      encoded += text.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return '<' + encoded + '>';
  }

  function reviewSections(data, now) {
    const reports = new Map(data.reports.map(report => [report.round, report]));
    const sections = [['OLORUA · 实验审查记录', [
      `已提交 ${data.rounds.length} 轮 · 导出时间 ${now.toISOString()}`,
      '完整原始记录附在本 PDF 的 experiment.json 中，也可在网页单独下载。',
      '下文的 rounds[n] 和 reports[n] 使用从 0 开始的 JSON 数组索引。',
      '只记录已保存的工具调用和规则证据。未记录的字段读取情况未知。',
      '模型叙述保留原文供对照，是否一致由审查员核对。',
      '初始框架：initial。初始世界快照：rounds[0].world_before（有已提交轮次时）。',
      '参数与单位对照：parameter_units。当前世界及背包：current。'
    ].join('\n')]];
    const pointText = point => Array.isArray(point) ? `E ${point[0]} m / N ${point[1]} m` : '未记录';
    const value = item => item == null ? '未记录' : typeof item === 'object' ? JSON.stringify(item) : String(item);
    const concise = text => {
      const raw = String(text || '').trim();
      return raw.length > 400 ? raw.slice(0, 400) + '…（节选，完整回复见原始记录）' : raw;
    };
    for (const [index, round] of data.rounds.entries()) {
      const report = reports.get(round.round);
      const ref = `rounds[${index}]`;
      const reportIndex = report ? data.reports.indexOf(report) : -1;
      const steps = report?.steps || [];
      const lines = [
        `任务：${round.researcher_input || '本轮未填写'}`,
        `起始位置：${pointText(round.world_before?.selected)}。世界快照：${ref}.world_before`,
        `起始时间：${steps[0]?.startTime || '未保存行动起始时刻'}`,
        `结算状态：${report?.resultText || '暂无本轮事件报告及结算记录。'}`,
        `模型调用记录：${ref}.model_responses。发送的完整输入和内部读取记录仅以实际存档为准。`,
        '', 'Agent 决策与工具'
      ];
      for (const [agentIndex, agent] of (round.inference?.results || []).entries()) {
        const tools = (agent.toolTrace || []).map(call => call.name).join('、');
        lines.push(`${agent.systemId} · ${ref}.inference.results[${agentIndex}]`,
          concise(agent.finalText) || '未保存公开回复。',
          `已记录工具：${tools || '无'}。工具参数与结果见上述条目的 toolTrace。`);
      }
      const changes = round.inference?.commandLog || [];
      lines.push('', 'Agent 状态变化');
      for (const [changeIndex, command] of changes.entries()) {
        if (!command.change) continue;
        const { field, before, after, reason } = command.change;
        const unit = data.parameter_units?.[field];
        lines.push(`${command.system_id} · ${field}：${concise(value(before))} → ${concise(value(after))}${typeof unit === 'string' ? ' ' + unit : ''}`,
          `理由：${concise(reason) || '未记录'} · ${ref}.inference.commandLog[${changeIndex}]`);
      }
      if (!changes.some(command => command.change)) lines.push('未记录 Agent 状态修改。');
      lines.push('', '逐项执行与依据');
      for (const [stepIndex, step] of steps.entries()) {
        lines.push(`${stepIndex + 1}. ${step.activity} · ${step.startTime} → ${step.endTime} · ${step.durationMinutes} 分钟`,
          `地点：${step.point ? `${step.point.id} ${step.point.name}（${pointText([step.point.east_m, step.point.north_m])}）` : '未记录行动点位'}`,
          `位置：${pointText(step.positionBefore)} → ${pointText(step.positionAfter)}`,
          `当地天气：${step.weatherStart || '未记录'}${step.weatherStart === step.weatherEnd ? '（结束时相同）' : ' → ' + (step.weatherEnd || '未记录')}`,
          `计划依据：${[step.assumption, step.pointReason].filter(Boolean).join('。') || '未记录'}`,
          step.blocked ? '抽样：未抽样（前置条件阻断）。' :
            `抽样：推算 ${value(step.probability)}%，抽样值 ${value(step.randomDraw)}%，${step.sampledSuccess ? '命中' : '未中'}。`,
          `实际执行：${step.blocked ? '未执行' : step.success ? '完成' : '未完成'}。规则：${step.ruleEvidence || '未单独记录'}`,
          `结算：${[step.resultText, step.settlementText].filter(Boolean).join(' ')}`);
        if (step.resourceBefore) {
          const resource = step.resourceBefore;
          lines.push(`库存依据：${resource.id}，点位库存 ${value(resource.available)}，随身 ${resource.carried} → ${value(step.resourceCarriedAfter)} ${resource.unit || ''}`);
        }
        if (step.sceneBefore && step.sceneAfter) {
          const before = new Set(step.sceneBefore.split('\n').map(line => line.trim()).filter(Boolean));
          const after = new Set(step.sceneAfter.split('\n').map(line => line.trim()).filter(Boolean));
          const added = [...after].filter(line => !before.has(line));
          const removed = [...before].filter(line => !after.has(line));
          lines.push(added.length || removed.length
            ? `场景变化（已存节选）：${added.length ? '新增：' + added.join(' / ') : ''}${removed.length ? ' 不再出现：' + removed.join(' / ') : ''}`
            : '场景：已存前后描述相同。');
        }
        lines.push(`原始记录：reports[${reportIndex}].steps[${stepIndex}]`, '');
      }
      if (!steps.length) lines.push('没有已结算的行动步骤。');
      if (report) {
        lines.push('', `报告对照（完整原文：reports[${reportIndex}]）`, `结算记录：${report.settlementSummary || '未保存'}`);
        const narratives = new Set();
        for (const [name, text] of [['事件概要', report.humanSummary], ['人体感受', report.bodySummary], ['岛屿变化', report.islandSummary], ['事件前看到的景象', report.beforeScene], ['事件后看到的景象', report.afterScene]]) {
          if (!text) continue;
          lines.push(`${name}（报告原文）：${narratives.has(text) ? '同本轮上面已列出的原文。' : text}`);
          narratives.add(text);
        }
      }
      sections.push([`第 ${round.round} 轮 · 推理与结算审查`, lines.join('\n')]);
    }
    if (data.current?.pending_report || data.current?.failed_responses?.length) {
      sections.push(['未完成记录', [
        data.current.pending_report?.error || '',
        '待结算与失败响应详见 current.pending_report、current.failed_responses。'
      ].filter(Boolean).join('\n')]);
    }
    return sections;
  }

  function build(sections, archive) {
    // PDF syntax and streams are ASCII so string lengths are also byte offsets.
    const objects = [null];
    const add = value => objects.push(value) - 1;
    const catalog = add('');
    const pages = add('');
    const descendant = add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /ExperimentUnicode def /CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '2 beginbfrange\n<0000> <D7FF> <0000>\n<E000> <FFFF> <E000>\nendbfrange\n' +
      'endcmap CMapName currentdict /CMap defineresource pop end end';
    const unicode = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
    const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    const embedded = hex(new TextEncoder().encode(JSON.stringify(archive))) + '>';
    const file = add(`<< /Type /EmbeddedFile /Subtype /application#2Fjson /Filter /ASCIIHexDecode /Length ${embedded.length} >>\nstream\n${embedded}\nendstream`);
    const fileSpec = add(`<< /Type /Filespec /F (experiment.json) /EF << /F ${file} 0 R >> >>`);
    const pageIds = [];
    let lines = [];
    function flushPage() {
      if (!lines.length) return;
      const text = lines.map(line => pdfText(line) + ' Tj T*').join('\n');
      const stream = `BT /F1 10 Tf 14 TL 42 793 Td\n${text}\nET`;
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
      lines = [];
    }
    function append(text) {
      for (const line of text.split(/\r?\n/)) {
        const characters = Array.from(line);
        for (let start = 0; start < Math.max(1, characters.length); start += 50) {
          if (lines.length === 54) flushPage();
          lines.push(characters.slice(start, start + 50).join(''));
        }
      }
    }
    for (const [title, value] of sections) {
      append(title);
      append(typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2));
      append('');
    }
    flushPage();
    objects[pages] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] >>`;
    objects[catalog] = `<< /Type /Catalog /Pages ${pages} 0 R /Names << /EmbeddedFiles << /Names [(experiment.json) ${fileSpec} 0 R] >> >> >>`;
    const chunks = ['%PDF-1.7\n'];
    let offset = chunks[0].length;
    const offsets = ['0000000000 65535 f \n'];
    for (let id = 1; id < objects.length; id++) {
      const chunk = `${id} 0 obj\n${objects[id]}\nendobj\n`;
      offsets.push(String(offset).padStart(10, '0') + ' 00000 n \n');
      chunks.push(chunk);
      offset += chunk.length;
    }
    chunks.push(`xref\n0 ${objects.length}\n${offsets.join('')}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  globalThis.ExperimentPdf = Object.freeze({ build, reviewSections });
})();
