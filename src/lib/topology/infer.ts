// Configuration inference: "which paths are open", derived from settings AWS
// already returns from read-only Describe/List/Get calls. Nothing here observes
// traffic — an inferred edge says a request *may* travel that way, not that one
// did. See docs/decisions/014-topology-inferred-flows.md.
//
// The input is normalised facts, not Steampipe rows: the live adapter maps rows
// onto them and the generator synthesises them, so both sources go through the
// exact same five rules and the same tests cover both.
// 설정 추론. "열려 있는 길"이지 "지나간 트래픽"이 아니다. 입력은 Steampipe 행이 아니라 정규화된
// 사실이며, 라이브 어댑터와 생성기가 같은 규칙 5개를 통과한다. ADR-014.
import {
  type DerivedSource,
  type EdgeKind,
  type TopologyEdge,
  type TopologyEdgeMeta,
  type TopologyGraph,
  type TopologyNode,
} from './types';

// ---- input facts ----

// One row of aws_vpc_security_group_rule. Either referencedGroupId or cidrIpv4
// carries the source; both null means a prefix list or IPv6, which we skip.
// 보안그룹 규칙 하나. 출발점은 참조 SG 또는 CIDR. 둘 다 없으면(프리픽스 목록·IPv6) 건너뛴다.
export interface SgRuleFact {
  groupId: string;
  isEgress: boolean;
  referencedGroupId?: string | null;
  cidrIpv4?: string | null;
  fromPort?: number | null;
  toPort?: number | null;
  ipProtocol?: string | null;
}

// One `Effect: Allow` statement of a role's inline or attached policy, already
// flattened: Action and Resource as string arrays.
// 롤 정책의 Allow 구문 하나. Action·Resource를 배열로 펴 둔 것.
export interface RoleGrantFact {
  roleArn: string;
  actions: string[];
  resources: string[];
}

export interface EndpointFact {
  endpointId: string; // vpce-…, must exist as a node / 노드로 존재해야 한다
  serviceName: string;
  endpointType: string; // Gateway | Interface
  routeTableIds?: string[]; // Gateway: subnets come through the route tables
  subnetIds?: string[]; // Interface: ENIs live in these subnets
}

export interface EventSourceFact {
  sourceArn: string; // DynamoDB stream / MSK cluster / Kinesis stream ARN
  functionArn: string;
  enabled: boolean;
}

export interface BucketNotificationFact {
  bucket: string;
  functionArns: string[];
}

export interface OriginFact {
  distributionId: string;
  domains: string[]; // origin DomainName values / 오리진 도메인
}

export interface DnsRecordFact {
  zoneName: string; // hosting zone name, trailing dot optional / 호스팅 존 이름
  type: string; // only A / AAAA / CNAME are used
  targets: string[]; // alias DNSName and/or record values
}

export interface InferInput {
  securityGroupRules?: SgRuleFact[];
  roleGrants?: RoleGrantFact[];
  endpoints?: EndpointFact[];
  routeTableSubnets?: Record<string, string[]>; // route table id -> associated subnets
  eventSources?: EventSourceFact[];
  bucketNotifications?: BucketNotificationFact[];
  origins?: OriginFact[];
  dnsRecords?: DnsRecordFact[];
}

// Data-plane actions worth a line. A control-plane action (s3:ListAllMyBuckets,
// dynamodb:DescribeTable) says nothing about a request path.
// 데이터 평면 액션만 선으로 그린다. 컨트롤 평면 액션은 요청 경로를 말해 주지 않는다.
const PERMIT_SERVICES = new Set(['s3', 'dynamodb']);
const CONTROL_PLANE_ACTIONS = new Set([
  's3:listallmybuckets',
  's3:getbucketlocation',
  's3:listbucket',
  's3:getbucketacl',
  's3:getbucketpolicy',
  'dynamodb:describetable',
  'dynamodb:listtables',
  'dynamodb:describelimits',
]);

// ---- CIDR helpers ----

const ipv4ToInt = (ip: string): number | null => {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};

interface Net {
  base: number;
  bits: number;
}

export const parseCidr = (cidr: string): Net | null => {
  const [addr, bitsStr] = String(cidr).trim().split('/');
  const base = ipv4ToInt(addr ?? '');
  const bits = Number(bitsStr);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits };
};

// True when `outer` covers every address of `inner` (equal ranges included).
// outer가 inner를 완전히 포함하면 true (같은 범위 포함).
export function cidrContains(outer: string, inner: string): boolean {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (!a || !b || a.bits > b.bits) return false;
  const mask = a.bits === 0 ? 0 : (~0 << (32 - a.bits)) >>> 0;
  return ((b.base & mask) >>> 0) === a.base;
}

export const isAnyIpv4 = (cidr: string): boolean => String(cidr).trim() === '0.0.0.0/0';

// ---- ARN / domain helpers ----

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const dropDot = (v: string): string => v.replace(/\.$/, '');
export const normalizeDomain = (v: unknown): string => dropDot(lower(v));

// arn:aws:s3:::bucket, arn:aws:s3:::bucket/* -> s3:bucket
// arn:aws:dynamodb:<region>:<acct>:table/name[/index/…] -> dynamodb:name
// A wildcard anywhere in the resource part means "every bucket" and never draws.
// 리소스에 와일드카드가 있으면 선을 긋지 않는다.
export function dataResourceNodeId(arn: string): string | null {
  const v = String(arn ?? '').trim();
  if (!v || v === '*') return null;
  const s3 = v.match(/^arn:[^:]*:s3:::([^/*\s]+)(?:\/.*)?$/i);
  if (s3) return `s3:${s3[1]}`;
  const ddb = v.match(/^arn:[^:]*:dynamodb:[^:]*:[^:]*:table\/([^/*\s]+)(?:\/.*)?$/i);
  if (ddb) return `dynamodb:${ddb[1]}`;
  return null;
}

// arn:aws:lambda:<region>:<acct>:function:name[:qualifier] -> lambda:name
export function lambdaNodeId(arn: string): string | null {
  const m = String(arn ?? '')
    .trim()
    .match(/^arn:[^:]*:lambda:[^:]*:[^:]*:function:([^:\s]+)/i);
  return m ? `lambda:${m[1]}` : null;
}

// DynamoDB stream / MSK cluster / (unsupported) Kinesis stream ARN -> node id.
// 이벤트 소스 ARN을 노드 id로.
export function eventSourceNodeId(arn: string): string | null {
  const v = String(arn ?? '').trim();
  const ddb = v.match(/^arn:[^:]*:dynamodb:[^:]*:[^:]*:table\/([^/\s]+)\/stream\//i);
  if (ddb) return `dynamodb:${ddb[1]}`;
  const msk = v.match(/^arn:[^:]*:kafka:[^:]*:[^:]*:cluster\/([^/\s]+)\//i);
  if (msk) return `msk:${msk[1]}`;
  return null;
}

// <bucket>.s3.amazonaws.com, <bucket>.s3.<region>.amazonaws.com,
// <bucket>.s3-website-<region>.amazonaws.com -> bucket name.
// S3 버킷 도메인에서 버킷 이름을 뽑는다.
export function bucketFromDomain(domain: string): string | null {
  const d = normalizeDomain(domain);
  const m = d.match(/^(.+?)\.s3[.-](?:[a-z0-9-]+\.)*amazonaws\.com$/);
  return m && m[1] ? m[1] : null;
}

// ---- ports ----

const portLabel = (rule: SgRuleFact): string => {
  const proto = lower(rule.ipProtocol);
  if (proto === '-1' || proto === 'all' || proto === '') return 'all';
  const from = rule.fromPort;
  const to = rule.toPort;
  if (typeof from !== 'number' || typeof to !== 'number') return 'all';
  if (from === -1 && to === -1) return 'all';
  if (from === 0 && to === 65535) return 'all';
  return from === to ? String(from) : `${from}-${to}`;
};

const protocolLabel = (rule: SgRuleFact): string => {
  const proto = lower(rule.ipProtocol);
  return !proto || proto === '-1' ? 'all' : proto;
};

// ---- edge accumulation ----

const uniqSorted = (a: readonly string[] | undefined, b: readonly string[]): string[] =>
  Array.from(new Set([...(a ?? []), ...b])).sort();

// Same (from, to, kind) is one edge; ports and actions accumulate onto it, so a
// data-tier SG open on 3306 and 6379 is one line labelled with both.
// 같은 (from, to, kind)는 엣지 하나. 포트·액션은 그 위에 쌓인다.
class EdgeBag {
  private byId = new Map<string, TopologyEdge>();
  readonly list: TopologyEdge[] = [];

  add(
    kind: EdgeKind,
    from: string,
    to: string,
    derived: DerivedSource,
    extra: Omit<TopologyEdgeMeta, 'derived'> = {}
  ): void {
    if (!from || !to || from === to) return;
    const id = `${kind}:${from}->${to}`;
    const existing = this.byId.get(id);
    if (!existing) {
      const meta: TopologyEdgeMeta = { derived };
      if (extra.ports?.length) meta.ports = uniqSorted([], extra.ports);
      if (extra.protocol) meta.protocol = extra.protocol;
      if (extra.actions?.length) meta.actions = uniqSorted([], extra.actions);
      if (extra.roleArn) meta.roleArn = extra.roleArn;
      if (extra.disabled) meta.disabled = true;
      const edge: TopologyEdge = { id, from, to, kind, meta };
      this.byId.set(id, edge);
      this.list.push(edge);
      return;
    }
    const meta = existing.meta as TopologyEdgeMeta;
    if (extra.ports?.length) meta.ports = uniqSorted(meta.ports, extra.ports);
    if (extra.actions?.length) meta.actions = uniqSorted(meta.actions, extra.actions);
    // Mixed protocols on one pair collapse to "all"; a mapping counts as enabled
    // as soon as any of the merged ones is.
    // 프로토콜이 섞이면 all, 매핑은 하나라도 켜져 있으면 켜진 것으로 본다.
    if (extra.protocol && meta.protocol && meta.protocol !== extra.protocol) meta.protocol = 'all';
    else if (extra.protocol && !meta.protocol) meta.protocol = extra.protocol;
    if (!extra.disabled) delete meta.disabled;
  }
}

// ---- main ----

interface Index {
  nodeById: Map<string, TopologyNode>;
  bySecurityGroup: Map<string, TopologyNode[]>;
  byRoleArn: Map<string, TopologyNode[]>;
  igwByVpc: Map<string, string>;
  subnetsByVpc: Map<string, { id: string; cidr: string }[]>;
  subnetIds: Set<string>;
  vpcCidr: Map<string, string>;
  albByDomain: Map<string, string>;
  cloudfrontByDomain: Map<string, string>;
  route53ByZone: Map<string, string>;
}

const metaStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

function indexGraph(g: TopologyGraph): Index {
  const idx: Index = {
    nodeById: new Map(),
    bySecurityGroup: new Map(),
    byRoleArn: new Map(),
    igwByVpc: new Map(),
    subnetsByVpc: new Map(),
    subnetIds: new Set(g.subnets.map((s) => s.id)),
    vpcCidr: new Map(g.vpcs.map((v) => [v.id, v.cidr])),
    albByDomain: new Map(),
    cloudfrontByDomain: new Map(),
    route53ByZone: new Map(),
  };
  g.subnets.forEach((s) => {
    const list = idx.subnetsByVpc.get(s.vpcId);
    const entry = { id: s.id, cidr: s.cidr };
    if (list) list.push(entry);
    else idx.subnetsByVpc.set(s.vpcId, [entry]);
  });
  g.nodes.forEach((n) => {
    idx.nodeById.set(n.id, n);
    metaStrings(n.meta.securityGroups).forEach((sg) => {
      const list = idx.bySecurityGroup.get(sg);
      if (list) list.push(n);
      else idx.bySecurityGroup.set(sg, [n]);
    });
    const role = typeof n.meta.roleArn === 'string' ? n.meta.roleArn : '';
    if (role) {
      const list = idx.byRoleArn.get(role);
      if (list) list.push(n);
      else idx.byRoleArn.set(role, [n]);
    }
    if (n.kind === 'igw' && n.vpcId && !idx.igwByVpc.has(n.vpcId)) idx.igwByVpc.set(n.vpcId, n.id);
    if (n.kind === 'alb' || n.kind === 'nlb') {
      const dns = normalizeDomain(n.meta.dnsName);
      if (dns) idx.albByDomain.set(dns, n.id);
    }
    if (n.kind === 'cloudfront') {
      const dns = normalizeDomain(n.meta.domainName);
      if (dns) idx.cloudfrontByDomain.set(dns, n.id);
      metaStrings(n.meta.aliases).forEach((a) => {
        const alias = normalizeDomain(a);
        if (alias) idx.cloudfrontByDomain.set(alias, n.id);
      });
    }
    if (n.kind === 'route53') {
      const zone = normalizeDomain(n.name);
      if (zone) idx.route53ByZone.set(zone, n.id);
    }
  });
  return idx;
}

// ---- rule 1: allows (security groups) ----

function inferAllows(rules: SgRuleFact[], idx: Index, out: EdgeBag): void {
  for (const rule of rules) {
    if (rule.isEgress) continue;
    const targets = idx.bySecurityGroup.get(rule.groupId);
    if (!targets?.length) continue;
    const ports = [portLabel(rule)];
    const protocol = protocolLabel(rule);

    if (rule.referencedGroupId) {
      const sources = idx.bySecurityGroup.get(rule.referencedGroupId);
      if (!sources?.length) continue;
      for (const to of targets) {
        for (const from of sources) out.add('allows', from.id, to.id, 'sg', { ports, protocol });
      }
      continue;
    }

    const cidr = typeof rule.cidrIpv4 === 'string' ? rule.cidrIpv4.trim() : '';
    if (!cidr || !parseCidr(cidr)) continue;

    for (const to of targets) {
      const vpcId = to.vpcId;
      if (!vpcId) continue;
      // Open to the world: the request enters through the internet gateway, so
      // that is the anchor. Meaningful for an internet-facing LB or a bastion.
      // 전체 개방은 인터넷 게이트웨이를 출발점으로 둔다.
      if (isAnyIpv4(cidr)) {
        const igw = idx.igwByVpc.get(vpcId);
        if (igw) out.add('allows', igw, to.id, 'sg', { ports, protocol });
        continue;
      }
      // A rule covering the whole VPC range folds onto the VPC anchor instead of
      // drawing one line per subnet.
      // VPC 전체를 덮는 규칙은 서브넷마다 긋지 않고 VPC 앵커 하나로 접는다.
      const vpcCidr = idx.vpcCidr.get(vpcId);
      if (vpcCidr && cidrContains(cidr, vpcCidr)) {
        out.add('allows', vpcId, to.id, 'sg', { ports, protocol });
        continue;
      }
      for (const s of idx.subnetsByVpc.get(vpcId) ?? []) {
        if (s.cidr && cidrContains(cidr, s.cidr)) out.add('allows', s.id, to.id, 'sg', { ports, protocol });
      }
    }
  }
}

// ---- rule 2: permits (IAM) ----

function inferPermits(grants: RoleGrantFact[], idx: Index, out: EdgeBag): void {
  for (const grant of grants) {
    const holders = idx.byRoleArn.get(grant.roleArn);
    if (!holders?.length) continue;
    const actions = grant.actions
      .map((a) => String(a ?? '').trim())
      .filter((a) => {
        const l = a.toLowerCase();
        if (l === '*') return true;
        const service = l.split(':')[0];
        return PERMIT_SERVICES.has(service) && !CONTROL_PLANE_ACTIONS.has(l);
      });
    if (!actions.length) continue;
    for (const resource of grant.resources) {
      // `Resource: "*"` connects to every bucket in the account; the noise is
      // worse than the information, so it is a node badge, not a line (ADR-014).
      // 와일드카드 리소스는 선을 만들지 않는다. 노드 배지로만 표시한다.
      const target = dataResourceNodeId(resource);
      if (!target || !idx.nodeById.has(target)) continue;
      const service = target.split(':')[0];
      const scoped = actions.filter((a) => a === '*' || a.toLowerCase().startsWith(`${service}:`));
      if (!scoped.length) continue;
      for (const holder of holders) {
        out.add('permits', holder.id, target, 'iam', { actions: scoped, roleArn: grant.roleArn });
      }
    }
  }
}

// ---- rule 3: endpoint (VPC endpoints) ----

function inferEndpoints(
  endpoints: EndpointFact[],
  routeTableSubnets: Record<string, string[]>,
  idx: Index,
  out: EdgeBag
): void {
  for (const ep of endpoints) {
    const node = idx.nodeById.get(ep.endpointId);
    if (!node || node.kind !== 'endpoint') continue;
    // Gateway endpoints are reached by every subnet whose route table carries
    // them; interface endpoints by the subnets holding their ENIs.
    // Gateway는 라우트 테이블이 걸린 서브넷, Interface는 ENI가 있는 서브넷에서 닿는다.
    const subnetIds = new Set<string>();
    (ep.subnetIds ?? []).forEach((sid) => subnetIds.add(sid));
    (ep.routeTableIds ?? []).forEach((rtb) => {
      (routeTableSubnets[rtb] ?? []).forEach((sid) => subnetIds.add(sid));
    });
    subnetIds.forEach((sid) => {
      if (idx.subnetIds.has(sid)) out.add('endpoint', sid, ep.endpointId, 'endpoint');
    });
  }
}

// ---- rule 4: triggers (events) ----

function inferTriggers(
  mappings: EventSourceFact[],
  notifications: BucketNotificationFact[],
  idx: Index,
  out: EdgeBag
): void {
  for (const m of mappings) {
    const from = eventSourceNodeId(m.sourceArn);
    const to = lambdaNodeId(m.functionArn);
    if (!from || !to || !idx.nodeById.has(from) || !idx.nodeById.has(to)) continue;
    out.add('triggers', from, to, 'event', { disabled: !m.enabled });
  }
  for (const n of notifications) {
    const from = `s3:${n.bucket}`;
    if (!n.bucket || !idx.nodeById.has(from)) continue;
    for (const arn of n.functionArns) {
      const to = lambdaNodeId(arn);
      if (to && idx.nodeById.has(to)) out.add('triggers', from, to, 'event');
    }
  }
}

// ---- rule 5: origin (CloudFront / Route 53) ----

function inferOrigins(
  origins: OriginFact[],
  records: DnsRecordFact[],
  idx: Index,
  out: EdgeBag
): void {
  // Only an exact domain match draws a line: a custom origin domain that does
  // not equal an ALB's dns_name or an S3 bucket domain stays unconnected.
  // 정확히 일치할 때만 긋는다. 커스텀 도메인은 잇지 않는다.
  const resolve = (domain: string): string | null => {
    const d = normalizeDomain(domain);
    if (!d) return null;
    const alb = idx.albByDomain.get(d);
    if (alb) return alb;
    const cf = idx.cloudfrontByDomain.get(d);
    if (cf) return cf;
    const bucket = bucketFromDomain(d);
    if (bucket && idx.nodeById.has(`s3:${bucket}`)) return `s3:${bucket}`;
    return null;
  };

  for (const o of origins) {
    const from = `cloudfront:${o.distributionId}`;
    if (!o.distributionId || !idx.nodeById.has(from)) continue;
    for (const domain of o.domains) {
      const to = resolve(domain);
      if (to && to !== from) out.add('origin', from, to, 'dns');
    }
  }

  const DNS_TYPES = new Set(['a', 'aaaa', 'cname']);
  for (const r of records) {
    if (!DNS_TYPES.has(lower(r.type))) continue;
    const from = idx.route53ByZone.get(normalizeDomain(r.zoneName));
    if (!from) continue;
    for (const target of r.targets) {
      const to = resolve(target);
      if (to && to !== from) out.add('origin', from, to, 'dns');
    }
  }
}

// ---- entry point ----

// Pure: same input, same output, same order. Endpoints that are not in the graph
// never produce an edge, so validateGraph stays happy without a second pass.
// 순수 함수. 그래프에 없는 끝점은 엣지를 만들지 않으므로 참조 무결성이 유지된다.
export function inferEdges(input: InferInput, g: TopologyGraph): TopologyEdge[] {
  const idx = indexGraph(g);
  const out = new EdgeBag();
  inferAllows(input.securityGroupRules ?? [], idx, out);
  inferPermits(input.roleGrants ?? [], idx, out);
  inferEndpoints(input.endpoints ?? [], input.routeTableSubnets ?? {}, idx, out);
  inferTriggers(input.eventSources ?? [], input.bucketNotifications ?? [], idx, out);
  inferOrigins(input.origins ?? [], input.dnsRecords ?? [], idx, out);
  return out.list;
}

// Appends inferred edges to a graph, dropping any that duplicate an id already
// present (an explicit relationship always wins).
// 추론 엣지를 그래프에 덧붙인다. 이미 있는 id는 명시 관계가 이긴다.
export function withInferredEdges(g: TopologyGraph, input: InferInput): TopologyGraph {
  const seen = new Set(g.edges.map((e) => e.id));
  const extra = inferEdges(input, g).filter((e) => !seen.has(e.id));
  return extra.length ? { ...g, edges: [...g.edges, ...extra] } : g;
}
