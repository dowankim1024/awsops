// Structural + referential checks for a TopologyGraph. Returns human-readable
// issues (empty array = valid). Used by the fixture adapter on upload and by
// tests on adapter output. No throwing: callers decide how strict to be.
// TopologyGraph 구조·참조 검증. 빈 배열이면 유효. 픽스처 업로드와 어댑터 테스트에서 사용.
import {
  isEdgeKind,
  isNodeKind,
  isTier,
  type TopologyGraph,
} from './types';

const SOURCES = ['live', 'fixture', 'generator'];
const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateGraph(g: unknown): string[] {
  const issues: string[] = [];
  if (!isObj(g)) return ['graph is not an object'];

  const meta = g.meta;
  if (!isObj(meta)) issues.push('meta must be an object');
  else {
    if (!SOURCES.includes(String(meta.source))) issues.push(`meta.source must be one of ${SOURCES.join('/')}`);
    if (!isStr(meta.generatedAt)) issues.push('meta.generatedAt must be an ISO string');
  }
  for (const k of ['vpcs', 'subnets', 'nodes', 'edges'] as const) {
    if (!Array.isArray(g[k])) issues.push(`${k} must be an array`);
  }
  if (issues.length) return issues;

  const graph = g as unknown as TopologyGraph;
  const vpcIds = new Set<string>();
  const subnetIds = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  graph.vpcs.forEach((v, i) => {
    if (!isObj(v) || !isStr(v.id) || !v.id) return void issues.push(`vpcs[${i}] needs an id`);
    if (vpcIds.has(v.id)) issues.push(`vpcs[${i}] duplicate id ${v.id}`);
    vpcIds.add(v.id);
    if (!isStr(v.name)) issues.push(`vpcs[${i}] (${v.id}) name must be a string`);
    if (!isStr(v.cidr)) issues.push(`vpcs[${i}] (${v.id}) cidr must be a string`);
  });

  graph.subnets.forEach((s, i) => {
    if (!isObj(s) || !isStr(s.id) || !s.id) return void issues.push(`subnets[${i}] needs an id`);
    if (subnetIds.has(s.id)) issues.push(`subnets[${i}] duplicate id ${s.id}`);
    subnetIds.add(s.id);
    if (!vpcIds.has(String(s.vpcId))) issues.push(`subnets[${i}] (${s.id}) vpcId ${s.vpcId} not in vpcs`);
    if (!isTier(s.tier)) issues.push(`subnets[${i}] (${s.id}) tier must be public|private`);
    if (!isStr(s.az)) issues.push(`subnets[${i}] (${s.id}) az must be a string`);
    if (!isStr(s.cidr)) issues.push(`subnets[${i}] (${s.id}) cidr must be a string`);
    if (!isStr(s.name)) issues.push(`subnets[${i}] (${s.id}) name must be a string`);
  });

  graph.nodes.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id) || !n.id) return void issues.push(`nodes[${i}] needs an id`);
    if (nodeIds.has(n.id)) issues.push(`nodes[${i}] duplicate id ${n.id}`);
    nodeIds.add(n.id);
    if (!isNodeKind(n.kind)) issues.push(`nodes[${i}] (${n.id}) unknown kind ${String(n.kind)}`);
    if (!isStr(n.name) || !n.name) issues.push(`nodes[${i}] (${n.id}) name must be a non-empty string`);
    if (n.vpcId !== undefined && !vpcIds.has(String(n.vpcId)))
      issues.push(`nodes[${i}] (${n.id}) vpcId ${n.vpcId} not in vpcs`);
    if (n.subnetId !== undefined && !subnetIds.has(String(n.subnetId)))
      issues.push(`nodes[${i}] (${n.id}) subnetId ${n.subnetId} not in subnets`);
    if (!isObj(n.meta)) issues.push(`nodes[${i}] (${n.id}) meta must be an object`);
  });

  const elementIds = new Set<string>();
  [vpcIds, subnetIds, nodeIds].forEach((set) => set.forEach((id) => elementIds.add(id)));
  graph.edges.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.id) || !e.id) return void issues.push(`edges[${i}] needs an id`);
    if (edgeIds.has(e.id)) issues.push(`edges[${i}] duplicate id ${e.id}`);
    edgeIds.add(e.id);
    if (!isEdgeKind(e.kind)) issues.push(`edges[${i}] (${e.id}) unknown kind ${String(e.kind)}`);
    if (!elementIds.has(String(e.from))) issues.push(`edges[${i}] (${e.id}) from ${e.from} not found`);
    if (!elementIds.has(String(e.to))) issues.push(`edges[${i}] (${e.id}) to ${e.to} not found`);
  });

  return issues;
}

export const isValidGraph = (g: unknown): g is TopologyGraph => validateGraph(g).length === 0;
