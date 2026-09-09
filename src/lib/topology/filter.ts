// Single filter model shared by the checkbox panel, the URL, and the chat.
// Every path produces a TopologyFilterPatch and goes through mergeFilter;
// applyFilter is pure and never mutates its input.
// 체크박스·URL·채팅이 공유하는 필터. 세 경로 모두 패치를 만들어 mergeFilter로 합치고,
// applyFilter는 순수 함수다.
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

export interface TopologyFilter {
  vpcId: string | null; // null = first VPC in the graph
  tiers: Record<Tier, boolean>;
  kinds: Record<NodeKind, boolean>;
  azs: string[] | null; // null = every AZ
  includeEmptySubnets: boolean;
  query: string; // case-insensitive substring of node name or id; '' = no filter
}

// Patches may set a subset of tiers/kinds ({ tiers: { public: false } }).
// 패치는 tiers/kinds 일부만 지정할 수 있다.
export type TopologyFilterPatch = Partial<Omit<TopologyFilter, 'tiers' | 'kinds'>> & {
  tiers?: Partial<Record<Tier, boolean>>;
  kinds?: Partial<Record<NodeKind, boolean>>;
};

const allTiers = (): Record<Tier, boolean> =>
  Object.fromEntries(TIERS.map((t) => [t, true])) as Record<Tier, boolean>;

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
  azs: null,
  includeEmptySubnets: false,
  query: '',
});

export const createDefaultFilter = (): TopologyFilter => ({
  vpcId: null,
  tiers: allTiers(),
  kinds: defaultKinds(),
  azs: null,
  includeEmptySubnets: false,
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
  let azs = f.azs;
  if (patch.azs !== undefined) {
    azs = patch.azs === null ? null : Array.from(new Set(patch.azs.filter((a) => typeof a === 'string' && a)));
  }
  return {
    vpcId: patch.vpcId !== undefined ? patch.vpcId : f.vpcId,
    tiers,
    kinds,
    azs,
    includeEmptySubnets:
      typeof patch.includeEmptySubnets === 'boolean' ? patch.includeEmptySubnets : f.includeEmptySubnets,
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

  const nodes = g.nodes.filter((n) => {
    if (!f.kinds[n.kind]) return false;
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
  });

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
  const edges = g.edges.filter((e) => elementIds.has(e.from) && elementIds.has(e.to));

  return { meta: g.meta, vpcs, subnets, nodes, edges };
}

// ---- URL round trip ----
// Only non-default entries are written so links stay short:
//   ?vpc=vpc-…&tiers=private&hide=lambda,s3&az=ap-northeast-2a&empty=1&q=web
// 기본값과 다른 항목만 기록해 링크를 짧게 유지한다.
const P = { vpc: 'vpc', tiers: 'tiers', hide: 'hide', show: 'show', az: 'az', empty: 'empty', q: 'q' };

export function filterToSearchParams(f: TopologyFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.vpcId) p.set(P.vpc, f.vpcId);
  const onTiers = TIERS.filter((t) => f.tiers[t]);
  if (onTiers.length !== TIERS.length) p.set(P.tiers, onTiers.join(','));
  const hide = NODE_KINDS.filter((k) => DEFAULT_FILTER.kinds[k] && !f.kinds[k]);
  const show = NODE_KINDS.filter((k) => !DEFAULT_FILTER.kinds[k] && f.kinds[k]);
  if (hide.length) p.set(P.hide, hide.join(','));
  if (show.length) p.set(P.show, show.join(','));
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
  const az = list(p.get(P.az));
  if (az.length) patch.azs = az;
  if (p.get(P.empty) === '1') patch.includeEmptySubnets = true;
  const q = p.get(P.q);
  if (q) patch.query = q;
  return mergeFilter(createDefaultFilter(), patch);
}
