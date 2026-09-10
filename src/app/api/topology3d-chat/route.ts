// 3D topology filter chat. Unlike topology-chat, the graph itself never reaches
// the model: the prompt carries the filter schema, the current filter and a
// summary (VPCs, AZs, counts by kind). The model answers in text and may call
// the `set_filter` tool; the tool input is validated here (sanitizePatch →
// mergeFilter) before it is sent to the client. Text streams over SSE as it
// arrives; the filter patch is sent once at the end.
// 3D 토폴로지 필터 채팅. 그래프 전체는 모델에 가지 않는다. 스키마 + 현재 필터 + 요약만 보낸다.
// 모델은 텍스트로 답하고 set_filter 도구를 부를 수 있으며, 도구 입력은 여기서 검증한 뒤 내려보낸다.
// 텍스트는 SSE로 스트리밍, 패치는 스트림 끝에 한 번. ADR-013 참조.
//
// This is a real Bedrock call in the deployment account (per-token cost).
// 배포 계정에서 실제 Bedrock을 호출한다 (토큰 과금).
import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

import { getConfig } from '@/lib/app-config';
import {
  SET_FILTER_TOOL,
  SET_FILTER_TOOL_NAME,
  buildSystemPrompt,
  createConverseReducer,
  sanitizeFilter,
  sanitizePatch,
  sanitizeSummary,
  toConverseMessages,
  type ChatSseEvent,
} from '@/lib/topology/chat';
import { mergeFilter } from '@/lib/topology/filter';
import { encodeSse } from '@/lib/topology/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same default the other Bedrock routes use; override with config.topology3d.chatModelId.
// 다른 Bedrock 라우트와 같은 기본값. config.topology3d.chatModelId로 바꾼다.
const DEFAULT_MODEL_ID = 'global.anthropic.claude-opus-4-8';
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const MAX_TOKENS = 600;

let client: BedrockRuntimeClient | null = null;
const bedrock = (): BedrockRuntimeClient => {
  if (!client) client = new BedrockRuntimeClient({ region: REGION });
  return client;
};

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const messages = toConverseMessages(body.messages);
  if (!messages.length) {
    return NextResponse.json({ error: 'messages must end with a non-empty user turn' }, { status: 400 });
  }
  const filter = sanitizeFilter(body.filter);
  const summary = sanitizeSummary(body.summary);
  const lang = typeof body.lang === 'string' ? body.lang : 'en';
  const modelId = getConfig().topology3d?.chatModelId || DEFAULT_MODEL_ID;

  const command = new ConverseStreamCommand({
    modelId,
    system: [{ text: buildSystemPrompt(summary, filter, lang) }],
    messages: messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
    toolConfig: {
      tools: [{ toolSpec: SET_FILTER_TOOL }],
      toolChoice: { auto: {} },
    },
    inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0 },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: ChatSseEvent) => controller.enqueue(encoder.encode(encodeSse(ev.event, ev.data)));
      const startedAt = Date.now();
      try {
        const res = await bedrock().send(command);
        const reducer = createConverseReducer();
        for await (const ev of res.stream ?? []) {
          const delta = reducer.push(ev);
          if (delta) send({ event: 'text', data: { delta } });
        }
        const result = reducer.result();

        const call = result.toolCalls.find((c) => c.name === SET_FILTER_TOOL_NAME);
        if (call) {
          const { patch, rejected } = call.parseError
            ? { patch: {}, rejected: [`tool input: ${call.parseError}`] }
            : sanitizePatch(call.input, summary);
          send({ event: 'filter', data: { patch, filter: mergeFilter(filter, patch), rejected } });
        }
        send({ event: 'done', data: { usage: result.usage, stopReason: result.stopReason } });
        console.log(
          `[Topology3dChat] ${modelId} ${Date.now() - startedAt}ms in=${result.usage?.inputTokens ?? '?'} out=${
            result.usage?.outputTokens ?? '?'
          } tool=${call ? 'set_filter' : 'none'}`
        );
      } catch (err) {
        const message = (err as Error).message || 'chat failed';
        console.error('[Topology3dChat] failed:', message);
        send({ event: 'error', data: { message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
