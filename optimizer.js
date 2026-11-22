// Measure the active chat using the same JSONL serialization as SillyTavern.
export const CACHE_KEY = '压缩相邻消息';
export const PLOT_LOG = /<\s*plot-log\b/i;

export function createAnalyzer() {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  const RECENT = 8;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isEmptyObject = value => isObject(value) && Object.keys(value).length === 0;
  const isEmptyList = value => Array.isArray(value) && value.length === 0;

  function skipSpace(text, start) {
    while (text[start] === ' ' || text[start] === '\t' || text[start] === '\r' || text[start] === '\n') start++;
    return start;
  }

  function stringEnd(text, start) {
    for (let position = start + 1; position < text.length; position++) {
      if (text[position] === '"') return position + 1;
      if (text[position] === '\\') position++;
    }
    throw new Error('JSON 字符串不完整。');
  }

  // The line has already passed JSON.parse. These scans locate untouched source spans.
  function valueEnd(text, start) {
    const first = text[start];
    if (first === '"') return stringEnd(text, start);
    if (first === '{' || first === '[') {
      let depth = 1;
      for (let position = start + 1; position < text.length; position++) {
        const char = text[position];
        if (char === '"') {
          position = stringEnd(text, position) - 1;
        } else if (char === '{' || char === '[') {
          depth++;
        } else if ((char === '}' || char === ']') && --depth === 0) {
          return position + 1;
        }
      }
      throw new Error('JSON 对象或数组不完整。');
    }
    let end = start;
    while (end < text.length && !',}] \t\r\n'.includes(text[end])) end++;
    return end;
  }

  function fields(text, start) {
    if (text[start] !== '{') return new Map();
    const items = new Map();
    let commaBefore = null;
    let position = skipSpace(text, start + 1);
    while (text[position] !== '}') {
      const keyEnd = stringEnd(text, position);
      const name = JSON.parse(text.slice(position, keyEnd));
      const value = skipSpace(text, skipSpace(text, keyEnd) + 1);
      const end = valueEnd(text, value);
      const delimiter = skipSpace(text, end);
      const commaAfter = text[delimiter] === ',' ? delimiter : null;
      if (items.has(name)) throw new Error('发现重复的 JSON 字段「' + name + '」。');
      items.set(name, { key: position, value, end, commaBefore, commaAfter });
      if (commaAfter === null) break;
      commaBefore = commaAfter;
      position = skipSpace(text, commaAfter + 1);
    }
    return items;
  }

  function* arrayStarts(text, start) {
    if (text[start] !== '[') return;
    let position = skipSpace(text, start + 1);
    while (text[position] !== ']') {
      yield position;
      const delimiter = skipSpace(text, valueEnd(text, position));
      if (text[delimiter] !== ',') return;
      position = skipSpace(text, delimiter + 1);
    }
  }

  function fieldBytes(text, span) {
    return span ? encoder.encode(text.slice(span.key, span.end)).length : 0;
  }

  function reportMessage(text, message, stats) {
    const messageFields = fields(text, skipSpace(text, 0));
    stats.messages++;
    if (message.xb_summary_hidden === true) stats.hidden++;
    const swipes = message.swipes;
    if (Array.isArray(swipes) && swipes.length === 1 && swipes[0] === message.mes) stats.singleCopies++;
    stats.sizes.mes += fieldBytes(text, messageFields.get('mes'));
    stats.sizes.swipes += fieldBytes(text, messageFields.get('swipes'));
    stats.sizes.variables += fieldBytes(text, messageFields.get('variables'));
    const extra = messageFields.get('extra');
    if (extra) {
      stats.sizes.reasoning += fieldBytes(text, fields(text, extra.value).get('reasoning'));
    }
    const swipeInfo = messageFields.get('swipe_info');
    if (swipeInfo) {
      for (const start of arrayStarts(text, swipeInfo.value)) {
        const nested = fields(text, start).get('extra');
        if (nested) stats.sizes.reasoning += fieldBytes(text, fields(text, nested.value).get('reasoning'));
      }
    }
    if (PLOT_LOG.test(message.mes)) stats.hasPlotLog = true;
  }

  function planEdits(text, metadata, snapshotSpan, stats) {
    const unsupported = message => ({ edits: [], message, analysisOnly: true });
    const empty = message => ({ edits: [], message });
    if (!snapshotSpan) return empty('这份聊天没有可清理的小白盒快照。');
    if (!isObject(metadata.LWB_SNAP)) return unsupported('小白盒快照格式超出已验证的清理范围。');

    const floors = Object.entries(metadata.LWB_SNAP);
    stats.snapshots = floors.length;
    if (floors.length === 0) return empty('这份聊天没有可清理的小白盒快照。');
    if (metadata.LWB_V1_OWNED_ROOTS_MIGRATED !== true
      || !isEmptyList(metadata.LWB_V1_OWNED_ROOTS)
      || !isEmptyObject(metadata.LWB_RULES)
      || stats.hasPlotLog) {
      return unsupported('这份档案的小白盒变量配置超出已验证的清理范围。');
    }
    if (floors.some(([id, record]) =>
      !/^(?:0|[1-9]\d*)$/.test(id) || Number(id) >= stats.messages
      || !isObject(record) || !isObject(record.vars)
      || !isEmptyList(record.roots) || !isEmptyObject(record.rules))) {
      return unsupported('快照格式或楼层索引超出已验证的清理范围。');
    }

    const floorSpans = fields(text, snapshotSpan.value);
    const ordered = floors.sort(([left], [right]) => Number(left) - Number(right));
    const edits = [];
    let previous;
    for (const [index, [floor, record]] of ordered.entries()) {
      const span = floorSpans.get(floor);
      const vars = fields(text, span.value).get('vars');
      const cache = fields(text, vars.value).get(CACHE_KEY);
      stats.snapshotCache += fieldBytes(text, cache);

      const contents = text.slice(span.value, span.end);
      const recent = index >= ordered.length - RECENT;
      const knownCache = isObject(record.vars[CACHE_KEY])
        && isObject(record.vars[CACHE_KEY]['绿灯缓存'])
        && Array.isArray(record.vars[CACHE_KEY]['绿灯缓存'].entries);
      // Whole-snapshot byte equality leaves every transition and unfamiliar cache format intact.
      if (!recent && contents === previous && cache && knownCache) {
        const start = cache.commaAfter === null ? (cache.commaBefore ?? cache.key) : cache.key;
        const end = cache.commaAfter === null ? cache.end : cache.commaAfter + 1;
        edits.push({ floor, start, end });
      }
      previous = contents;
    }
    return { edits, message: '可清理的重复缓存为 0 份。' };
  }

  async function walkLines(file, onLine, onProgress) {
    const reader = file.stream().getReader();
    let parts = [];
    let lineLength = 0;
    let read = 0;
    let lastProgress = -1;
    let lineNumber = 0;
    function consume(bytes) {
      let full = bytes;
      if (parts.length) {
        full = new Uint8Array(lineLength + bytes.length);
        let position = 0;
        for (const part of parts) {
          full.set(part, position);
          position += part.length;
        }
        full.set(bytes, position);
      }
      lineNumber++;
      let text;
      try {
        text = decoder.decode(full);
      } catch {
        throw new Error('第 ' + lineNumber + ' 行不是有效的 UTF-8 文本。');
      }
      try {
        onLine(text, lineNumber);
      } catch (error) {
        const message = error instanceof SyntaxError ? '不是有效的 JSON。' : error.message;
        throw new Error('第 ' + lineNumber + ' 行：' + message);
      }
      parts = [];
      lineLength = 0;
    }

    let finished = false;
    try {
      for (;;) {
        const { done, value: block } = await reader.read();
        if (done) break;
        let start = 0;
        for (let newline = block.indexOf(10, start); newline !== -1; newline = block.indexOf(10, start)) {
          consume(block.subarray(start, newline));
          start = newline + 1;
        }
        if (start < block.length) {
          const tail = block.subarray(start);
          parts.push(tail);
          lineLength += tail.length;
        }
        read += block.length;
        const percent = Math.min(99, Math.floor(100 * read / file.size));
        if (percent !== lastProgress) {
          onProgress(percent);
          lastProgress = percent;
        }
      }
      if (lineLength) consume(new Uint8Array());
      finished = true;
    } finally {
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return async function analyze(file, onProgress) {
    if (file.size === 0) throw new Error('文件为空。请选择一份酒馆聊天记录。');
    const stats = {
      bytes: file.size, messages: 0, hidden: 0, snapshots: 0, snapshotCache: 0, singleCopies: 0, hasPlotLog: false,
      sizes: { snapshots: 0, mes: 0, swipes: 0, reasoning: 0, variables: 0 },
    };
    let header;
    let metadata;
    let snapshotSpan;
    await walkLines(file, (text, line) => {
      if (line === 1) {
        const tokenStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        const first = JSON.parse(text.slice(tokenStart));
        if (!isObject(first?.chat_metadata)) {
          throw new Error('缺少酒馆聊天元数据，请使用酒馆导出的 .jsonl。');
        }
        header = text;
        metadata = first.chat_metadata;
        const root = fields(text, skipSpace(text, tokenStart));
        const metaSpan = root.get('chat_metadata');
        snapshotSpan = fields(text, metaSpan.value).get('LWB_SNAP');
        stats.sizes.snapshots = fieldBytes(text, snapshotSpan);
      } else if (text.trim()) {
        const message = JSON.parse(text);
        if (!isObject(message) || typeof message.mes !== 'string') {
          throw new Error('缺少有效的聊天消息字段。');
        }
        reportMessage(text, message, stats);
      }
    }, onProgress);

    const plan = planEdits(header, metadata, snapshotSpan, stats);
    const accounted = Object.values(stats.sizes).reduce((sum, size) => sum + size, 0);
    stats.sizes.other = file.size - accounted;
    const removedBytes = plan.edits.reduce((total, { start, end }) =>
      total + encoder.encode(header.slice(start, end)).length, 0);
    return {
      stats,
      afterBytes: file.size - removedBytes,
      floors: plan.edits.map(edit => edit.floor),
      message: plan.message,
      analysisOnly: plan.analysisOnly,
    };
  };
}
