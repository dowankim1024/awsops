// Topology data contract shared by every data source (Live / Fixture / Generator)
// and every consumer (FossFLOW generator, 3D layout, filter, chat prompt).
// Consumers never see Steampipe rows; adapters produce this shape and nothing else.
// 모든 데이터 소스와 소비자가 공유하는 토폴로지 계약. 소비자는 Steampipe 행을 보지 않는다.
// See docs/decisions/010-topology-graph-contract.md.

export const NODE_KINDS = [
  'ec2',
  'alb',
  'nlb',
  'nat',
  'igw',
  'tgw',
  'endpoint',
  'lambda',
  'rds',
  'elasticache',
  'msk',
  'opensearch',
  'eks',
  's3',
  'dynamodb',
  'cloudfront',
  'route53',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

// Account-global kinds have no vpcId and are drawn in the tray outside the VPC.
// 계정 전역 종류는 vpcId가 없고 VPC 바깥 트레이에 그려진다.
export const GLOBAL_KINDS: readonly NodeKind[] = ['s3', 'dynamodb', 'cloudfront', 'route53'];
export const isNodeKind = (v: unknown): v is NodeKind =>
  typeof v === 'string' && (NODE_KINDS as readonly string[]).includes(v);
export const isGlobalKind = (k: NodeKind): boolean => GLOBAL_KINDS.includes(k);

export const TIERS = ['public', 'private'] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIERS as readonly string[]).includes(v);

// target: load balancer -> instance (target group membership)
// route:  subnet -> gateway node (nat / igw / tgw) from its route table
// attach: gateway node (igw / tgw attachment) -> VPC
// egress: nat -> igw (the NAT's public subnet routes to the IGW)
export const EDGE_KINDS = ['target', 'route', 'attach', 'egress'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const isEdgeKind = (v: unknown): v is EdgeKind =>
  typeof v === 'string' && (EDGE_KINDS as readonly string[]).includes(v);

export type TopologySource = 'live' | 'fixture' | 'generator';

export interface TopologyMeta {
  source: TopologySource;
  accountId?: string;
  generatedAt: string; // ISO timestamp
  seed?: number; // generator only
  // Set by anonymizeGraph: names, ids, account id and IPs are stand-ins.
  // 익명화된 그래프임을 표시한다 (이름·ID·계정 ID·IP가 치환된 값).
  anonymized?: boolean;
}

export interface TopologyVpc {
  id: string; // vpc-…
  name: string; // Name tag, falls back to id
  cidr: string;
}

export interface TopologySubnet {
  id: string; // subnet-…
  vpcId: string;
  az: string; // ap-northeast-2a; '' when unknown
  cidr: string;
  tier: Tier; // decided by the adapter (route table igw- route, else map_public_ip_on_launch)
  name: string; // Name tag, falls back to id
}

export interface TopologyNode {
  id: string; // AWS resource id when one exists (i-…, nat-…), otherwise `${kind}:${name}`
  kind: NodeKind;
  name: string; // display name; never empty
  vpcId?: string; // absent for account-global kinds
  subnetId?: string; // absent for VPC-level services (alb, rds, msk, …)
  az?: string; // own AZ or the subnet's AZ
  state?: string; // running / stopped / available …
  // Kind-specific extras (instanceType, scheme, engine, runtime, …).
  // Consumers read known keys defensively; see src/lib/topology/CLAUDE.md for the key list.
  meta: Record<string, unknown>;
}

// Endpoints reference an element id: a node id, a subnet id, or a VPC id.
// applyFilter drops an edge as soon as either endpoint leaves the graph.
// 엣지 끝점은 노드·서브넷·VPC id 중 하나. 끝점이 사라지면 엣지도 사라진다.
export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface TopologyGraph {
  meta: TopologyMeta;
  vpcs: TopologyVpc[];
  subnets: TopologySubnet[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export const emptyGraph = (source: TopologySource, generatedAt: string): TopologyGraph => ({
  meta: { source, generatedAt },
  vpcs: [],
  subnets: [],
  nodes: [],
  edges: [],
});
