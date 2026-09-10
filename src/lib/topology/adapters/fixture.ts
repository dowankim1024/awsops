// Fixture adapter: JSON (built-in file or user upload) -> TopologyGraph.
// Nothing is trusted: the payload goes through validateGraph and is rejected with
// field-level messages, so a hand-edited fixture says what is wrong instead of
// blowing up inside the renderer.
// 픽스처 어댑터. 내장 파일이든 업로드든 validateGraph를 통과해야 하고, 실패하면 어느 필드가
// 틀렸는지 알려준다. 렌더러 안에서 터지지 않게 하는 것이 목적이다.
import { anonymizeGraph, type AnonymizeOptions } from '../anonymize';
import { type TopologyGraph } from '../types';
import { validateGraph } from '../validate';

export interface FixtureParseResult {
  graph: TopologyGraph | null;
  issues: string[]; // empty only when graph is non-null / graph가 있을 때만 빈 배열
}

export interface FixtureEntry {
  id: string;
  name: string;
  description: string;
  // Dynamic import so a multi-megabyte fixture stays out of the initial bundle.
  // 초기 번들에 큰 픽스처가 섞이지 않도록 동적 import를 쓴다.
  load: () => Promise<TopologyGraph>;
}

const MAX_ISSUES = 20;

// Accepts a JSON string or an already-parsed value. meta.source is forced to
// 'fixture': an exported live graph re-imported here is a fixture now.
// JSON 문자열이나 파싱된 값을 받는다. meta.source는 'fixture'로 고정한다.
export function parseFixture(input: unknown): FixtureParseResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { graph: null, issues: ['file is empty'] };
    try {
      value = JSON.parse(text);
    } catch (e) {
      return { graph: null, issues: [`not valid JSON: ${(e as Error).message}`] };
    }
  }
  const issues = validateGraph(value);
  if (issues.length) {
    const shown = issues.slice(0, MAX_ISSUES);
    if (issues.length > shown.length) shown.push(`… and ${issues.length - shown.length} more`);
    return { graph: null, issues: shown };
  }
  const graph = value as TopologyGraph;
  return { graph: { ...graph, meta: { ...graph.meta, source: 'fixture' } }, issues: [] };
}

// Throws on invalid input; for the built-in files, which are asserted by tests.
// 내장 픽스처용. 테스트가 유효성을 보장하므로 실패하면 예외를 던진다.
export function toTopologyGraph(input: unknown): TopologyGraph {
  const { graph, issues } = parseFixture(input);
  if (!graph) throw new Error(`invalid fixture: ${issues.join('; ')}`);
  return graph;
}

export const BUILT_IN_FIXTURES: FixtureEntry[] = [
  {
    id: 'plick-prod',
    name: 'PLick prod (anonymized)',
    description: '2 VPC · 24 subnets · ~360 EC2. Account id, names and IPs are stand-ins.',
    load: async () => toTopologyGraph((await import('../fixtures/plick-prod.json')).default),
  },
  {
    id: 'stress-1000',
    name: 'Stress · 1,000 EC2',
    description: '2 VPC · 32 subnets · 1,000+ EC2. The plan’s 60fps target.',
    load: async () => toTopologyGraph((await import('../fixtures/stress-1000.json')).default),
  },
];

export const findFixture = (id: string): FixtureEntry | undefined =>
  BUILT_IN_FIXTURES.find((f) => f.id === id);

export interface ExportOptions extends AnonymizeOptions {
  anonymize?: boolean;
  pretty?: boolean;
}

// Serialises a graph for the download button. Anonymizing is opt-in and marks
// meta.anonymized so the panel can label what was saved.
// 내려받기용 직렬화. 익명화는 선택이며 meta.anonymized로 표시된다.
export function toFixtureJson(g: TopologyGraph, opts: ExportOptions = {}): string {
  const out = opts.anonymize ? anonymizeGraph(g, opts) : g;
  return JSON.stringify(out, null, opts.pretty === false ? undefined : 2);
}
