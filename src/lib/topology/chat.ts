// Everything the filter chat needs that is not I/O: the graph summary that goes
// into the prompt, the system prompt itself, the `set_filter` tool schema, the
// validator that turns raw model output into a safe TopologyFilterPatch, a
// reducer over Bedrock ConverseStream events, and a filter diff for the UI.
// The route (src/app/api/topology3d-chat) only wires these to Bedrock and SSE.
// 필터 채팅의 순수 부분. 프롬프트에 들어갈 그래프 요약, 시스템 프롬프트, set_filter 도구 스키마,
// 모델 출력을 안전한 패치로 바꾸는 검증기, ConverseStream 이벤트 리듀서, UI용 필터 diff.
// 라우트는 이것들을 Bedrock과 SSE에 잇기만 한다. ADR-013 참조.
import {
  DEFAULT_FILTER,
  mergeFilter,
  resolveVpcId,
  type TopologyFilter,
  type TopologyFilterPatch,
} from './filter';
import {
  GLOBAL_KINDS,
  NODE_KINDS,
  TIERS,
  isNodeKind,
  isTier,
  type NodeKind,
  type Tier,
  type TopologyGraph,
} from './types';

// ---- Graph summary (what the model sees instead of the graph) ----
// 그래프 대신 모델이 보는 요약. VPC 목록, AZ 목록, 종류별 개수만.

export interface GraphSummaryVpc {
  id: string;
  name: string;
  cidr: string;
  subnets: number;
  nodes: number;
}

export interface GraphSummary {
  source: TopologyGraph['meta']['source'];
  accountId?: string;
  vpcId: string | null; // the VPC the current filter resolves to / 현재 필터가 가리키는 VPC
  vpcs: GraphSummaryVpc[];
  azs: string[]; // AZs present in the current VPC / 현재 VPC의 AZ
  tiers: Record<Tier, number>; // subnet count per tier in the current VPC / 티어별 서브넷 수
  kinds: Partial<Record<NodeKind, number>>; // node count per kind (current VPC + account-global) / 종류별 노드 수
}

export function summarizeGraph(g: TopologyGraph, f: Pick<TopologyFilter, 'vpcId'>): GraphSummary {
  const vpcId = resolveVpcId(g, f);
  const subnetsByVpc = new Map<string, number>();
  const nodesByVpc = new Map<string, number>();
  g.subnets.forEach((s) => subnetsByVpc.set(s.vpcId, (subnetsByVpc.get(s.vpcId) ?? 0) + 1));
  g.nodes.forEach((n) => {
    if (n.vpcId) nodesByVpc.set(n.vpcId, (nodesByVpc.get(n.vpcId) ?? 0) + 1);
  });

  const azs = new Set<string>();
  const tiers: Record<Tier, number> = { public: 0, private: 0 };
  g.subnets.forEach((s) => {
    if (s.vpcId !== vpcId) return;
    if (s.az) azs.add(s.az);
    tiers[s.tier] += 1;
  });
  const kinds: Partial<Record<NodeKind, number>> = {};
  g.nodes.forEach((n) => {
    if (n.vpcId !== undefined && n.vpcId !== vpcId) return;
    if (n.vpcId === vpcId && n.az) azs.add(n.az);
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  });

  return {
    source: g.meta.source,
    accountId: g.meta.accountId,
    vpcId,
    vpcs: g.vpcs.map((v) => ({
      id: v.id,
      name: v.name,
      cidr: v.cidr,
      subnets: subnetsByVpc.get(v.id) ?? 0,
      nodes: nodesByVpc.get(v.id) ?? 0,
    })),
    azs: Array.from(azs).sort(),
    tiers,
    kinds,
  };
}

// A summary coming over the wire is untrusted; keep only well-typed fields.
// 클라이언트가 보낸 요약은 신뢰하지 않는다. 형이 맞는 필드만 남긴다.
export function sanitizeSummary(raw: unknown): GraphSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const vpcs: GraphSummaryVpc[] = Array.isArray(r.vpcs)
    ? r.vpcs
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
        .map((v) => ({
          id: str(v.id),
          name: str(v.name),
          cidr: str(v.cidr),
          subnets: num(v.subnets),
          nodes: num(v.nodes),
        }))
        .filter((v) => v.id)
        .slice(0, 64)
    : [];
  const azs = Array.isArray(r.azs) ? r.azs.filter((a): a is string => typeof a === 'string' && !!a).slice(0, 32) : [];
  const t = (r.tiers && typeof r.tiers === 'object' ? r.tiers : {}) as Record<string, unknown>;
  const k = (r.kinds && typeof r.kinds === 'object' ? r.kinds : {}) as Record<string, unknown>;
  const kinds: Partial<Record<NodeKind, number>> = {};
  Object.entries(k).forEach(([key, v]) => {
    if (isNodeKind(key)) kinds[key] = num(v);
  });
  const source = r.source === 'live' || r.source === 'fixture' || r.source === 'generator' ? r.source : 'fixture';
  const vpcId = typeof r.vpcId === 'string' && vpcs.some((v) => v.id === r.vpcId) ? r.vpcId : vpcs[0]?.id ?? null;
  return {
    source,
    accountId: typeof r.accountId === 'string' ? r.accountId : undefined,
    vpcId,
    vpcs,
    azs,
    tiers: { public: num(t.public), private: num(t.private) },
    kinds,
  };
}

// ---- Tool schema ----
// The model never edits the scene; it can only propose a filter patch.
// 모델은 씬을 건드리지 못한다. 필터 패치만 제안한다.

export const SET_FILTER_TOOL_NAME = 'set_filter';

export const SET_FILTER_TOOL = {
  name: SET_FILTER_TOOL_NAME,
  description:
    'Change what the 3D topology shows by patching the current filter. Only include the fields you want to change; omitted fields keep their current value. Use it whenever the user asks to show, hide, focus, isolate, search or switch anything. Do not call it for questions.',
  inputSchema: {
    json: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vpcId: {
          type: 'string',
          description: 'Switch to this VPC. Use the id from AVAILABLE VPCS (the name is also accepted).',
        },
        tiers: {
          type: 'object',
          description: 'Show (true) or hide (false) subnet tiers. Hiding a tier hides its subnets and the nodes in them.',
          properties: Object.fromEntries(TIERS.map((t) => [t, { type: 'boolean' }])),
          additionalProperties: false,
        },
        kinds: {
          type: 'object',
          description:
            'Show (true) or hide (false) resource kinds. To show ONLY some kinds, set those true and every other currently-visible kind false.',
          properties: Object.fromEntries(NODE_KINDS.map((k) => [k, { type: 'boolean' }])),
          additionalProperties: false,
        },
        azs: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Restrict to these availability zones (full names from AVAILABLE AZS). null = every AZ.',
        },
        includeEmptySubnets: {
          type: 'boolean',
          description: 'true keeps subnets that contain no visible node.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against node names and ids. Empty string clears the search.',
        },
      },
    },
  },
};

// ---- Prompt ----

const LANGUAGE_NAMES: Record<string, string> = { ko: 'Korean', en: 'English', zh: 'Chinese' };

function describeFilter(f: TopologyFilter): string {
  const hiddenTiers = TIERS.filter((t) => !f.tiers[t]);
  const hiddenKinds = NODE_KINDS.filter((k) => !f.kinds[k]);
  const visibleKinds = NODE_KINDS.filter((k) => f.kinds[k]);
  return [
    `vpcId: ${f.vpcId ?? '(first VPC)'}`,
    `tiers hidden: ${hiddenTiers.length ? hiddenTiers.join(', ') : 'none'}`,
    `kinds visible: ${visibleKinds.join(', ') || 'none'}`,
    `kinds hidden: ${hiddenKinds.join(', ') || 'none'}`,
    `azs: ${f.azs ? f.azs.join(', ') : 'all'}`,
    `includeEmptySubnets: ${f.includeEmptySubnets}`,
    `query: ${f.query ? JSON.stringify(f.query) : '(none)'}`,
  ].join('\n');
}

export function buildSystemPrompt(summary: GraphSummary, filter: TopologyFilter, lang: string): string {
  const language = LANGUAGE_NAMES[lang] ?? 'English';
  const vpcLines = summary.vpcs.length
    ? summary.vpcs
        .map(
          (v) =>
            `- ${v.id} "${v.name}" ${v.cidr} (${v.subnets} subnets, ${v.nodes} nodes)${
              v.id === summary.vpcId ? ' ← current' : ''
            }`
        )
        .join('\n')
    : '- (none)';
  const kindLines =
    Object.entries(summary.kinds)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ') || '(none)';

  return `You are the filter assistant for the AWSops 3D topology view. The user looks at one VPC of an AWS account rendered in 3D (VPC plates → AZ lanes → public/private subnet tiers → resource nodes; account-global resources sit in a tray beside the VPC). You cannot draw or edit anything; the only thing you control is the view FILTER, through the ${SET_FILTER_TOOL_NAME} tool.

DATA SOURCE: ${summary.source}${summary.accountId ? ` (account ${summary.accountId})` : ''}

AVAILABLE VPCS:
${vpcLines}

AVAILABLE AZS (current VPC): ${summary.azs.length ? summary.azs.join(', ') : '(none)'}
SUBNETS BY TIER (current VPC): public=${summary.tiers.public}, private=${summary.tiers.private}
NODES BY KIND (current VPC + account-global): ${kindLines}
ALL KINDS: ${NODE_KINDS.join(', ')} (account-global, hidden by default: ${GLOBAL_KINDS.join(', ')})

CURRENT FILTER:
${describeFilter(filter)}

RULES:
- When the user wants to see, hide, isolate, focus, search or switch something, call ${SET_FILTER_TOOL_NAME} with ONLY the fields that change, then reply with one short sentence saying what changed.
- "only X" / "just X" means: set X true and every currently visible kind that is not X to false. "also X" means: set X true and leave the rest.
- "show everything" / "reset" means: every tier true, every kind true except the account-global ones (${GLOBAL_KINDS.join(', ')}), azs null, query "".
- AZ names must be the full names listed above ("2a" or "a" refers to the AZ that ends with "a").
- Refer to VPCs by id from the list; if the user names a VPC that is not listed, say so and do not call the tool.
- For a question ("how many EC2 are there?", "what is a NAT gateway?") answer from the numbers above in plain text without calling the tool. Never invent counts.
- Requests outside the filter (moving cameras, changing colours, editing resources, anything about AWS itself) are not supported: say so briefly.
- Reply in ${language}. Keep replies under two sentences. No markdown headings, no code blocks.`;
}

// ---- Conversation shaping ----
// Converse requires user/assistant alternation starting with a user turn, and no
// empty text blocks. History from the client is trimmed and repaired here.
// Converse는 user로 시작하는 교대 순서와 비어 있지 않은 텍스트를 요구한다.
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export const MAX_HISTORY_TURNS = 10;
const EMPTY_ASSISTANT_TEXT = '(filter updated)';

export function toConverseMessages(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { role, text } = item as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') continue;
    const body = typeof text === 'string' ? text.trim() : '';
    if (role === 'user' && !body) continue;
    const t: ChatTurn = { role, text: body || EMPTY_ASSISTANT_TEXT };
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.text = `${prev.text}\n${t.text}`;
    else turns.push(t);
  }
  if (turns.length && turns[turns.length - 1].role !== 'user') turns.pop();
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

// ---- Patch validation ----
// The model output is data. Unknown kinds/tiers/AZs/VPCs are dropped and reported,
// never applied. AZ and VPC references are resolved against the summary.
// 모델 출력은 데이터다. 모르는 값은 버리고 rejected에 남긴다.

export interface SanitizedPatch {
  patch: TopologyFilterPatch;
  rejected: string[];
}

function resolveAz(value: string, known: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const exact = known.find((a) => a.toLowerCase() === v);
  if (exact) return exact;
  const bySuffix = known.filter((a) => a.toLowerCase().endsWith(v));
  return bySuffix.length === 1 ? bySuffix[0] : null;
}

function resolveVpc(value: string, vpcs: GraphSummaryVpc[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const byId = vpcs.find((x) => x.id.toLowerCase() === v);
  if (byId) return byId.id;
  const byName = vpcs.filter((x) => x.name.toLowerCase() === v);
  return byName.length === 1 ? byName[0].id : null;
}

export function sanitizePatch(raw: unknown, summary: GraphSummary): SanitizedPatch {
  const rejected: string[] = [];
  const patch: TopologyFilterPatch = {};
  if (!raw || typeof raw !== 'object') return { patch, rejected: ['patch is not an object'] };
  const r = raw as Record<string, unknown>;

  if (r.vpcId !== undefined) {
    if (r.vpcId === null) patch.vpcId = null;
    else if (typeof r.vpcId === 'string') {
      const id = resolveVpc(r.vpcId, summary.vpcs);
      if (id) patch.vpcId = id;
      else rejected.push(`vpcId: ${r.vpcId}`);
    } else rejected.push('vpcId: not a string');
  }

  if (r.tiers !== undefined) {
    if (r.tiers && typeof r.tiers === 'object') {
      const tiers: Partial<Record<Tier, boolean>> = {};
      for (const [k, v] of Object.entries(r.tiers)) {
        if (isTier(k) && typeof v === 'boolean') tiers[k] = v;
        else rejected.push(`tiers.${k}`);
      }
      if (Object.keys(tiers).length) patch.tiers = tiers;
    } else rejected.push('tiers: not an object');
  }

  if (r.kinds !== undefined) {
    if (r.kinds && typeof r.kinds === 'object') {
      const kinds: Partial<Record<NodeKind, boolean>> = {};
      for (const [k, v] of Object.entries(r.kinds)) {
        if (isNodeKind(k) && typeof v === 'boolean') kinds[k] = v;
        else rejected.push(`kinds.${k}`);
      }
      if (Object.keys(kinds).length) patch.kinds = kinds;
    } else rejected.push('kinds: not an object');
  }

  if (r.azs !== undefined) {
    if (r.azs === null) patch.azs = null;
    else if (Array.isArray(r.azs)) {
      const azs: string[] = [];
      for (const a of r.azs) {
        const hit = typeof a === 'string' ? resolveAz(a, summary.azs) : null;
        if (hit) azs.push(hit);
        else rejected.push(`azs: ${String(a)}`);
      }
      // A list that resolved to nothing must not blank the scene.
      // 하나도 못 찾은 목록으로 화면을 비우지 않는다.
      if (azs.length) patch.azs = Array.from(new Set(azs));
      else if (r.azs.length === 0) patch.azs = null;
    } else rejected.push('azs: not an array');
  }

  if (r.includeEmptySubnets !== undefined) {
    if (typeof r.includeEmptySubnets === 'boolean') patch.includeEmptySubnets = r.includeEmptySubnets;
    else rejected.push('includeEmptySubnets: not a boolean');
  }

  if (r.query !== undefined) {
    if (typeof r.query === 'string') patch.query = r.query.trim().slice(0, 200);
    else rejected.push('query: not a string');
  }

  return { patch, rejected };
}

// Filter sent by the client is untrusted too; rebuild it from defaults.
// 클라이언트가 보낸 필터도 신뢰하지 않는다. 기본값 위에 다시 합친다.
export function sanitizeFilter(raw: unknown): TopologyFilter {
  const base = mergeFilter(DEFAULT_FILTER, {});
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const patch: TopologyFilterPatch = {};
  if (r.vpcId === null || typeof r.vpcId === 'string') patch.vpcId = r.vpcId as string | null;
  if (r.tiers && typeof r.tiers === 'object') patch.tiers = r.tiers as Partial<Record<Tier, boolean>>;
  if (r.kinds && typeof r.kinds === 'object') patch.kinds = r.kinds as Partial<Record<NodeKind, boolean>>;
  if (r.azs === null) patch.azs = null;
  else if (Array.isArray(r.azs)) patch.azs = r.azs.filter((a): a is string => typeof a === 'string');
  if (typeof r.includeEmptySubnets === 'boolean') patch.includeEmptySubnets = r.includeEmptySubnets;
  if (typeof r.query === 'string') patch.query = r.query;
  return mergeFilter(base, patch);
}

// ---- ConverseStream reducer ----
// Structural subset of the SDK's ConverseStreamOutput so this file needs no SDK
// import and the reducer can be tested with plain objects.
// SDK 타입의 구조적 부분집합. SDK 없이 테스트한다.
export interface ConverseStreamEvent {
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: { toolUse?: { toolUseId?: string; name?: string } };
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: { text?: string; toolUse?: { input?: string } };
  };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: string };
  metadata?: { usage?: { inputTokens?: number; outputTokens?: number } };
}

export interface ConverseToolCall {
  name: string;
  input: unknown; // parsed JSON, or the raw string when parsing failed / 파싱 실패 시 원문
  parseError?: string;
}

export interface ConverseResult {
  text: string;
  toolCalls: ConverseToolCall[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ConverseReducer {
  // Feeds one event; returns the text delta it carried (for streaming), if any.
  // 이벤트 하나를 넣고, 텍스트 델타가 있으면 돌려준다.
  push(ev: ConverseStreamEvent): string | undefined;
  result(): ConverseResult;
}

export function createConverseReducer(): ConverseReducer {
  let text = '';
  const toolCalls: ConverseToolCall[] = [];
  const open = new Map<number, { name: string; json: string }>();
  let stopReason: string | undefined;
  let usage: ConverseResult['usage'];

  return {
    push(ev) {
      if (ev.contentBlockStart?.start?.toolUse) {
        const idx = ev.contentBlockStart.contentBlockIndex ?? 0;
        open.set(idx, { name: ev.contentBlockStart.start.toolUse.name ?? '', json: '' });
        return undefined;
      }
      if (ev.contentBlockDelta?.delta) {
        const idx = ev.contentBlockDelta.contentBlockIndex ?? 0;
        const d = ev.contentBlockDelta.delta;
        if (typeof d.text === 'string' && d.text) {
          text += d.text;
          return d.text;
        }
        if (d.toolUse && typeof d.toolUse.input === 'string') {
          const block = open.get(idx);
          if (block) block.json += d.toolUse.input;
        }
        return undefined;
      }
      if (ev.contentBlockStop) {
        const idx = ev.contentBlockStop.contentBlockIndex ?? 0;
        const block = open.get(idx);
        if (block) {
          open.delete(idx);
          const raw = block.json.trim() || '{}';
          try {
            toolCalls.push({ name: block.name, input: JSON.parse(raw) });
          } catch (e) {
            toolCalls.push({ name: block.name, input: raw, parseError: (e as Error).message });
          }
        }
        return undefined;
      }
      if (ev.messageStop) stopReason = ev.messageStop.stopReason;
      if (ev.metadata?.usage) usage = ev.metadata.usage;
      return undefined;
    },
    result() {
      // Blocks that never got a stop event still count (defensive).
      // stop 이벤트 없이 끝난 블록도 버리지 않는다.
      open.forEach((block) => {
        const raw = block.json.trim() || '{}';
        try {
          toolCalls.push({ name: block.name, input: JSON.parse(raw) });
        } catch (e) {
          toolCalls.push({ name: block.name, input: raw, parseError: (e as Error).message });
        }
      });
      open.clear();
      return { text, toolCalls: [...toolCalls], stopReason, usage };
    },
  };
}

// ---- Filter diff (for the "what changed" notice) ----
// 채팅 패널의 "무엇이 바뀌었나" 표시용.
export type FilterChange =
  | { field: 'vpcId'; value: string | null }
  | { field: 'tiers'; key: Tier; value: boolean }
  | { field: 'kinds'; key: NodeKind; value: boolean }
  | { field: 'azs'; value: string[] | null }
  | { field: 'includeEmptySubnets'; value: boolean }
  | { field: 'query'; value: string };

export function diffFilter(before: TopologyFilter, after: TopologyFilter): FilterChange[] {
  const out: FilterChange[] = [];
  if (before.vpcId !== after.vpcId) out.push({ field: 'vpcId', value: after.vpcId });
  TIERS.forEach((t) => {
    if (before.tiers[t] !== after.tiers[t]) out.push({ field: 'tiers', key: t, value: after.tiers[t] });
  });
  NODE_KINDS.forEach((k) => {
    if (before.kinds[k] !== after.kinds[k]) out.push({ field: 'kinds', key: k, value: after.kinds[k] });
  });
  const azA = before.azs ? [...before.azs].sort().join(',') : null;
  const azB = after.azs ? [...after.azs].sort().join(',') : null;
  if (azA !== azB) out.push({ field: 'azs', value: after.azs });
  if (before.includeEmptySubnets !== after.includeEmptySubnets) {
    out.push({ field: 'includeEmptySubnets', value: after.includeEmptySubnets });
  }
  if (before.query !== after.query) out.push({ field: 'query', value: after.query });
  return out;
}

// ---- Wire format shared by route and panel ----
// 라우트와 패널이 공유하는 SSE 페이로드.
export type ChatSseEvent =
  | { event: 'text'; data: { delta: string } }
  | { event: 'filter'; data: { patch: TopologyFilterPatch; filter: TopologyFilter; rejected: string[] } }
  | { event: 'done'; data: { usage?: ConverseResult['usage']; stopReason?: string } }
  | { event: 'error'; data: { message: string } };

export interface ChatRequestBody {
  messages: ChatTurn[];
  filter: TopologyFilter;
  summary: GraphSummary;
  lang: string;
}
