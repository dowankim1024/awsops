// Minimal Server-Sent Events codec shared by the chat route (encode) and the
// chat panel (decode). Pure: feed strings, get events. No fetch here.
// 채팅 라우트(인코드)와 패널(디코드)이 공유하는 최소 SSE 코덱. 순수 함수.

export interface SseMessage {
  event: string;
  data: string;
}

// One event = `event: <name>\ndata: <json>\n\n`. Data is JSON-encoded so it never
// contains a bare newline.
// 이벤트 하나는 event/data 두 줄과 빈 줄. data는 JSON이라 개행이 없다.
export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseDecoder {
  // Push a chunk (any boundary); returns the complete events it finished.
  // 청크를 넣으면 완성된 이벤트만 돌려준다. 경계는 아무 데나 와도 된다.
  push(chunk: string): SseMessage[];
  // Flush a trailing event that had no blank line (stream ended).
  // 빈 줄 없이 끝난 마지막 이벤트를 꺼낸다.
  end(): SseMessage[];
}

export function createSseDecoder(): SseDecoder {
  let buffer = '';

  const parseBlock = (block: string): SseMessage | null => {
    let event = 'message';
    const data: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return null;
    return { event, data: data.join('\n') };
  };

  return {
    push(chunk) {
      buffer += chunk;
      const out: SseMessage[] = [];
      let idx: number;
      // Blocks end with a blank line; accept \n\n and \r\n\r\n.
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const msg = parseBlock(block);
        if (msg) out.push(msg);
      }
      return out;
    },
    end() {
      const rest = buffer;
      buffer = '';
      if (!rest.trim()) return [];
      const msg = parseBlock(rest);
      return msg ? [msg] : [];
    },
  };
}
