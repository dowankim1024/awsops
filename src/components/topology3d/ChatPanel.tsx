'use client';

// Natural-language side of the shared filter. Sends the last turns plus the
// current filter and graph summary to /api/topology3d-chat, streams the reply
// over SSE, and applies the validated `set_filter` patch through onPatch — the
// same path the checkboxes use. Each applied patch remembers the filter before
// it so the user can undo. The panel never touches the scene.
// 공유 필터의 자연어 쪽. 최근 대화 + 현재 필터 + 그래프 요약을 보내고 SSE로 답을 받아
// 검증된 패치를 onPatch로 적용한다(체크박스와 같은 경로). 적용 전 필터를 기억해 되돌릴 수 있다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, RotateCcw, Square, Trash2 } from 'lucide-react';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import {
  diffFilter,
  type ChatRequestBody,
  type ChatTurn,
  type FilterChange,
  type GraphSummary,
} from '@/lib/topology/chat';
import { mergeFilter, type TopologyFilter, type TopologyFilterPatch } from '@/lib/topology/filter';
import { createSseDecoder } from '@/lib/topology/sse';

export interface ChatPanelProps {
  filter: TopologyFilter;
  summary: GraphSummary | null;
  onPatch: (patch: TopologyFilterPatch) => void;
  onRestore: (filter: TopologyFilter) => void;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  error?: string;
  // Set when the reply applied a patch. / 답변이 패치를 적용했을 때.
  before?: TopologyFilter;
  changes?: FilterChange[];
  rejected?: string[];
  undone?: boolean;
}

const HISTORY_TURNS = 10;
const SUGGESTION_KEYS = ['suggestion1', 'suggestion2', 'suggestion3', 'suggestion4'] as const;

function changeLabel(c: FilterChange, t: (k: string, p?: Record<string, string | number>) => string): string {
  switch (c.field) {
    case 'vpcId':
      return t('topology3d.chat.change.vpc', { value: c.value ?? '—' });
    case 'tiers':
      return t(c.value ? 'topology3d.chat.change.tierOn' : 'topology3d.chat.change.tierOff', {
        key: t(`topology3d.filter.${c.key}`),
      });
    case 'kinds':
      return t(c.value ? 'topology3d.chat.change.kindOn' : 'topology3d.chat.change.kindOff', { key: c.key });
    case 'azs':
      return c.value === null
        ? t('topology3d.chat.change.azsAll')
        : t('topology3d.chat.change.azs', { value: c.value.map((a) => a.replace(/^.*(?=\d[a-z]$)/, '')).join(', ') });
    case 'includeEmptySubnets':
      return t(c.value ? 'topology3d.chat.change.emptyOn' : 'topology3d.chat.change.emptyOff');
    case 'query':
      return c.value ? t('topology3d.chat.change.query', { value: c.value }) : t('topology3d.chat.change.queryClear');
  }
}

export default function ChatPanel({ filter, summary, onPatch, onRestore }: ChatPanelProps) {
  const { t, lang } = useLanguage();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The patch arrives after the user may have clicked checkboxes mid-stream, so
  // "before" is read from the latest filter, not the one at send time.
  // 스트리밍 중 체크박스를 눌렀을 수 있으니 before는 최신 필터에서 읽는다.
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const update = useCallback((id: number, fn: (m: Message) => Message) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy || !summary) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: Message = { id: nextId.current++, role: 'user', text: body };
      const replyId = nextId.current++;
      const history: ChatTurn[] = [...messages, userMsg]
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, text: m.text }))
        .slice(-HISTORY_TURNS);
      setMessages((prev) => [...prev, userMsg, { id: replyId, role: 'assistant', text: '', streaming: true }]);
      setInput('');
      setBusy(true);

      const payload: ChatRequestBody = { messages: history, filter: filterRef.current, summary, lang };
      try {
        const res = await fetch('/api/topology3d-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let message = `HTTP ${res.status}`;
          try {
            message = ((await res.json()) as { error?: string }).error || message;
          } catch {
            /* body was not JSON */
          }
          throw new Error(message);
        }

        const reader = res.body.getReader();
        const textDecoder = new TextDecoder();
        const sse = createSseDecoder();
        const handle = (event: string, raw: string) => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw);
          } catch {
            return;
          }
          if (event === 'text' && typeof data.delta === 'string') {
            const delta = data.delta;
            update(replyId, (m) => ({ ...m, text: m.text + delta }));
          } else if (event === 'filter') {
            const patch = (data.patch ?? {}) as TopologyFilterPatch;
            const rejected = Array.isArray(data.rejected) ? (data.rejected as string[]) : [];
            const before = filterRef.current;
            const after = mergeFilter(before, patch);
            const changes = diffFilter(before, after);
            if (changes.length) onPatch(patch);
            update(replyId, (m) => ({ ...m, before: changes.length ? before : undefined, changes, rejected }));
          } else if (event === 'error') {
            update(replyId, (m) => ({ ...m, error: String(data.message ?? 'error') }));
          }
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sse.push(textDecoder.decode(value, { stream: true })).forEach((m) => handle(m.event, m.data));
        }
        sse.end().forEach((m) => handle(m.event, m.data));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          update(replyId, (m) => ({ ...m, error: (e as Error).message }));
        }
      } finally {
        update(replyId, (m) => ({ ...m, streaming: false }));
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, summary, messages, lang, onPatch, update]
  );

  const stop = () => abortRef.current?.abort();
  const clear = () => {
    abortRef.current?.abort();
    setMessages([]);
  };
  const undo = (m: Message) => {
    if (!m.before) return;
    onRestore(m.before);
    update(m.id, (x) => ({ ...x, undone: true }));
  };

  return (
    <div className="flex flex-col h-full bg-navy-800 rounded-lg border border-navy-600">
      <div className="flex items-center justify-between px-4 py-3 border-b border-navy-600">
        <h2 className="text-sm font-semibold text-white">{t('topology3d.chat.title')}</h2>
        <button
          type="button"
          onClick={clear}
          disabled={messages.length === 0}
          className="p-1.5 rounded text-gray-400 hover:text-accent-red hover:bg-navy-700 disabled:opacity-40"
          title={t('topology3d.chat.clear')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">{t('topology3d.chat.empty')}</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTION_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={!summary}
                  onClick={() => void send(t(`topology3d.chat.${k}`))}
                  className="rounded-full border border-navy-600 px-2.5 py-1 text-[11px] text-gray-300 hover:border-accent-cyan/50 hover:text-accent-cyan disabled:opacity-40"
                >
                  {t(`topology3d.chat.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                m.role === 'user' ? 'bg-accent-cyan/15 text-white' : 'bg-navy-700 text-gray-200'
              }`}
            >
              {m.text}
              {m.streaming && !m.text && <span className="text-gray-500">{t('topology3d.chat.thinking')}</span>}
              {m.streaming && m.text && <span className="inline-block w-1.5 h-3 ml-0.5 bg-accent-cyan/70 animate-pulse align-middle" />}
              {m.error && <p className="mt-1 text-accent-red">{t('topology3d.chat.error', { message: m.error })}</p>}

              {m.changes && (
                <div className="mt-2 pt-2 border-t border-navy-600 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-accent-cyan">
                      {m.changes.length ? t('topology3d.chat.applied') : t('topology3d.chat.noChange')}
                    </span>
                    {m.before && !m.undone && (
                      <button
                        type="button"
                        onClick={() => undo(m)}
                        className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-accent-orange"
                      >
                        <RotateCcw size={11} />
                        {t('topology3d.chat.undo')}
                      </button>
                    )}
                    {m.undone && <span className="text-[11px] text-gray-500">{t('topology3d.chat.undone')}</span>}
                  </div>
                  {m.changes.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.changes.map((c, i) => (
                        <span key={i} className="rounded bg-navy-900 px-1.5 py-0.5 font-mono text-[10px] text-gray-300">
                          {changeLabel(c, t)}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.rejected && m.rejected.length > 0 && (
                    <p className="text-[11px] text-accent-orange">
                      {t('topology3d.chat.rejected', { items: m.rejected.join(', ') })}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        className="flex items-end gap-2 p-3 border-t border-navy-600"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={2}
          disabled={!summary}
          placeholder={summary ? t('topology3d.chat.placeholder') : t('topology3d.chat.noGraph')}
          className="flex-1 resize-none bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-white placeholder:text-gray-600 disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="p-2 rounded border border-navy-600 text-gray-300 hover:text-accent-red"
            title={t('topology3d.chat.stop')}
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || !summary}
            className="p-2 rounded border border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan disabled:opacity-40"
            title={t('topology3d.chat.send')}
          >
            <CornerDownLeft size={13} />
          </button>
        )}
      </form>
    </div>
  );
}
