// Single filter model shared by the checkbox panel, the URL, and the chat.
// Every path produces a TopologyFilterPatch and goes through mergeFilter;
// applyFilter is pure and never mutates its input.
// 체크박스·URL·채팅이 공유하는 필터. 세 경로 모두 패치를 만들어 mergeFilter로 합치고,
// applyFilter는 순수 함수다.
import {
  EDGE_KINDS,
  GLOBAL_KINDS,
  NODE_KINDS,
  TIERS,
  isEdgeKind,
  isGlobalKind,
  isNodeKind,
  isTier,
  type EdgeKind,
  type NodeKind,
  type Tier,
  type TopologyGraph,
  type TopologyNode,
} from './types';

export interface TopologyFilter {
  vpcId: string | null; // null = first VPC in the graph
  tiers: Record<Tier, boolean>;
  kinds: Record<NodeKind, boolean>;
  // Edge kinds, explicit and inferred alike. All on by default: the point of the
  // inferred edges is that the flow is visible. / 엣지 종류. 기본 전부 켬.
  edgeKinds: Record<EdgeKind, boolean>;
  azs: string[] | null; // null = every AZ
  includeEmptySubnets: boolean;
  // Keep an account-global node whose kind is hidden when a visible edge reaches
  // it, so S3 / DynamoDB appear exactly when something points at them.
  // 종류가 꺼져 있어도 보이는 엣지가 닿는 전역 노드는 남긴다.
  showConnectedGlobals: boolean;
  query: string; // case-insensitive substring of node name or id; '' = no filter
}

// Patches may set a subset of tiers/kinds/edgeKinds ({ tiers: { public: false } }).
// 패치는 tiers/kinds/edgeKinds 일부만 지정할 수 있다.
export type TopologyFilterPatch = Partial<Omit<TopologyFilter, 'tiers' | 'kinds' | 'edgeKinds'>> & {
  tiers?: Partial<Record<Tier, boolean>>;
  kinds?: Partial<Record<NodeKind, boolean>>;
  edgeKinds?: Partial<Record<EdgeKind, boolean>>;
};

const allTiers = (): Record<Tier, boolean> =>
  Object.fromEntries(TIERS.map((t) => [t, true])) as Record<Tier, boolean>;

const allEdgeKinds = (): Record<EdgeKind, boolean> =>
  Object.fromEntries(EDGE_KINDS.map((k) => [k, true])) as Record<EdgeKind, boolean>;

// VPC-scoped kinds start visible; account-global kinds (S3, DynamoDB, CloudFront,
// Route 53) start hidden because a single account can hold hundreds of them.
// VPC 귀속 종류는 기본 표시, 계정 전역 종류는 수백 개가 될 수 있어 기본 숨김.
const defaultKinds = (): Record<NodeKind, boolean> =>
  Object.fromEntries(NODE_KINDS.map((k) => [k, !GLOBAL_KINDS.includes(k)])) as Record<
    NodeKind,
    boolean
  >;

export const DEFAULT_FILTER: Readonly<TopologyFilter> = Object.freeze({
  vpcId: null,
  tiers: allTiers(),
  kinds: defaultKinds(),
  edgeKinds: allEdgeKinds(),
  azs: null,
  includeEmptySubnets: false,
  showConnectedGlobals: true,
  query: '',
});

export const createDefaultFilter = (): TopologyFilter => ({
  vpcId: null,
  tiers: allTiers(),
  kinds: defaultKinds(),
  edgeKinds: allEdgeKinds(),
  azs: null,
  includeEmptySubnets: false,
  showConnectedGlobals: true,
  query: '',
});

// Unknown kinds / tiers in a patch (e.g. from the chat model) are ignored; undefined
// values leave the current setting untouched. Returns a new object.
// 패치의 알 수 없는 kind/tier는 무시, undefined는 유지. 새 객체를 반환한다.
export function mergeFilter(f: TopologyFilter, patch: TopologyFilterPatch): TopologyFilter {
  const tiers = { ...f.tiers };
  if (patch.tiers) {
    for (const [k, v] of Object.entries(patch.tiers)) {
      if (isTier(k) && typeof v === 'boolean') tiers[k] = v;
    }
  }
  const kinds = { ...f.kinds };
  if (patch.kinds) {
    for (const [k, v] of Object.entries(patch.kinds)) {
      if (isNodeKind(k) && typeof v === 'boolean') kinds[k] = v;
    }
  }
  const edgeKinds = { ...f.edgeKinds };
  if (patch.edgeKinds) {
    for (const [k, v] of Object.entries(patch.edgeKinds)) {
      if (isEdgeKind(k) && typeof v === 'boolean') edgeKinds[k] = v;
    }
  }
  let azs = f.azs;
  if (patch.azs !== undefined) {
    azs = patch.azs === null ? null : Array.from(new Set(patch.azs.filter((a) => typeof a === 'string' && a)));
  }
  return {
    vpcId: patch.vpcId !== undefined ? patch.vpcId : f.vpcId,
    tiers,
    kinds,
    edgeKinds,
    azs,
    includeEmptySubnets:
      typeof patch.includeEmptySubnets === 'boolean' ? patch.includeEmptySubnets : f.includeEmptySubnets,
    showConnectedGlobals:
      typeof patch.showConnectedGlobals === 'boolean' ? patch.showConnectedGlobals : f.showConnectedGlobals,
    query: typeof patch.query === 'string' ? patch.query : f.query,
  };
}

// The VPC the filter resolves to: the requested one when it exists, else the first.
// 필터가 가리키는 VPC. 없으면 첫 VPC.
export function resolveVpcId(g: TopologyGraph, f: Pick<TopologyFilter, 'vpcId'>): string | null {
  if (f.vpcId && g.vpcs.some((v) => v.id === f.vpcId)) return f.vpcId;
  return g.vpcs[0]?.id ?? null;
}

export function applyFilter(g: TopologyGraph, f: TopologyFilter): TopologyGraph {
  const vpcId = resolveVpcId(g, f);
  const azSet = f.azs ? new Set(f.azs) : null;
  const q = f.query.trim().toLowerCase();

  const vpcs = g.vpcs.filter((v) => v.id === vpcId);

  const keptSubnets = g.subnets.filter(
    (s) => s.vpcId === vpcId && f.tiers[s.tier] && (!azSet || azSet.has(s.az))
  );
  const keptSubnetIds = new Set(keptSubnets.map((s) => s.id));

  // Everything except the kind switch. Connected account-global nodes are let
  // back in below on this same basis, so the two paths never disagree.
  // 종류 스위치를 뺀 나머지 조건. 아래에서 되살리는 전역 노드도 같은 기준을 쓴다.
  const placed = (n: TopologyNode): boolean => {
    if (n.vpcId !== undefined && n.vpcId !== vpcId) return false;
    if (n.subnetId !== undefined) {
      // A node whose subnet was filtered out goes with it (tier / AZ / other VPC).
      if (!keptSubnetIds.has(n.subnetId)) return false;
    } else {
      const az = n.az;
      if (azSet && az && !azSet.has(az)) return false;
    }
    if (q && !n.name.toLowerCase().includes(q) && !n.id.toLowerCase().includes(q)) return false;
    return true;
  };

  const nodes = g.nodes.filter((n) => f.kinds[n.kind] && placed(n));

  let subnets = keptSubnets;
  if (!f.includeEmptySubnets) {
    const occupied = new Set<string>();
    nodes.forEach((n) => {
      if (n.subnetId) occupied.add(n.subnetId);
    });
    subnets = keptSubnets.filter((s) => occupied.has(s.id));
  }

  const elementIds = new Set<string>([
    ...vpcs.map((v) => v.id),
    ...subnets.map((s) => s.id),
    ...nodes.map((n) => n.id),
  ]);

  // One pass, no transitive closure: a hidden global kind comes back only when a
  // visible edge already reaches something on screen. `s3` stays off by default
  // and still shows the buckets an instance is allowed to read.
  // 한 번만 훑는다. 보이는 엣지가 이미 화면에 있는 요소에 닿을 때만 되살린다.
  if (f.showConnectedGlobals) {
    const wanted = new Set<string>();
    for (const e of g.edges) {
      if (!f.edgeKinds[e.kind]) continue;
      if (elementIds.has(e.from) && !elementIds.has(e.to)) wanted.add(e.to);
      else if (elementIds.has(e.to) && !elementIds.has(e.from)) wanted.add(e.from);
    }
    if (wanted.size) {
      for (const n of g.nodes) {
        if (f.kinds[n.kind] || !isGlobalKind(n.kind)) continue;
        if (!wanted.has(n.id) || !placed(n)) continue;
        nodes.push(n);
        elementIds.add(n.id);
      }
    }
  }

  const edges = g.edges.filter(
    (e) => f.edgeKinds[e.kind] && elementIds.has(e.from) && elementIds.has(e.to)
  );

  return { meta: g.meta, vpcs, subnets, nodes, edges };
}

// ---- URL round trip ----
// Only non-default entries are written so links stay short:
//   ?vpc=vpc-…&tiers=private&hide=lambda,s3&hideEdges=allows&globals=0&az=…&empty=1&q=web
// 기본값과 다른 항목만 기록해 링크를 짧게 유지한다.
const P = {
  vpc: 'vpc',
  tiers: 'tiers',
  hide: 'hide',
  show: 'show',
  hideEdges: 'hideEdges',
  globals: 'globals',
  az: 'az',
  empty: 'empty',
  q: 'q',
};

export function filterToSearchParams(f: TopologyFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.vpcId) p.set(P.vpc, f.vpcId);
  const onTiers = TIERS.filter((t) => f.tiers[t]);
  if (onTiers.length !== TIERS.length) p.set(P.tiers, onTiers.join(','));
  const hide = NODE_KINDS.filter((k) => DEFAULT_FILTER.kinds[k] && !f.kinds[k]);
  const show = NODE_KINDS.filter((k) => !DEFAULT_FILTER.kinds[k] && f.kinds[k]);
  if (hide.length) p.set(P.hide, hide.join(','));
  if (show.length) p.set(P.show, show.join(','));
  const hideEdges = EDGE_KINDS.filter((k) => !f.edgeKinds[k]);
  if (hideEdges.length) p.set(P.hideEdges, hideEdges.join(','));
  if (!f.showConnectedGlobals) p.set(P.globals, '0');
  if (f.azs && f.azs.length) p.set(P.az, f.azs.join(','));
  if (f.includeEmptySubnets) p.set(P.empty, '1');
  if (f.query) p.set(P.q, f.query);
  return p;
}

const list = (v: string | null): string[] =>
  v === null ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);

export function filterFromSearchParams(p: URLSearchParams): TopologyFilter {
  const patch: TopologyFilterPatch = {};
  const vpc = p.get(P.vpc);
  if (vpc) patch.vpcId = vpc;
  if (p.has(P.tiers)) {
    const on = new Set(list(p.get(P.tiers)));
    patch.tiers = Object.fromEntries(TIERS.map((t) => [t, on.has(t)])) as Record<Tier, boolean>;
  }
  const kinds: Partial<Record<NodeKind, boolean>> = {};
  list(p.get(P.hide)).forEach((k) => {
    if (isNodeKind(k)) kinds[k] = false;
  });
  list(p.get(P.show)).forEach((k) => {
    if (isNodeKind(k)) kinds[k] = true;
  });
  if (Object.keys(kinds).length) patch.kinds = kinds;
  const edgeKinds: Partial<Record<EdgeKind, boolean>> = {};
  list(p.get(P.hideEdges)).forEach((k) => {
    if (isEdgeKind(k)) edgeKinds[k] = false;
  });
  if (Object.keys(edgeKinds).length) patch.edgeKinds = edgeKinds;
  if (p.get(P.globals) === '0') patch.showConnectedGlobals = false;
  const az = list(p.get(P.az));
  if (az.length) patch.azs = az;
  if (p.get(P.empty) === '1') patch.includeEmptySubnets = true;
  const q = p.get(P.q);
  if (q) patch.query = q;
  return mergeFilter(createDefaultFilter(), patch);
}
