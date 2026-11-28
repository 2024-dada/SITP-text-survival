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

  globalThis.ExperimentPdf = Object.freeze({ build });
})();
