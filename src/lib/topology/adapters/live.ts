// Live adapter: Steampipe relationship rows -> TopologyGraph.
// This is the only place that knows the column names of src/lib/queries/relationships.ts.
// The classification logic (public/private tiering, ALB target resolution, service AZ
// placement) moved here from src/lib/fossflow/generator.ts so both the FossFLOW view
// and the 3D view consume the same graph.
// Steampipe 행을 TopologyGraph로 바꾸는 유일한 지점. 컬럼명은 relationships.ts와 맞춘다.
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
        securityGroups: r.security_groups ?? null,
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
      meta: { engine: str(r.engine) || null },
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
      meta: { subnetIds, azs: azsOfSubnets(subnetIds) },
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
      meta: { subnetIds, azs: azsOfSubnets(subnetIds), engineVersion: str(r.engine_version) || null },
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
      meta: { runtime: str(r.runtime) || null, subnetIds },
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
      meta: { serviceName: serviceName || null, endpointType: str(r.vpc_endpoint_type) || null },
    });
  });

  // ---- Account-global resources ----
  (rows.s3 || []).forEach((r) => {
    const name = str(r.name);
    if (name) push({ id: `s3:${name}`, kind: 's3', name, meta: { region: str(r.region) || null } });
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
      meta: { privateZone: Boolean(r.private_zone) },
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

  return {
    meta: { source: 'live', generatedAt, ...(accountId ? { accountId } : {}) },
    vpcs,
    subnets,
    nodes,
    edges,
  };
}
