import { describe, expect, it } from 'vitest';
import { createSseDecoder, encodeSse } from '../sse';

describe('SSE codec', () => {
  it('encodes one event per block with JSON data', () => {
    expect(encodeSse('text', { delta: 'a\nb' })).toBe('event: text\ndata: {"delta":"a\\nb"}\n\n');
  });

  it('decodes events split at arbitrary chunk boundaries', () => {
    const wire = encodeSse('text', { delta: '안녕' }) + encodeSse('filter', { patch: { query: 'web' } }) + encodeSse('done', {});
    const d = createSseDecoder();
    const out = [];
    for (let i = 0; i < wire.length; i += 7) out.push(...d.push(wire.slice(i, i + 7)));
    out.push(...d.end());
    expect(out.map((m) => m.event)).toEqual(['text', 'filter', 'done']);
    expect(JSON.parse(out[0].data)).toEqual({ delta: '안녕' });
    expect(JSON.parse(out[1].data)).toEqual({ patch: { query: 'web' } });
  });

  it('handles CRLF, comments, a missing event name and a trailing block without blank line', () => {
    const d = createSseDecoder();
    const first = d.push(': keep-alive\r\nevent: text\r\ndata: {"delta":"x"}\r\n\r\ndata: {"n":1}');
    expect(first).toEqual([{ event: 'text', data: '{"delta":"x"}' }]);
    expect(d.end()).toEqual([{ event: 'message', data: '{"n":1}' }]);
    expect(d.end()).toEqual([]);
  });

  it('joins multi-line data fields', () => {
    const d = createSseDecoder();
    expect(d.push('event: e\ndata: a\ndata: b\n\n')).toEqual([{ event: 'e', data: 'a\nb' }]);
  });
});
