// Live adapter: Steampipe relationship rows -> TopologyGraph.
// This is the only place that knows the column names of src/lib/queries/relationships.ts.
// The classification logic (public/private tiering, ALB target resolution, service AZ
// placement) moved here from src/lib/fossflow/generator.ts so both the FossFLOW view
// and the 3D view consume the same graph.
// Steampipe 행을 TopologyGraph로 바꾸는 유일한 지점. 컬럼명은 relationships.ts와 맞춘다.
import {
  withInferredEdges,
  type BucketNotificationFact,
  type DnsRecordFact,
  type EndpointFact,
  type EventSourceFact,
  type InferInput,
  type OriginFact,
  type RoleGrantFact,
  type SgRuleFact,
} from '../infer';
import {
  type EdgeKind,
  type TopologyEdge,
  type TopologyGraph,
  type TopologyNode,
  type TopologySubnet,
  type TopologyVpc,
} from '../types';

type Row = Record<string, any>;

// Row bags keyed like the topology-view page's /api/steampipe request.
// topology-view 페이지가 /api/steampipe에 보내는 쿼리 키와 같은 이름.
export interface LiveTopologyRows {
  vpcSubnets: Row[];
  ec2: Row[];
  elb: Row[];
  nat: Row[];
  routeTables: Row[];
  targetGroups: Row[];
  igw?: Row[];
  tgw?: Row[];
  rds?: Row[];
  elasticache?: Row[];
  msk?: Row[];
  opensearch?: Row[];
  lambdaVpc?: Row[];
  vpcEndpoints?: Row[];
  s3?: Row[];
  dynamodb?: Row[];
  cloudfront?: Row[];
  route53?: Row[];
  // Configuration inference (ADR-014). All optional: without them the graph is
  // exactly the pre-4.6 one, explicit relationships only.
  // 설정 추론용. 없으면 명시 관계만 있는 이전 그래프와 같다.
  sgRules?: Row[];
  instanceProfiles?: Row[];
  roles?: Row[]; // second pass, narrowed to the roles resources use
  policies?: Row[]; // third pass, the managed policies those roles attach
  eventSourceMappings?: Row[];
  route53Records?: Row[];
}

export interface LiveAdapterOptions {
  accountId?: string;
  now?: Date; // injectable for deterministic tests / 테스트용 고정 시각
}

// ---- helpers ----
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  const bits = Number(bitsStr);
  if (ipInt === null || netInt === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

const shortService = (serviceName: string): string =>
  serviceName.replace(/^com\.amazonaws\.[a-z0-9-]+\./, '');

// Security groups come back in three shapes across the AWS tables: a plain array
// of ids (ALB, Lambda, MSK, OpenSearch), `[{GroupId}]` (EC2) and
// `[{VpcSecurityGroupId}]` (RDS, ElastiCache). One reader for all of them.
// 테이블마다 보안그룹 표현이 셋이라 한 곳에서 읽는다.
export function securityGroupIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item) out.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const r = item as Row;
    const id = str(r.GroupId || r.VpcSecurityGroupId || r.SecurityGroupId || r.groupId);
    if (id) out.push(id);
  }
  return Array.from(new Set(out));
}

// `Statement` lives at a different depth in policy_std, inline_policies_std and
// the raw documents, so we walk until we find statements rather than assuming a
// shape. Anything unrecognised yields nothing instead of throwing.
// 정책 문서마다 Statement 위치가 달라 찾을 때까지 훑는다. 모르는 모양이면 빈 배열.
export function policyStatements(doc: unknown, depth = 0): Row[] {
  if (!doc || depth > 4) return [];
  if (Array.isArray(doc)) return doc.flatMap((d) => policyStatements(d, depth + 1));
  if (typeof doc !== 'object') return [];
  const r = doc as Row;
  if (r.Statement !== undefined) {
    return Array.isArray(r.Statement) ? (r.Statement as Row[]) : [r.Statement as Row];
  }
  if (r.PolicyDocument !== undefined) return policyStatements(r.PolicyDocument, depth + 1);
  if (r.policyDocument !== undefined) return policyStatements(r.policyDocument, depth + 1);
  // inline_policies as a { name: document } map
  return Object.values(r).flatMap((v) => policyStatements(v, depth + 1));
}

const asList = (v: unknown): string[] => {
  if (typeof v === 'string') return v ? [v] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
};

// Allow statements only, flattened to the actions and resources this module can
// act on. Deny, conditions and resource policies are out of scope (ADR-014).
// Allow 구문만, 액션·리소스를 펴서 돌려준다. Deny·조건·리소스 정책은 범위 밖이다.
export function allowGrants(roleArn: string, doc: unknown): RoleGrantFact[] {
  const out: RoleGrantFact[] = [];
  for (const st of policyStatements(doc)) {
    if (!st || typeof st !== 'object') continue;
    if (String(st.Effect ?? '').toLowerCase() !== 'allow') continue;
    const actions = asList(st.Action);
    const resources = asList(st.Resource);
    if (actions.length && resources.length) out.push({ roleArn, actions, resources });
  }
  return out;
}

// Role ARNs the resources in `rows` actually use — the IN list for the second
// IAM pass. Instances reach a role through their instance profile.
// 리소스가 실제로 쓰는 롤 ARN. IAM 2차 조회의 IN 목록이 된다.
export function usedRoleArns(rows: LiveTopologyRows): string[] {
  const roleByProfile = new Map<string, string[]>();
  (rows.instanceProfiles || []).forEach((r) => {
    const arn = str(r.arn);
    if (!arn) return;
    const roles = Array.isArray(r.roles)
      ? (r.roles as Row[]).map((x) => str(typeof x === 'string' ? x : x?.Arn)).filter(Boolean)
      : [];
    if (roles.length) roleByProfile.set(arn, roles);
  });
  const out = new Set<string>();
  rows.ec2.forEach((r) => {
    (roleByProfile.get(str(r.iam_instance_profile_arn)) || []).forEach((a) => out.add(a));
  });
  (rows.lambdaVpc || []).forEach((r) => {
    const role = str(r.role);
    if (role) out.add(role);
  });
  return Array.from(out).sort();
}

// The managed policies those roles attach — the IN list for the third pass.
// 그 롤들이 붙인 관리형 정책 ARN. 3차 조회의 IN 목록.
export function attachedPolicyArns(roleRows: Row[]): string[] {
  const out = new Set<string>();
  roleRows.forEach((r) => {
    asList(r.attached_policy_arns).forEach((a) => out.add(a));
  });
  return Array.from(out).sort();
}

export function toTopologyGraph(rows: LiveTopologyRows, opts: LiveAdapterOptions = {}): TopologyGraph {
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const accountId =
    opts.accountId ??
    [rows.vpcSubnets, rows.ec2, rows.elb].flat().map((r) => str(r?.account_id)).find(Boolean);

  // ---- VPCs and subnets ----
  const vpcs: TopologyVpc[] = [];
  const vpcSeen = new Set<string>();
  rows.vpcSubnets.forEach((r) => {
    const id = str(r.vpc_id);
    if (!id || vpcSeen.has(id)) return;
    vpcSeen.add(id);
    vpcs.push({ id, name: str(r.vpc_name) || id, cidr: str(r.vpc_cidr) });
  });

  // Route tables: explicit subnet association wins, then the VPC's main table.
  // A subnet is public when its effective table has an igw- route; with no table
  // at all we fall back to map_public_ip_on_launch.
  // 명시 연결 라우트 테이블 > 메인 테이블. igw- 경로가 있으면 퍼블릭, 테이블이 없으면 map_public_ip_on_launch.
  const subnetRtb = new Map<string, Row>();
  const mainRtb = new Map<string, Row>();
  rows.routeTables.forEach((rt) => {
    (rt.associations || []).forEach((a: Row) => {
      if (a?.SubnetId) subnetRtb.set(a.SubnetId, rt);
      if (a?.Main) mainRtb.set(str(rt.vpc_id), rt);
    });
  });
  const routesOf = (sid: string, vpcId: string): Row[] => {
    const rt = subnetRtb.get(sid) || mainRtb.get(vpcId);
    return rt ? rt.routes || [] : [];
  };
  const hasTable = (sid: string, vpcId: string) => Boolean(subnetRtb.get(sid) || mainRtb.get(vpcId));

  const subnets: TopologySubnet[] = [];
  const subnetSeen = new Set<string>();
  rows.vpcSubnets.forEach((r) => {
    const id = str(r.subnet_id);
    const vpcId = str(r.vpc_id);
    if (!id || !vpcId || subnetSeen.has(id)) return;
    subnetSeen.add(id);
    const isPublic = hasTable(id, vpcId)
      ? routesOf(id, vpcId).some((rt: Row) => str(rt?.GatewayId).startsWith('igw-'))
      : Boolean(r.map_public_ip_on_launch);
    subnets.push({
      id,
      vpcId,
      az: str(r.availability_zone),
      cidr: str(r.subnet_cidr),
      tier: isPublic ? 'public' : 'private',
      name: str(r.subnet_name) || id,
    });
  });
  const subnetById = new Map(subnets.map((s) => [s.id, s]));
  const azOf = (sid: unknown): string | undefined => subnetById.get(str(sid))?.az || undefined;
  const vpcOfSubnets = (sids: string[]): string | undefined => {
    for (const sid of sids) {
      const v = subnetById.get(sid)?.vpcId;
      if (v) return v;
    }
    return undefined;
  };

  // An instance names its profile, not its role; resolve the hop once up front.
  // 인스턴스는 롤이 아니라 프로파일을 가리키므로 미리 한 번 풀어 둔다.
  const roleByProfileArn = new Map<string, string>();
  (rows.instanceProfiles || []).forEach((r) => {
    const arn = str(r.arn);
    const roles = Array.isArray(r.roles) ? (r.roles as Row[]) : [];
    const first = roles.map((x) => str(typeof x === 'string' ? x : x?.Arn)).find(Boolean);
    if (arn && first) roleByProfileArn.set(arn, first);
  });
  const roleOfProfile = (profileArn: string): string => roleByProfileArn.get(profileArn) || '';

  // Route 53 keeps only the records that resolve to something on screen; the
  // rest are reported as a count so a zone with 400 records stays one node.
  // 화면에 있는 대상으로 풀리는 레코드만 쓰고, 나머지는 개수로만 남긴다.
  const recordsByZone = new Map<string, number>();
  (rows.route53Records || []).forEach((r) => {
    const zone = str(r.zone_id);
    if (zone) recordsByZone.set(zone, (recordsByZone.get(zone) ?? 0) + 1);
  });
  const recordCount = (zoneId: string): number => recordsByZone.get(zoneId) ?? 0;

  const nodes: TopologyNode[] = [];
  const nodeIds = new Set<string>();
  const push = (n: TopologyNode) => {
    if (!n.id || nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const vpcOrUndef = (v: unknown): string | undefined => {
    const s = str(v);
    return s && vpcSeen.has(s) ? s : undefined;
  };

  // ---- EC2 (terminated instances are gone; drop them here) ----
  const ec2Rows = rows.ec2.filter((r) => str(r.instance_state) !== 'terminated' && str(r.instance_id));
  ec2Rows.forEach((r) => {
    const id = str(r.instance_id);
    const nameTag = str(r.name) || null;
    push({
      id,
      kind: 'ec2',
      name: nameTag || id,
      vpcId: vpcOrUndef(r.vpc_id),
      subnetId: subnetById.has(str(r.subnet_id)) ? str(r.subnet_id) : undefined,
      az: azOf(r.subnet_id),
      state: str(r.instance_state) || undefined,
      meta: {
        nameTag,
        instanceType: str(r.instance_type) || null,
        privateIp: str(r.private_ip_address) || null,
        publicIp: str(r.public_ip_address) || null,
        eksCluster: str(r.eks_cluster) || null,
        securityGroups: securityGroupIds(r.security_groups),
        roleArn: roleOfProfile(str(r.iam_instance_profile_arn)) || null,
      },
    });
  });

  // ---- EKS cluster markers derived from instance tags ----
  const eksSeen = new Set<string>();
  ec2Rows.forEach((r) => {
    const cluster = str(r.eks_cluster);
    if (!cluster || eksSeen.has(cluster)) return;
    eksSeen.add(cluster);
    push({ id: `eks:${cluster}`, kind: 'eks', name: cluster, vpcId: vpcOrUndef(r.vpc_id), meta: {} });
  });

  // ---- Load balancers ----
  const elbNodeIdByArn = new Map<string, string>();
  rows.elb.forEach((r) => {
    const name = str(r.elb_name);
    if (!name) return;
    const kind = str(r.type) === 'network' ? 'nlb' : 'alb';
    const id = `${kind}:${name}`;
    elbNodeIdByArn.set(str(r.arn), id);
    push({
      id,
      kind,
      name,
      vpcId: vpcOrUndef(r.vpc_id),
      meta: {
        arn: str(r.arn) || null,
        scheme: str(r.scheme) || null,
        dnsName: str(r.dns_name) || null,
        availabilityZones: r.availability_zones ?? null,
        securityGroups: securityGroupIds(r.security_groups),
      },
    });
  });

  // ---- NAT / IGW / TGW ----
  rows.nat.forEach((r) => {
    const id = str(r.nat_gateway_id);
    if (!id || str(r.state) === 'deleted') return;
    push({
      id,
      kind: 'nat',
      name: str(r.name) || id,
      vpcId: vpcOrUndef(r.vpc_id),
      subnetId: subnetById.has(str(r.subnet_id)) ? str(r.subnet_id) : undefined,
      az: azOf(r.subnet_id),
      state: str(r.state) || undefined,
      meta: {},
    });
  });
  (rows.igw || []).forEach((r) => {
    const id = str(r.internet_gateway_id);
    if (!id) return;
    push({ id, kind: 'igw', name: str(r.name) || id, vpcId: vpcOrUndef(r.vpc_id), meta: {} });
  });
  (rows.tgw || []).forEach((r) => {
    const id = str(r.transit_gateway_attachment_id);
    if (!id || str(r.state) === 'deleted') return;
    push({
      id,
      kind: 'tgw',
      name: str(r.name) || str(r.transit_gateway_id) || id,
      vpcId: vpcOrUndef(r.resource_id),
      state: str(r.state) || undefined,
      meta: { transitGatewayId: str(r.transit_gateway_id) || null, resourceType: str(r.resource_type) || null },
    });
  });

  // ---- Managed data services (VPC-level, AZ-placed) ----
  (rows.rds || []).forEach((r) => {
    const name = str(r.db_instance_identifier);
    if (!name) return;
    push({
      id: `rds:${name}`,
      kind: 'rds',
      name,
      vpcId: vpcOrUndef(r.vpc_id),
      az: str(r.availability_zone) || undefined,
      meta: {
        engine: str(r.engine) || null,
        instanceClass: str(r.db_instance_class) || null,
        endpoint: str(r.endpoint_address) || null,
        securityGroups: securityGroupIds(r.vpc_security_groups),
      },
    });
  });
  (rows.elasticache || []).forEach((r) => {
    const name = str(r.cache_cluster_id);
    if (!name) return;
    push({
      id: `elasticache:${name}`,
      kind: 'elasticache',
      name,
      vpcId: vpcOrUndef(r.vpc_id),
      az: str(r.availability_zone) || undefined,
      meta: { engine: str(r.engine) || null, securityGroups: securityGroupIds(r.security_groups) },
    });
  });
  const azsOfSubnets = (sids: string[]): string[] =>
    Array.from(new Set(sids.map((sid) => subnetById.get(sid)?.az).filter((a): a is string => Boolean(a)))).sort();
  (rows.msk || []).forEach((r) => {
    const name = str(r.cluster_name);
    if (!name) return;
    const subnetIds = strList(r.client_subnets);
    push({
      id: `msk:${name}`,
      kind: 'msk',
      name,
      vpcId: vpcOfSubnets(subnetIds),
      state: str(r.state) || undefined,
      meta: { subnetIds, azs: azsOfSubnets(subnetIds), securityGroups: securityGroupIds(r.security_groups) },
    });
  });
  (rows.opensearch || []).forEach((r) => {
    const name = str(r.domain_name);
    if (!name) return;
    const subnetIds = strList(r.subnet_ids);
    push({
      id: `opensearch:${name}`,
      kind: 'opensearch',
      name,
      vpcId: vpcOfSubnets(subnetIds),
      meta: {
        subnetIds,
        azs: azsOfSubnets(subnetIds),
        engineVersion: str(r.engine_version) || null,
        securityGroups: securityGroupIds(r.security_groups),
      },
    });
  });

  // ---- VPC Lambdas: live in their first subnet ----
  (rows.lambdaVpc || []).forEach((r) => {
    const name = str(r.name);
    if (!name) return;
    const subnetIds = strList(r.vpc_subnet_ids);
    const first = subnetIds.find((sid) => subnetById.has(sid));
    push({
      id: `lambda:${name}`,
      kind: 'lambda',
      name,
      vpcId: vpcOrUndef(r.vpc_id) ?? vpcOfSubnets(subnetIds),
      subnetId: first,
      az: first ? azOf(first) : undefined,
      meta: {
        runtime: str(r.runtime) || null,
        subnetIds,
        securityGroups: securityGroupIds(r.vpc_security_group_ids),
        roleArn: str(r.role) || null,
      },
    });
  });

  // ---- VPC endpoints ----
  (rows.vpcEndpoints || []).forEach((r) => {
    const id = str(r.vpc_endpoint_id);
    if (!id) return;
    const serviceName = str(r.service_name);
    push({
      id,
      kind: 'endpoint',
      name: shortService(serviceName) || id,
      vpcId: vpcOrUndef(r.vpc_id),
      meta: {
        serviceName: serviceName || null,
        endpointType: str(r.vpc_endpoint_type) || null,
        routeTableIds: strList(r.route_table_ids),
        subnetIds: strList(r.subnet_ids),
      },
    });
  });

  // ---- Account-global resources ----
  (rows.s3 || []).forEach((r) => {
    const name = str(r.name);
    if (!name) return;
    const region = str(r.region);
    push({
      id: `s3:${name}`,
      kind: 's3',
      name,
      // The virtual-hosted domain a CloudFront origin would name.
      // CloudFront 오리진이 가리킬 가상 호스팅 도메인.
      meta: { region: region || null, domain: region ? `${name}.s3.${region}.amazonaws.com` : `${name}.s3.amazonaws.com` },
    });
  });
  (rows.dynamodb || []).forEach((r) => {
    const name = str(r.name);
    if (name) push({ id: `dynamodb:${name}`, kind: 'dynamodb', name, meta: {} });
  });
  (rows.cloudfront || []).forEach((r) => {
    const id = str(r.id);
    if (!id) return;
    const aliases: string[] = Array.isArray(r.aliases)
      ? strList(r.aliases)
      : strList((r.aliases as Row | null)?.Items);
    push({
      id: `cloudfront:${id}`,
      kind: 'cloudfront',
      name: aliases[0] || str(r.domain_name) || id,
      meta: { distributionId: id, domainName: str(r.domain_name) || null, aliases },
    });
  });
  (rows.route53 || []).forEach((r) => {
    const raw = str(r.name);
    if (!raw) return;
    push({
      id: `route53:${raw}`,
      kind: 'route53',
      name: raw.replace(/\.$/, ''),
      meta: { privateZone: Boolean(r.private_zone), zoneId: str(r.id) || null, records: recordCount(str(r.id)) },
    });
  });

  // ---- Edges ----
  const edges: TopologyEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (kind: EdgeKind, from: string, to: string, label?: string) => {
    const id = `${kind}:${from}->${to}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, from, to, kind, ...(label ? { label } : {}) });
  };

  // target: load balancer -> instance. Instance-id targets must exist in the same
  // VPC; IP targets resolve through subnet CIDRs to the instances in that subnet,
  // preferring EKS-looking names when present.
  // 타겟 그룹의 인스턴스 ID는 같은 VPC 안에서, IP 타겟은 서브넷 CIDR로 소속 인스턴스를 찾는다.
  const ec2ByVpc = new Map<string, TopologyNode[]>();
  const ec2BySubnet = new Map<string, TopologyNode[]>();
  nodes.forEach((n) => {
    if (n.kind !== 'ec2') return;
    if (n.vpcId) ec2ByVpc.set(n.vpcId, [...(ec2ByVpc.get(n.vpcId) || []), n]);
    if (n.subnetId) ec2BySubnet.set(n.subnetId, [...(ec2BySubnet.get(n.subnetId) || []), n]);
  });
  const subnetsByVpc = new Map<string, TopologySubnet[]>();
  subnets.forEach((s) => subnetsByVpc.set(s.vpcId, [...(subnetsByVpc.get(s.vpcId) || []), s]));
  const tgByLb = new Map<string, Row[]>();
  rows.targetGroups.forEach((tg) => {
    strList(tg.load_balancer_arns).forEach((lb) => tgByLb.set(lb, [...(tgByLb.get(lb) || []), tg]));
  });
  nodes
    .filter((n) => n.kind === 'alb' || n.kind === 'nlb')
    .forEach((lb) => {
      const arn = str(lb.meta.arn);
      const vpcId = lb.vpcId;
      if (!arn || !vpcId) return;
      const instIds = new Set((ec2ByVpc.get(vpcId) || []).map((n) => n.id));
      const vSubnets = subnetsByVpc.get(vpcId) || [];
      const subnetContaining = (ip: string) => vSubnets.find((s) => s.cidr && ipInCidr(ip, s.cidr))?.id;
      const targets = new Set<string>();
      (tgByLb.get(arn) || []).forEach((tg) => {
        (tg.target_health_descriptions || []).forEach((thd: Row) => {
          const tid = str(thd?.Target?.Id);
          if (!tid) return;
          if (tid.startsWith('i-')) {
            if (instIds.has(tid)) targets.add(tid);
            return;
          }
          const sid = subnetContaining(tid);
          if (!sid) return;
          const cands = ec2BySubnet.get(sid) || [];
          const eks = cands.filter((c) => /eks|worker|node/i.test(str(c.meta.nameTag)));
          (eks.length ? eks : cands).forEach((c) => targets.add(c.id));
        });
      });
      Array.from(targets)
        .sort()
        .forEach((iid) => addEdge('target', lb.id, iid));
    });

  // route: subnet -> gateway (igw / nat / tgw attachment) from its effective route table
  const tgwNodeByGatewayId = new Map<string, string>();
  nodes.forEach((n) => {
    if (n.kind === 'tgw' && n.vpcId) tgwNodeByGatewayId.set(`${n.vpcId}|${str(n.meta.transitGatewayId)}`, n.id);
  });
  subnets.forEach((s) => {
    routesOf(s.id, s.vpcId).forEach((rt: Row) => {
      const label = str(rt?.DestinationCidrBlock) || undefined;
      const gw = str(rt?.GatewayId);
      const nat = str(rt?.NatGatewayId);
      const tgw = str(rt?.TransitGatewayId);
      if (gw.startsWith('igw-') && nodeIds.has(gw)) addEdge('route', s.id, gw, label);
      if (nat && nodeIds.has(nat)) addEdge('route', s.id, nat, label);
      if (tgw) {
        const attach = tgwNodeByGatewayId.get(`${s.vpcId}|${tgw}`);
        if (attach) addEdge('route', s.id, attach, label);
      }
    });
  });

  // attach: igw / tgw attachment -> VPC
  nodes.forEach((n) => {
    if ((n.kind === 'igw' || n.kind === 'tgw') && n.vpcId) addEdge('attach', n.id, n.vpcId);
  });

  // egress: nat -> igw when the NAT's subnet routes to that IGW
  nodes.forEach((n) => {
    if (n.kind !== 'nat' || !n.subnetId || !n.vpcId) return;
    routesOf(n.subnetId, n.vpcId).forEach((rt: Row) => {
      const gw = str(rt?.GatewayId);
      if (gw.startsWith('igw-') && nodeIds.has(gw)) addEdge('egress', n.id, gw);
    });
  });

  const graph: TopologyGraph = {
    meta: { source: 'live', generatedAt, ...(accountId ? { accountId } : {}) },
    vpcs,
    subnets,
    nodes,
    edges,
  };

  // ---- configuration inference (ADR-014) ----
  // Rows in, normalised facts out; inferEdges owns every rule. Parsing IAM here
  // rather than server-side keeps the rules pure and unit-testable.
  // 행을 정규화된 사실로 바꿔 넘긴다. 규칙은 inferEdges가 전부 갖는다.
  const inferInput = buildInferInput(rows, nodes, roleByProfileArn);
  if (!inferInput) return graph;

  // `Resource: "*"` is a badge on the node, never a line: it would connect the
  // instance to every bucket in the account.
  // 와일드카드 리소스는 선이 아니라 노드 배지로만 남긴다.
  const wildcardRoles = new Set(
    (inferInput.roleGrants ?? [])
      .filter((g) => g.resources.includes('*') || g.resources.some((r) => r.endsWith(':::*')))
      .map((g) => g.roleArn)
  );
  nodes.forEach((n) => {
    if (typeof n.meta.roleArn === 'string' && wildcardRoles.has(n.meta.roleArn)) n.meta.iamWildcard = true;
  });

  return withInferredEdges(graph, inferInput);
}

// Returns null when none of the inference queries ran, so a caller that only
// fetched the original bag gets the pre-4.6 graph untouched.
// 추론 쿼리를 하나도 받지 않았으면 null을 돌려 이전 그래프를 그대로 둔다.
function buildInferInput(
  rows: LiveTopologyRows,
  nodes: TopologyNode[],
  roleByProfileArn: Map<string, string>
): InferInput | null {
  const any =
    rows.sgRules || rows.instanceProfiles || rows.roles || rows.policies || rows.eventSourceMappings || rows.route53Records;
  if (!any) return null;

  const securityGroupRules: SgRuleFact[] = (rows.sgRules || []).map((r) => ({
    groupId: str(r.group_id),
    isEgress: Boolean(r.is_egress),
    referencedGroupId: str(r.referenced_group_id) || null,
    cidrIpv4: str(r.cidr_ipv4) || null,
    fromPort: typeof r.from_port === 'number' ? r.from_port : Number(r.from_port ?? NaN),
    toPort: typeof r.to_port === 'number' ? r.to_port : Number(r.to_port ?? NaN),
    ipProtocol: str(r.ip_protocol) || null,
  }));

  // Inline policies come with the role; managed ones arrive in the third pass and
  // are attributed back to every role that attaches them.
  // 인라인 정책은 롤과 함께 오고, 관리형 정책은 3차 조회로 와서 붙인 롤마다 귀속된다.
  const roleGrants: RoleGrantFact[] = [];
  const policyById = new Map<string, unknown>();
  (rows.policies || []).forEach((r) => {
    const arn = str(r.arn);
    if (arn) policyById.set(arn, r.policy_std ?? r.policy);
  });
  (rows.roles || []).forEach((r) => {
    const roleArn = str(r.arn);
    if (!roleArn) return;
    roleGrants.push(...allowGrants(roleArn, r.inline_policies_std ?? r.inline_policies));
    (Array.isArray(r.attached_policy_arns) ? r.attached_policy_arns : []).forEach((a: unknown) => {
      const doc = policyById.get(str(a));
      if (doc) roleGrants.push(...allowGrants(roleArn, doc));
    });
  });
  // A grant nobody holds is dropped early so inferEdges never walks it.
  const heldRoles = new Set(
    nodes.map((n) => (typeof n.meta.roleArn === 'string' ? n.meta.roleArn : '')).filter(Boolean)
  );
  roleByProfileArn.forEach((role) => heldRoles.add(role));

  const endpoints: EndpointFact[] = nodes
    .filter((n) => n.kind === 'endpoint')
    .map((n) => ({
      endpointId: n.id,
      serviceName: str(n.meta.serviceName),
      endpointType: str(n.meta.endpointType) || 'Interface',
      routeTableIds: strList(n.meta.routeTableIds),
      subnetIds: strList(n.meta.subnetIds),
    }));

  // Gateway endpoints reach a subnet through a route table, so the associations
  // of the route-table rows are the join.
  // Gateway 엔드포인트는 라우트 테이블을 통해 서브넷에 닿는다.
  const routeTableSubnets: Record<string, string[]> = {};
  rows.routeTables.forEach((rt) => {
    const id = str(rt.route_table_id);
    if (!id) return;
    const subnetIds = ((rt.associations || []) as Row[])
      .map((a) => str(a?.SubnetId))
      .filter(Boolean);
    if (subnetIds.length) routeTableSubnets[id] = subnetIds;
  });

  const eventSources: EventSourceFact[] = (rows.eventSourceMappings || []).map((r) => ({
    sourceArn: str(r.arn),
    functionArn: str(r.function_arn),
    enabled: str(r.state) === 'Enabled',
  }));

  const bucketNotifications: BucketNotificationFact[] = [];
  (rows.s3 || []).forEach((r) => {
    const bucket = str(r.name);
    const cfg = r.event_notification_configuration as Row | null;
    const fns = Array.isArray(cfg?.LambdaFunctionConfigurations)
      ? (cfg!.LambdaFunctionConfigurations as Row[]).map((c) => str(c?.LambdaFunctionArn)).filter(Boolean)
      : [];
    if (bucket && fns.length) bucketNotifications.push({ bucket, functionArns: fns });
  });

  const origins: OriginFact[] = [];
  (rows.cloudfront || []).forEach((r) => {
    const id = str(r.id);
    const raw = r.origins;
    const items: Row[] = Array.isArray(raw) ? raw : Array.isArray((raw as Row)?.Items) ? ((raw as Row).Items as Row[]) : [];
    const domains = items.map((o) => str(o?.DomainName)).filter(Boolean);
    if (id && domains.length) origins.push({ distributionId: id, domains });
  });

  // Zone id -> zone name, so a record can name the zone node it belongs to.
  // 레코드가 어느 존 노드에 속하는지 이름으로 잇는다.
  const zoneNameById = new Map<string, string>();
  (rows.route53 || []).forEach((r) => {
    const id = str(r.id);
    const name = str(r.name);
    if (id && name) zoneNameById.set(id, name);
  });
  const dnsRecords: DnsRecordFact[] = [];
  (rows.route53Records || []).forEach((r) => {
    const zoneName = zoneNameById.get(str(r.zone_id));
    if (!zoneName) return;
    const alias = str((r.alias_target as Row | null)?.DNSName);
    const values = strList(r.records);
    const targets = [alias, ...values].filter(Boolean);
    if (targets.length) dnsRecords.push({ zoneName, type: str(r.type), targets });
  });

  return {
    securityGroupRules,
    roleGrants: roleGrants.filter((g) => heldRoles.has(g.roleArn)),
    endpoints,
    routeTableSubnets,
    eventSources,
    bucketNotifications,
    origins,
    dnsRecords,
  };
}
