import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_TURNS,
  SET_FILTER_TOOL,
  buildSystemPrompt,
  createConverseReducer,
  diffFilter,
  sanitizeFilter,
  sanitizePatch,
  sanitizeSummary,
  summarizeGraph,
  toConverseMessages,
  type ConverseStreamEvent,
} from '../chat';
import { PRESETS, generateGraph } from '../adapters/generator';
import { applyFilter, createDefaultFilter, mergeFilter } from '../filter';
import { GLOBAL_KINDS, NODE_KINDS, TIERS } from '../types';

const now = new Date('2026-09-10T00:00:00Z');
const graph = generateGraph({ ...PRESETS.small, vpcs: 2, seed: 7 }, { now });
const summary = summarizeGraph(graph, createDefaultFilter());

describe('summarizeGraph', () => {
  it('lists every VPC but scopes AZs, tiers and kinds to the current VPC plus global kinds', () => {
    expect(summary.vpcs.map((v) => v.id)).toEqual(graph.vpcs.map((v) => v.id));
    expect(summary.vpcId).toBe(graph.vpcs[0].id);
    const first = graph.vpcs[0].id;
    const azs = new Set(graph.subnets.filter((s) => s.vpcId === first).map((s) => s.az));
    azs.forEach((az) => expect(summary.azs).toContain(az));
    expect(summary.tiers.public + summary.tiers.private).toBe(
      graph.subnets.filter((s) => s.vpcId === first).length
    );
    const expected = graph.nodes.filter((n) => n.vpcId === undefined || n.vpcId === first).length;
    const total = Object.values(summary.kinds).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(expected);
    // Nodes of the other VPC never leak in.
    const other = graph.vpcs[1].id;
    const otherOnly = graph.nodes.filter((n) => n.vpcId === other).length;
    expect(total + otherOnly).toBe(graph.nodes.length);
  });

  it('follows the filter to another VPC', () => {
    const s = summarizeGraph(graph, { vpcId: graph.vpcs[1].id });
    expect(s.vpcId).toBe(graph.vpcs[1].id);
    expect(s.vpcs.find((v) => v.id === s.vpcId)?.nodes).toBe(
      graph.nodes.filter((n) => n.vpcId === graph.vpcs[1].id).length
    );
  });

  it('round-trips through sanitizeSummary and drops junk', () => {
    const clean = sanitizeSummary(JSON.parse(JSON.stringify(summary)));
    expect(clean).toEqual(summary);
    const junk = sanitizeSummary({
      source: 'evil',
      vpcs: [{ id: 'vpc-1', name: 1 }, null, 'x'],
      azs: ['ap-northeast-2a', 3],
      kinds: { ec2: 5, bogus: 9, alb: 'x' },
      tiers: { public: 'no' },
      vpcId: 'vpc-missing',
    });
    expect(junk.source).toBe('fixture');
    expect(junk.vpcs).toEqual([{ id: 'vpc-1', name: '', cidr: '', subnets: 0, nodes: 0 }]);
    expect(junk.azs).toEqual(['ap-northeast-2a']);
    expect(junk.kinds).toEqual({ ec2: 5, alb: 0 });
    expect(junk.tiers).toEqual({ public: 0, private: 0 });
    expect(junk.vpcId).toBe('vpc-1');
  });
});

describe('buildSystemPrompt', () => {
  it('carries the schema, the current filter and the summary, but no node list', () => {
    const f = mergeFilter(createDefaultFilter(), { kinds: { lambda: false }, azs: [summary.azs[0]] });
    const p = buildSystemPrompt(summary, f, 'ko');
    expect(p).toContain('set_filter');
    expect(p).toContain('Reply in Korean');
    expect(p).toContain(`kinds hidden: ${[...GLOBAL_KINDS, 'lambda'].sort().join(', ')}`.slice(0, 13));
    expect(p).toContain('lambda');
    expect(p).toContain(summary.azs[0]);
    graph.vpcs.forEach((v) => expect(p).toContain(v.id));
    // Individual instance ids are never in the prompt.
    const anyInstance = graph.nodes.find((n) => n.kind === 'ec2')!;
    expect(p).not.toContain(anyInstance.id);
    // Small: well under the size of the graph itself.
    expect(p.length).toBeLessThan(JSON.stringify(graph).length / 4);
  });

  it('falls back to English for an unknown language', () => {
    expect(buildSystemPrompt(summary, createDefaultFilter(), 'xx')).toContain('Reply in English');
  });

  it('tool schema enumerates every kind and tier', () => {
    const props = SET_FILTER_TOOL.inputSchema.json.properties;
    expect(Object.keys(props.kinds.properties)).toEqual([...NODE_KINDS]);
    expect(Object.keys(props.tiers.properties)).toEqual([...TIERS]);
  });
});

describe('toConverseMessages', () => {
  it('enforces user-first alternation, fills empty assistant turns, trims history', () => {
    const raw = [
      { role: 'assistant', text: 'hello' }, // dropped: must start with user
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' }, // merged into previous user turn
      { role: 'assistant', text: '' }, // empty → placeholder
      { role: 'user', text: '   ' }, // blank user turn dropped
      { role: 'user', text: 'c' },
      { role: 'system', text: 'ignored' },
      { role: 'assistant', text: 'd' }, // trailing assistant dropped
    ];
    expect(toConverseMessages(raw)).toEqual([
      { role: 'user', text: 'a\nb' },
      { role: 'assistant', text: '(filter updated)' },
      { role: 'user', text: 'c' },
    ]);
  });

  it(`keeps only the last ${MAX_HISTORY_TURNS} turns`, () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `t${i}`,
    }));
    const out = toConverseMessages(raw);
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS);
    expect(out.length).toBeGreaterThanOrEqual(MAX_HISTORY_TURNS - 1);
    expect(out[0].role).toBe('user');
    expect(out[out.length - 1]).toEqual({ role: 'user', text: 't28' });
  });

  it('returns [] for non-arrays', () => {
    expect(toConverseMessages(null)).toEqual([]);
    expect(toConverseMessages('x')).toEqual([]);
  });
});

describe('sanitizePatch', () => {
  it('keeps valid fields and reports unknown kinds, tiers and AZs', () => {
    const { patch, rejected } = sanitizePatch(
      {
        tiers: { public: false, edge: true },
        kinds: { lambda: false, sqs: false, ec2: 'yes' },
        azs: ['ap-northeast-2a', 'us-east-1a'],
        includeEmptySubnets: true,
        query: '  web  ',
      },
      summary
    );
    expect(patch).toEqual({
      tiers: { public: false },
      kinds: { lambda: false },
      azs: ['ap-northeast-2a'],
      includeEmptySubnets: true,
      query: 'web',
    });
    expect(rejected).toEqual(['tiers.edge', 'kinds.sqs', 'kinds.ec2', 'azs: us-east-1a']);
  });

  it('resolves short AZ names and VPC names, rejects ambiguous or unknown ones', () => {
    const { patch, rejected } = sanitizePatch(
      { azs: ['2a', 'b', 'zz'], vpcId: graph.vpcs[1].name },
      summary
    );
    expect(patch.azs).toEqual(['ap-northeast-2a', 'ap-northeast-2b']);
    expect(patch.vpcId).toBe(graph.vpcs[1].id);
    expect(rejected).toEqual(['azs: zz']);

    const bad = sanitizePatch({ vpcId: 'vpc-nope' }, summary);
    expect(bad.patch.vpcId).toBeUndefined();
    expect(bad.rejected).toEqual(['vpcId: vpc-nope']);
  });

  it('never blanks the scene with an AZ list that resolved to nothing', () => {
    const { patch } = sanitizePatch({ azs: ['nowhere'] }, summary);
    expect(patch.azs).toBeUndefined();
    expect(sanitizePatch({ azs: [] }, summary).patch.azs).toBeNull();
    expect(sanitizePatch({ azs: null }, summary).patch.azs).toBeNull();
  });

  it('rejects non-object input and wrong field types', () => {
    expect(sanitizePatch('x', summary).rejected).toEqual(['patch is not an object']);
    const r = sanitizePatch({ tiers: 'all', kinds: 1, azs: 'a', includeEmptySubnets: 'y', query: 2 }, summary);
    expect(r.patch).toEqual({});
    expect(r.rejected).toHaveLength(5);
  });

  it('a sanitised chat patch merges and filters end to end', () => {
    const { patch } = sanitizePatch({ tiers: { public: false }, kinds: { lambda: false }, azs: ['2a'] }, summary);
    const f = mergeFilter(createDefaultFilter(), patch);
    const out = applyFilter(graph, f);
    expect(out.subnets.every((s) => s.tier === 'private' && s.az === 'ap-northeast-2a')).toBe(true);
    expect(out.nodes.some((n) => n.kind === 'lambda')).toBe(false);
  });
});

describe('sanitizeFilter', () => {
  it('rebuilds a filter from untrusted input on top of the defaults', () => {
    const f = sanitizeFilter({ vpcId: 'vpc-x', tiers: { public: false, bogus: 1 }, kinds: { s3: true }, azs: ['a', 3], query: 'q' });
    expect(f.vpcId).toBe('vpc-x');
    expect(f.tiers).toEqual({ public: false, private: true });
    expect(f.kinds.s3).toBe(true);
    expect(f.kinds.ec2).toBe(true);
    expect(f.azs).toEqual(['a']);
    expect(f.query).toBe('q');
    expect(sanitizeFilter(null)).toEqual(createDefaultFilter());
  });
});

describe('createConverseReducer', () => {
  const events: ConverseStreamEvent[] = [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '퍼블릭 티어를 ' } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '숨겼습니다.' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'set_filter' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"tiers":{"pub' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'lic":false}}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 900, outputTokens: 40 } } },
  ];

  it('streams text deltas and assembles a tool call from split JSON', () => {
    const r = createConverseReducer();
    const deltas = events.map((e) => r.push(e)).filter(Boolean);
    expect(deltas).toEqual(['퍼블릭 티어를 ', '숨겼습니다.']);
    expect(r.result()).toEqual({
      text: '퍼블릭 티어를 숨겼습니다.',
      toolCalls: [{ name: 'set_filter', input: { tiers: { public: false } } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it('keeps a malformed tool input as raw text with a parse error', () => {
    const r = createConverseReducer();
    r.push({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'set_filter' } } } });
    r.push({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"kinds":' } } } });
    r.push({ contentBlockStop: { contentBlockIndex: 0 } });
    const [call] = r.result().toolCalls;
    expect(call.input).toBe('{"kinds":');
    expect(call.parseError).toBeTruthy();
  });

  it('flushes a tool block that never received a stop event', () => {
    const r = createConverseReducer();
    r.push({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'set_filter' } } } });
    r.push({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"web"}' } } } });
    expect(r.result().toolCalls).toEqual([{ name: 'set_filter', input: { query: 'web' } }]);
    // result() is idempotent.
    expect(r.result().toolCalls).toHaveLength(1);
  });
});

describe('diffFilter', () => {
  it('lists exactly the fields that changed', () => {
    const a = createDefaultFilter();
    const b = mergeFilter(a, {
      vpcId: 'vpc-2',
      tiers: { public: false },
      kinds: { lambda: false, s3: true },
      azs: ['ap-northeast-2a'],
      includeEmptySubnets: true,
      query: 'web',
    });
    expect(diffFilter(a, b)).toEqual([
      { field: 'vpcId', value: 'vpc-2' },
      { field: 'tiers', key: 'public', value: false },
      { field: 'kinds', key: 'lambda', value: false },
      { field: 'kinds', key: 's3', value: true },
      { field: 'azs', value: ['ap-northeast-2a'] },
      { field: 'includeEmptySubnets', value: true },
      { field: 'query', value: 'web' },
    ]);
    expect(diffFilter(a, a)).toEqual([]);
    // AZ order does not count as a change.
    const c = mergeFilter(a, { azs: ['x', 'y'] });
    const d = mergeFilter(a, { azs: ['y', 'x'] });
    expect(diffFilter(c, d)).toEqual([]);
  });
});
