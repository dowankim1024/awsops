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

// Explicit relationships, recorded as such by an AWS API.
// target: load balancer -> instance (target group membership)
// route:  subnet -> gateway node (nat / igw / tgw) from its route table
// attach: gateway node (igw / tgw attachment) -> VPC
// egress: nat -> igw (the NAT's public subnet routes to the IGW)
// AWS API가 관계로 기록해 둔 것들.
export const EXPLICIT_EDGE_KINDS = ['target', 'route', 'attach', 'egress'] as const;

// Inferred from configuration: a permitted path, never observed traffic.
// allows:   a security group ingress rule opens A -> B
// permits:  an IAM role attached to A allows a data action on bucket / table B
// endpoint: a subnet reaches a service through a VPC endpoint
// triggers: an event source (bucket, stream, cluster) invokes a Lambda
// origin:   an edge service points at a target (Route 53 -> CloudFront -> ALB / S3)
// 설정에서 추론한 "열려 있는 길". 실제 지나간 트래픽이 아니다. ADR-014.
export const DERIVED_EDGE_KINDS = ['allows', 'permits', 'endpoint', 'triggers', 'origin'] as const;

export const EDGE_KINDS = [...EXPLICIT_EDGE_KINDS, ...DERIVED_EDGE_KINDS] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const isEdgeKind = (v: unknown): v is EdgeKind =>
  typeof v === 'string' && (EDGE_KINDS as readonly string[]).includes(v);
export const isDerivedEdgeKind = (k: EdgeKind): boolean =>
  (DERIVED_EDGE_KINDS as readonly string[]).includes(k);

// Which configuration produced an inferred edge. Explicit edges have no `derived`.
// 추론 엣지의 근거. 명시 관계에는 없다.
export const DERIVED_SOURCES = ['sg', 'iam', 'endpoint', 'event', 'dns'] as const;
export type DerivedSource = (typeof DERIVED_SOURCES)[number];
export const isDerivedSource = (v: unknown): v is DerivedSource =>
  typeof v === 'string' && (DERIVED_SOURCES as readonly string[]).includes(v);

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

export interface TopologyEdgeMeta {
  derived?: DerivedSource; // absent on explicit relationships / 명시 관계에는 없다
  ports?: string[]; // '3306', '8000-8100', 'all' / 포트 표기
  protocol?: string; // tcp / udp / all
  actions?: string[]; // IAM actions behind a `permits` edge / permits의 IAM 액션
  roleArn?: string;
  disabled?: boolean; // event source mapping that is not Enabled / 비활성 이벤트 매핑
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
  meta?: TopologyEdgeMeta;
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
