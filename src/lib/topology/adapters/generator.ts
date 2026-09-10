// Generator adapter: GeneratorParams + seed -> TopologyGraph.
// Deterministic by construction (mulberry32 PRNG, fixed call order), so the same
// seed and params always produce byte-identical output. Used for scale testing
// without AWS credentials and as the source of the stress fixture.
// 결정적 생성기. 같은 시드·파라미터는 항상 같은 그래프를 낸다. 자격증명 없이 규모 테스트에 쓴다.
import {
  type BucketNotificationFact,
  type DnsRecordFact,
  type EndpointFact,
  type EventSourceFact,
  type InferInput,
  type OriginFact,
  type RoleGrantFact,
  type SgRuleFact,
  inferEdges,
} from '../infer';
import {
  type NodeKind,
  type TopologyEdge,
  type TopologyGraph,
  type TopologyNode,
  type TopologySubnet,
  type TopologyVpc,
} from '../types';

// ---- params ----

export interface GeneratorParams {
  seed: number;
  vpcs: number; // 1~4
  azsPerVpc: number; // 1~4
  subnetsPerAzPerTier: number; // 1~4
  ec2PerSubnet: [number, number]; // inclusive range, private subnets / 프라이빗 서브넷 기준 범위
  // Public subnets hold bastions and little else, so they get their own smaller
  // range instead of the private one. Defaults to [0, 2].
  // 퍼블릭 서브넷은 배스천 정도만 두므로 별도의 작은 범위를 쓴다. 기본 [0, 2].
  ec2PerPublicSubnet?: [number, number];
  albsPerVpc: number;
  natPerAz: 0 | 1;
  lambdaPerVpc: number;
  rdsPerVpc: number;
  // Counts for every other kind. VPC-scoped kinds (nlb, endpoint, elasticache,
  // msk, opensearch, eks, tgw) are spread round-robin across VPCs; account-global
  // kinds (s3, dynamodb, cloudfront, route53) are created once for the account.
  // 그 밖의 종류별 개수. VPC 귀속 종류는 VPC에 라운드로빈, 계정 전역 종류는 계정 단위로 만든다.
  extras: Partial<Record<NodeKind, number>>;
}

export interface GeneratorOptions {
  now?: Date; // injectable for deterministic output / 결정적 산출을 위한 고정 시각
  region?: string;
  accountId?: string;
}

const DEFAULT_REGION = 'ap-northeast-2';
const DEFAULT_ACCOUNT_ID = '815090125359';
// Fixed epoch so a preset regenerated tomorrow still equals today's file.
// 고정 시각. 내일 다시 만들어도 오늘 파일과 같아야 한다.
const DEFAULT_NOW = new Date('2026-01-01T00:00:00.000Z');

export const PRESETS: Record<'small' | 'medium' | 'large' | 'stress', GeneratorParams> = {
  small: {
    seed: 1,
    vpcs: 1,
    azsPerVpc: 2,
    subnetsPerAzPerTier: 1,
    ec2PerSubnet: [4, 10],
    albsPerVpc: 1,
    natPerAz: 1,
    lambdaPerVpc: 3,
    rdsPerVpc: 1,
    extras: { endpoint: 2, elasticache: 1, s3: 5, dynamodb: 3 },
  },
  medium: {
    seed: 2,
    vpcs: 1,
    azsPerVpc: 3,
    subnetsPerAzPerTier: 2,
    ec2PerSubnet: [8, 20],
    albsPerVpc: 2,
    natPerAz: 1,
    lambdaPerVpc: 8,
    rdsPerVpc: 2,
    extras: {
      nlb: 1,
      endpoint: 4,
      elasticache: 2,
      msk: 1,
      opensearch: 1,
      eks: 1,
      s3: 12,
      dynamodb: 6,
      cloudfront: 2,
      route53: 2,
    },
  },
  large: {
    seed: 3,
    vpcs: 2,
    azsPerVpc: 3,
    subnetsPerAzPerTier: 2,
    ec2PerSubnet: [20, 40],
    albsPerVpc: 3,
    natPerAz: 1,
    lambdaPerVpc: 12,
    rdsPerVpc: 3,
    extras: {
      nlb: 2,
      tgw: 2,
      endpoint: 8,
      elasticache: 4,
      msk: 2,
      opensearch: 2,
      eks: 2,
      s3: 24,
      dynamodb: 12,
      cloudfront: 4,
      route53: 3,
    },
  },
  // Success criterion of the plan: >= 1,000 EC2, >= 30 subnets, 2 VPCs.
  // 계획서 성공 기준: EC2 1,000대 이상, 서브넷 30개 이상, VPC 2개.
  stress: {
    seed: 4,
    vpcs: 2,
    azsPerVpc: 4,
    subnetsPerAzPerTier: 2,
    ec2PerSubnet: [48, 78],
    albsPerVpc: 4,
    natPerAz: 1,
    lambdaPerVpc: 20,
    rdsPerVpc: 4,
    extras: {
      nlb: 4,
      tgw: 2,
      endpoint: 12,
      elasticache: 6,
      msk: 2,
      opensearch: 2,
      eks: 2,
      s3: 40,
      dynamodb: 20,
      cloudfront: 6,
      route53: 4,
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as (keyof typeof PRESETS)[];
export const DEFAULT_PARAMS: GeneratorParams = PRESETS.medium;

// ---- PRNG ----

// mulberry32: 32-bit seed, no dependencies, identical across Node and browsers.
// 의존성 없는 32비트 PRNG. Node와 브라우저에서 결과가 같다.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(len: number): string {
    let out = '';
    for (let i = 0; i < len; i += 1) out += '0123456789abcdef'[Math.floor(this.next() * 16)];
    return out;
  }
  // AWS long-form resource id: prefix + 17 chars starting with 0 (i-0a1b…).
  // AWS 장문 리소스 ID 형식.
  awsId(prefix: string): string {
    return `${prefix}-0${this.hex(16)}`;
  }
}

// ---- vocabulary ----

const AZ_LETTERS = ['a', 'b', 'c', 'd'] as const;
const ENVS = ['prod', 'stage', 'dev', 'shared'] as const;
const APP_ROLES = ['web', 'api', 'worker', 'batch', 'search', 'stream'] as const;
const INSTANCE_TYPES = [
  'm6i.large',
  'm6i.xlarge',
  'c6i.large',
  'c6i.2xlarge',
  'r6i.large',
  't3.medium',
  't3.large',
] as const;
const RDS_ENGINES = ['aurora-mysql', 'aurora-postgresql', 'postgres', 'mysql'] as const;
const LAMBDA_RUNTIMES = ['nodejs20.x', 'python3.12', 'java21', 'provided.al2023'] as const;
const LAMBDA_VERBS = ['sync', 'ingest', 'notify', 'rotate', 'expire', 'index', 'audit', 'resize'] as const;
const LAMBDA_NOUNS = ['orders', 'catalog', 'users', 'images', 'events', 'invoices', 'sessions'] as const;
const ENDPOINT_SERVICES = [
  's3',
  'dynamodb',
  'ecr.api',
  'ecr.dkr',
  'ssm',
  'ssmmessages',
  'ec2messages',
  'logs',
  'monitoring',
  'secretsmanager',
  'kms',
  'sts',
] as const;
const BUCKET_NOUNS = ['assets', 'logs', 'backup', 'artifacts', 'reports', 'uploads', 'exports', 'tfstate'] as const;
const TABLE_NOUNS = ['orders', 'sessions', 'carts', 'inventory', 'events', 'coupons', 'reviews'] as const;
const ZONE_NAMES = ['example.com', 'internal.example.com', 'api.example.com', 'cdn.example.com'] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo;

const clampRange = (r: [number, number] | undefined, fallback: [number, number]): [number, number] => {
  const src = Array.isArray(r) && r.length === 2 ? r : fallback;
  const lo = clamp(src[0], 0, 500);
  const hi = clamp(src[1], lo, 500);
  return [lo, hi];
};

// Out-of-range params are clamped rather than rejected: the slider UI can only
// produce sane values, and a bad fixture should still render something.
// 범위를 벗어난 값은 거절하지 않고 자른다.
export function normalizeParams(p: Partial<GeneratorParams> = {}): GeneratorParams {
  const base = DEFAULT_PARAMS;
  return {
    seed: Number.isFinite(p.seed) ? (p.seed as number) >>> 0 : base.seed,
    vpcs: clamp(p.vpcs ?? base.vpcs, 1, 4),
    azsPerVpc: clamp(p.azsPerVpc ?? base.azsPerVpc, 1, AZ_LETTERS.length),
    subnetsPerAzPerTier: clamp(p.subnetsPerAzPerTier ?? base.subnetsPerAzPerTier, 1, 4),
    ec2PerSubnet: clampRange(p.ec2PerSubnet, base.ec2PerSubnet),
    ec2PerPublicSubnet: clampRange(p.ec2PerPublicSubnet, [0, 2]),
    albsPerVpc: clamp(p.albsPerVpc ?? base.albsPerVpc, 0, 12),
    natPerAz: (p.natPerAz ?? base.natPerAz) ? 1 : 0,
    lambdaPerVpc: clamp(p.lambdaPerVpc ?? base.lambdaPerVpc, 0, 200),
    rdsPerVpc: clamp(p.rdsPerVpc ?? base.rdsPerVpc, 0, 40),
    extras: { ...(p.extras ?? base.extras) },
  };
}

// ---- generation ----

interface SubnetPlan {
  subnet: TopologySubnet;
  index: number; // per-VPC ordinal, used for the /24 third octet
}

export function generateGraph(
  params: Partial<GeneratorParams> = {},
  opts: GeneratorOptions = {}
): TopologyGraph {
  const p = normalizeParams(params);
  const region = opts.region ?? DEFAULT_REGION;
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const generatedAt = (opts.now ?? DEFAULT_NOW).toISOString();
  const rng = new Rng(p.seed);

  const vpcs: TopologyVpc[] = [];
  const subnets: TopologySubnet[] = [];
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  const edgeIds = new Set<string>();
  const addEdge = (kind: TopologyEdge['kind'], from: string, to: string, label?: string) => {
    const id = `${kind}:${from}->${to}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, from, to, kind, ...(label ? { label } : {}) });
  };

  // Per-VPC bookkeeping used after the subnet pass (routes, targets, placement).
  // 서브넷 생성 이후 라우팅·타겟·배치에 쓰는 VPC별 정보.
  const perVpc: {
    vpc: TopologyVpc;
    env: string;
    azs: string[];
    publics: SubnetPlan[];
    privates: SubnetPlan[];
    igwId: string;
    natByAz: Map<string, string>;
    ec2ByRole: Map<string, string[]>;
  }[] = [];

  for (let v = 0; v < p.vpcs; v += 1) {
    const env = ENVS[v % ENVS.length];
    const octet = 10 + v;
    const vpcId = rng.awsId('vpc');
    const vpc: TopologyVpc = { id: vpcId, name: `${env}-vpc`, cidr: `10.${octet}.0.0/16` };
    vpcs.push(vpc);

    const azs = AZ_LETTERS.slice(0, p.azsPerVpc).map((l) => `${region}${l}`);
    const publics: SubnetPlan[] = [];
    const privates: SubnetPlan[] = [];
    let subnetIndex = 0;

    // Public subnets first so their /24s sit at the front of the VPC range, the
    // way most hand-built VPCs look.
    // 손으로 만든 VPC처럼 퍼블릭 /24를 앞쪽에 배치한다.
    (['public', 'private'] as const).forEach((tier) => {
      azs.forEach((az, aIdx) => {
        for (let s = 0; s < p.subnetsPerAzPerTier; s += 1) {
          const idx = subnetIndex;
          subnetIndex += 1;
          const plan: SubnetPlan = {
            index: idx,
            subnet: {
              id: rng.awsId('subnet'),
              vpcId,
              az,
              cidr: `10.${octet}.${idx}.0/24`,
              tier,
              name: `${env}-${tier}-${AZ_LETTERS[aIdx]}-${pad2(s + 1)}`,
            },
          };
          subnets.push(plan.subnet);
          (tier === 'public' ? publics : privates).push(plan);
        }
      });
    });

    const igwId = rng.awsId('igw');
    perVpc.push({
      vpc,
      env,
      azs,
      publics,
      privates,
      igwId,
      natByAz: new Map(),
      ec2ByRole: new Map(),
    });
  }

  const vpcOctet = (i: number) => 10 + i;

  // ---- gateways ----
  perVpc.forEach((V) => {
    nodes.push({ id: V.igwId, kind: 'igw', name: `${V.env}-igw`, vpcId: V.vpc.id, meta: {} });
    addEdge('attach', V.igwId, V.vpc.id);

    if (p.natPerAz) {
      V.azs.forEach((az, aIdx) => {
        const host = V.publics.find((s) => s.subnet.az === az);
        if (!host) return;
        const natId = rng.awsId('nat');
        V.natByAz.set(az, natId);
        nodes.push({
          id: natId,
          kind: 'nat',
          name: `${V.env}-nat-${AZ_LETTERS[aIdx]}`,
          vpcId: V.vpc.id,
          subnetId: host.subnet.id,
          az,
          state: 'available',
          meta: {},
        });
        addEdge('egress', natId, V.igwId);
      });
    }
  });

  // ---- EC2 ----
  perVpc.forEach((V, vIdx) => {
    const octet = vpcOctet(vIdx);
    let ordinal = 0;
    const place = (plan: SubnetPlan, count: number, roles: readonly string[]) => {
      const role = rng.pick(roles);
      const type = rng.pick(INSTANCE_TYPES);
      for (let i = 0; i < count; i += 1) {
        ordinal += 1;
        const id = rng.awsId('i');
        const nameTag = `${V.env}-${role}-${pad2(ordinal)}`;
        // A small share of stopped instances keeps the state colouring honest.
        // 일부는 stopped로 두어 상태별 색 구분이 드러나게 한다.
        const state = rng.chance(0.06) ? 'stopped' : 'running';
        const host = 4 + (i % 250);
        nodes.push({
          id,
          kind: 'ec2',
          name: nameTag,
          vpcId: V.vpc.id,
          subnetId: plan.subnet.id,
          az: plan.subnet.az,
          state,
          meta: {
            nameTag,
            instanceType: type,
            privateIp: `10.${octet}.${plan.index}.${host}`,
            publicIp: plan.subnet.tier === 'public' && state === 'running' ? `52.${rng.int(64, 95)}.${rng.int(0, 255)}.${rng.int(1, 254)}` : null,
            eksCluster: null,
          },
        });
        V.ec2ByRole.set(role, [...(V.ec2ByRole.get(role) || []), id]);
      }
    };
    V.publics.forEach((plan) => place(plan, rng.int(p.ec2PerPublicSubnet![0], p.ec2PerPublicSubnet![1]), ['bastion']));
    V.privates.forEach((plan) => place(plan, rng.int(p.ec2PerSubnet[0], p.ec2PerSubnet[1]), APP_ROLES));
  });

  // ---- routes: public -> igw, private -> NAT in the same AZ ----
  perVpc.forEach((V) => {
    V.publics.forEach((plan) => addEdge('route', plan.subnet.id, V.igwId, '0.0.0.0/0'));
    V.privates.forEach((plan) => {
      const nat = V.natByAz.get(plan.subnet.az) ?? Array.from(V.natByAz.values())[0];
      if (nat) addEdge('route', plan.subnet.id, nat, '0.0.0.0/0');
    });
  });

  // ---- load balancers ----
  const lbTargets = (V: (typeof perVpc)[number], role: string): string[] => {
    const pool = V.ec2ByRole.get(role) || Array.from(V.ec2ByRole.values()).flat();
    return pool.slice(0, 60);
  };
  perVpc.forEach((V) => {
    for (let i = 0; i < p.albsPerVpc; i += 1) {
      const role = APP_ROLES[i % APP_ROLES.length];
      const name = `${V.env}-${role}-alb`;
      const id = `alb:${name}`;
      const scheme = i === 0 ? 'internet-facing' : 'internal';
      nodes.push({
        id,
        kind: 'alb',
        name,
        vpcId: V.vpc.id,
        meta: {
          arn: `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/app/${name}/${rng.hex(16)}`,
          scheme,
          dnsName: `${name}-${rng.int(100000000, 999999999)}.${region}.elb.amazonaws.com`,
          availabilityZones: V.azs,
          securityGroups: [rng.awsId('sg')],
        },
      });
      lbTargets(V, role).forEach((iid) => addEdge('target', id, iid));
    }
  });

  // ---- extras ----
  const extraCount = (k: NodeKind): number => clamp(p.extras[k] ?? 0, 0, 500);
  const vpcAt = (i: number) => perVpc[i % perVpc.length];

  for (let i = 0; i < extraCount('nlb'); i += 1) {
    const V = vpcAt(i);
    const name = `${V.env}-nlb-${pad2(i + 1)}`;
    const id = `nlb:${name}`;
    nodes.push({
      id,
      kind: 'nlb',
      name,
      vpcId: V.vpc.id,
      meta: {
        arn: `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/net/${name}/${rng.hex(16)}`,
        scheme: 'internal',
        dnsName: `${name}-${rng.hex(16)}.elb.${region}.amazonaws.com`,
        availabilityZones: V.azs,
        securityGroups: null,
      },
    });
    lbTargets(V, rng.pick(APP_ROLES)).slice(0, 20).forEach((iid) => addEdge('target', id, iid));
  }

  for (let i = 0; i < extraCount('tgw'); i += 1) {
    const V = vpcAt(i);
    const id = rng.awsId('tgw-attach');
    const tgwId = rng.awsId('tgw');
    nodes.push({
      id,
      kind: 'tgw',
      name: `${V.env}-tgw-attach`,
      vpcId: V.vpc.id,
      state: 'available',
      meta: { transitGatewayId: tgwId, resourceType: 'vpc' },
    });
    addEdge('attach', id, V.vpc.id);
    // The private subnets route their inter-VPC traffic through the attachment.
    // 프라이빗 서브넷은 VPC 간 트래픽을 이 어태치먼트로 보낸다.
    V.privates.forEach((plan) => addEdge('route', plan.subnet.id, id, '10.0.0.0/8'));
  }

  for (let i = 0; i < extraCount('endpoint'); i += 1) {
    const V = vpcAt(i);
    const service = ENDPOINT_SERVICES[i % ENDPOINT_SERVICES.length];
    const serviceName = `com.amazonaws.${region}.${service}`;
    nodes.push({
      id: rng.awsId('vpce'),
      kind: 'endpoint',
      name: service,
      vpcId: V.vpc.id,
      meta: {
        serviceName,
        endpointType: service === 's3' || service === 'dynamodb' ? 'Gateway' : 'Interface',
      },
    });
  }

  perVpc.forEach((V) => {
    for (let i = 0; i < p.rdsPerVpc; i += 1) {
      const engine = rng.pick(RDS_ENGINES);
      const name = `${V.env}-${engine.replace('aurora-', '')}-${pad2(i + 1)}`;
      nodes.push({
        id: `rds:${name}`,
        kind: 'rds',
        name,
        vpcId: V.vpc.id,
        az: rng.pick(V.azs),
        meta: {
          engine,
          instanceClass: rng.pick(['db.r6g.large', 'db.r6g.xlarge', 'db.t4g.medium']),
          endpoint: `${name}.${rng.hex(12)}.${region}.rds.amazonaws.com`,
        },
      });
    }
  });

  for (let i = 0; i < extraCount('elasticache'); i += 1) {
    const V = vpcAt(i);
    const name = `${V.env}-redis-${pad2(i + 1)}`;
    nodes.push({
      id: `elasticache:${name}`,
      kind: 'elasticache',
      name,
      vpcId: V.vpc.id,
      az: rng.pick(V.azs),
      meta: { engine: 'redis' },
    });
  }

  // MSK and OpenSearch span AZs: az/subnetId stay empty, placement goes in meta.
  // MSK·OpenSearch는 다중 AZ라 az/subnetId를 비우고 meta에 배치를 담는다.
  const spanning = (V: (typeof perVpc)[number]) => {
    const picked = V.privates.slice(0, Math.min(3, V.privates.length));
    return { subnetIds: picked.map((s) => s.subnet.id), azs: Array.from(new Set(picked.map((s) => s.subnet.az))).sort() };
  };
  for (let i = 0; i < extraCount('msk'); i += 1) {
    const V = vpcAt(i);
    const name = `${V.env}-kafka-${pad2(i + 1)}`;
    nodes.push({ id: `msk:${name}`, kind: 'msk', name, vpcId: V.vpc.id, state: 'ACTIVE', meta: spanning(V) });
  }
  for (let i = 0; i < extraCount('opensearch'); i += 1) {
    const V = vpcAt(i);
    const name = `${V.env}-search-${pad2(i + 1)}`;
    nodes.push({
      id: `opensearch:${name}`,
      kind: 'opensearch',
      name,
      vpcId: V.vpc.id,
      meta: { ...spanning(V), engineVersion: 'OpenSearch_2.13' },
    });
  }

  // EKS clusters are markers derived from instance tags in the live adapter, so
  // here we tag a slice of the VPC's instances and add the matching marker node.
  // Live 어댑터가 인스턴스 태그에서 EKS를 뽑으므로, 여기서도 인스턴스에 태그를 달고 마커를 만든다.
  const ec2ById = new Map(nodes.filter((n) => n.kind === 'ec2').map((n) => [n.id, n]));
  for (let i = 0; i < extraCount('eks'); i += 1) {
    const V = vpcAt(i);
    const cluster = `${V.env}-eks-${pad2(i + 1)}`;
    nodes.push({ id: `eks:${cluster}`, kind: 'eks', name: cluster, vpcId: V.vpc.id, meta: {} });
    const workers = (V.ec2ByRole.get('worker') || []).slice(0, 40);
    workers.forEach((iid) => {
      const n = ec2ById.get(iid);
      if (n) n.meta.eksCluster = cluster;
    });
  }

  perVpc.forEach((V) => {
    for (let i = 0; i < p.lambdaPerVpc; i += 1) {
      const name = `${V.env}-${rng.pick(LAMBDA_VERBS)}-${rng.pick(LAMBDA_NOUNS)}-${pad2(i + 1)}`;
      const host = V.privates.length ? V.privates[i % V.privates.length] : null;
      nodes.push({
        id: `lambda:${name}`,
        kind: 'lambda',
        name,
        vpcId: V.vpc.id,
        subnetId: host?.subnet.id,
        az: host?.subnet.az,
        meta: {
          runtime: rng.pick(LAMBDA_RUNTIMES),
          subnetIds: host ? [host.subnet.id] : [],
        },
      });
    }
  });

  // ---- account-global kinds ----
  const suffix = rng.hex(6);
  for (let i = 0; i < extraCount('s3'); i += 1) {
    const name = `${ENVS[i % ENVS.length]}-${BUCKET_NOUNS[i % BUCKET_NOUNS.length]}-${suffix}-${pad2(i + 1)}`;
    nodes.push({
      id: `s3:${name}`,
      kind: 's3',
      name,
      meta: { region, domain: `${name}.s3.${region}.amazonaws.com` },
    });
  }
  for (let i = 0; i < extraCount('dynamodb'); i += 1) {
    const name = `${ENVS[i % ENVS.length]}-${TABLE_NOUNS[i % TABLE_NOUNS.length]}-${pad2(i + 1)}`;
    nodes.push({ id: `dynamodb:${name}`, kind: 'dynamodb', name, meta: {} });
  }
  for (let i = 0; i < extraCount('cloudfront'); i += 1) {
    const distId = `E${rng.hex(12).toUpperCase()}`;
    const alias = `cdn${pad2(i + 1)}.example.com`;
    nodes.push({
      id: `cloudfront:${distId}`,
      kind: 'cloudfront',
      name: alias,
      meta: { distributionId: distId, domainName: `d${rng.hex(13)}.cloudfront.net`, aliases: [alias] },
    });
  }
  for (let i = 0; i < extraCount('route53'); i += 1) {
    const zone = ZONE_NAMES[i % ZONE_NAMES.length];
    const name = i < ZONE_NAMES.length ? zone : `z${pad2(i + 1)}.${zone}`;
    nodes.push({
      id: `route53:${name}.`,
      kind: 'route53',
      name,
      meta: { privateZone: name.startsWith('internal') },
    });
  }

  // ---- inferred-flow configuration (Phase 4.6, ADR-014) ----
  // Synthesised as the very same facts the live adapter derives from Steampipe
  // rows, then run through the shared inferEdges rules — so a bug in a rule shows
  // up in both sources and the generator can never drift from live semantics.
  // Every rng call below comes AFTER the existing ones, so ids and names above
  // are byte-identical to the pre-4.6 generator (fixture determinism).
  // 라이브 어댑터가 만드는 것과 같은 사실을 합성해 같은 규칙에 통과시킨다. 새 난수 호출은 전부
  // 기존 호출 뒤에 붙으므로 위쪽 ID·이름은 그대로다.
  const infer = buildInferFacts({ p, rng, region, accountId, perVpc, nodes, subnets });
  const inferred = inferEdges(infer, {
    meta: { source: 'generator', accountId, generatedAt, seed: p.seed },
    vpcs,
    subnets,
    nodes,
    edges,
  });
  inferred.forEach((e) => {
    if (edgeIds.has(e.id)) return;
    edgeIds.add(e.id);
    edges.push(e);
  });

  return {
    meta: { source: 'generator', accountId, generatedAt, seed: p.seed },
    vpcs,
    subnets,
    nodes,
    edges,
  };
}

export const generateFromPreset = (
  name: keyof typeof PRESETS,
  opts: GeneratorOptions = {}
): TopologyGraph => generateGraph(PRESETS[name], opts);

// ---- inferred-flow fact synthesis (ADR-014) ----

// Security-group tiers of a synthetic VPC. One group per app role keeps the
// SG-to-SG cross products the size a real account produces (a rule between two
// groups permits every member pair) instead of "every instance talks to
// everything".
// VPC 하나의 보안그룹 계층. 앱 역할마다 그룹을 따로 두어 SG 간 규칙의 교차곱이 실제 계정 수준에
// 머물게 한다.
interface VpcSecurityGroups {
  albSg: string; // internet-facing load balancers / 인터넷 향 LB
  bastionSg: string; // public-subnet EC2 / 퍼블릭 서브넷 EC2
  lbSg: string; // internal load balancers / 내부 LB
  lambdaSg: string;
  dataSg: string; // rds + elasticache
  mskSg: string;
  searchSg: string; // opensearch
  roleSg: Map<string, string>; // app role -> sg / 앱 역할별 SG
}

// Roles that reach the data tier and sit behind the internal load balancer.
// 데이터 계층에 닿고 내부 LB 뒤에 서는 역할.
const DATA_CLIENT_ROLES = ['api', 'worker'] as const;
const LB_CLIENT_ROLES = ['api'] as const;
const PROFILE_SUBNET_SHARE = 0.4; // private subnets whose instances carry a role
const LAMBDA_S3_TRIGGER_SHARE = 0.3;
const LAMBDA_STREAM_TRIGGER_SHARE = 0.1;
const LAMBDA_WILDCARD_SHARE = 0.15; // roles with Resource "*" — badge, never a line

interface FactContext {
  p: GeneratorParams;
  rng: Rng;
  region: string;
  accountId: string;
  perVpc: {
    vpc: TopologyVpc;
    env: string;
    azs: string[];
    publics: { subnet: TopologySubnet; index: number }[];
    privates: { subnet: TopologySubnet; index: number }[];
    igwId: string;
    natByAz: Map<string, string>;
    ec2ByRole: Map<string, string[]>;
  }[];
  nodes: TopologyNode[];
  subnets: TopologySubnet[];
}

function buildInferFacts(ctx: FactContext): InferInput {
  const { rng, region, accountId, perVpc, nodes } = ctx;
  const securityGroupRules: SgRuleFact[] = [];
  const roleGrants: RoleGrantFact[] = [];
  const endpoints: EndpointFact[] = [];
  const routeTableSubnets: Record<string, string[]> = {};
  const eventSources: EventSourceFact[] = [];
  const bucketNotifications: BucketNotificationFact[] = [];
  const origins: OriginFact[] = [];
  const dnsRecords: DnsRecordFact[] = [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ofKind = (kind: NodeKind, vpcId?: string): TopologyNode[] =>
    nodes.filter((n) => n.kind === kind && (vpcId === undefined || n.vpcId === vpcId));
  const buckets = ofKind('s3');
  const tables = ofKind('dynamodb');

  const ingress = (
    groupId: string,
    source: { referencedGroupId?: string; cidrIpv4?: string },
    port: number | 'all',
    protocol = 'tcp'
  ) => {
    securityGroupRules.push({
      groupId,
      isEgress: false,
      referencedGroupId: source.referencedGroupId ?? null,
      cidrIpv4: source.cidrIpv4 ?? null,
      fromPort: port === 'all' ? -1 : port,
      toPort: port === 'all' ? -1 : port,
      ipProtocol: port === 'all' ? '-1' : protocol,
    });
  };

  perVpc.forEach((V) => {
    const sgs: VpcSecurityGroups = {
      albSg: rng.awsId('sg'),
      bastionSg: rng.awsId('sg'),
      lbSg: rng.awsId('sg'),
      lambdaSg: rng.awsId('sg'),
      dataSg: rng.awsId('sg'),
      mskSg: rng.awsId('sg'),
      searchSg: rng.awsId('sg'),
      roleSg: new Map(APP_ROLES.map((r) => [r, rng.awsId('sg')])),
    };

    // -- membership: which resource sits behind which group --
    ofKind('alb', V.vpc.id).forEach((n) => {
      n.meta.securityGroups = [n.meta.scheme === 'internet-facing' ? sgs.albSg : sgs.lbSg];
    });
    ofKind('nlb', V.vpc.id).forEach((n) => {
      n.meta.securityGroups = [sgs.lbSg];
    });
    (V.ec2ByRole.get('bastion') ?? []).forEach((id) => {
      const n = byId.get(id);
      if (n) n.meta.securityGroups = [sgs.bastionSg];
    });
    APP_ROLES.forEach((role) => {
      const sg = sgs.roleSg.get(role)!;
      (V.ec2ByRole.get(role) ?? []).forEach((id) => {
        const n = byId.get(id);
        if (n) n.meta.securityGroups = [sg];
      });
    });
    [...ofKind('rds', V.vpc.id), ...ofKind('elasticache', V.vpc.id)].forEach((n) => {
      n.meta.securityGroups = [sgs.dataSg];
    });
    ofKind('msk', V.vpc.id).forEach((n) => {
      n.meta.securityGroups = [sgs.mskSg];
    });
    ofKind('opensearch', V.vpc.id).forEach((n) => {
      n.meta.securityGroups = [sgs.searchSg];
    });
    const lambdas = ofKind('lambda', V.vpc.id);
    lambdas.forEach((n) => {
      n.meta.securityGroups = [sgs.lambdaSg];
    });

    // -- rules: the request path, tier by tier --
    // internet → public tier
    ingress(sgs.albSg, { cidrIpv4: '0.0.0.0/0' }, 443);
    ingress(sgs.albSg, { cidrIpv4: '0.0.0.0/0' }, 80);
    ingress(sgs.bastionSg, { cidrIpv4: '0.0.0.0/0' }, 22);
    // public ALB → web tier → internal LB → app tier
    const webSg = sgs.roleSg.get('web')!;
    ingress(webSg, { referencedGroupId: sgs.albSg }, 80);
    ingress(sgs.lbSg, { referencedGroupId: webSg }, 8080);
    LB_CLIENT_ROLES.forEach((role) => ingress(sgs.roleSg.get(role)!, { referencedGroupId: sgs.lbSg }, 8080));
    // app tier → data tier
    DATA_CLIENT_ROLES.forEach((role) => {
      ingress(sgs.dataSg, { referencedGroupId: sgs.roleSg.get(role)! }, 3306);
      ingress(sgs.dataSg, { referencedGroupId: sgs.roleSg.get(role)! }, 6379);
    });
    // The API tier also publishes to Kafka and queries OpenSearch, which keeps
    // those two reachable from the front door instead of stranded.
    // API 계층도 Kafka·OpenSearch를 쓴다. 그래야 앞단에서 이어진다.
    ['stream', 'api'].forEach((role) => ingress(sgs.mskSg, { referencedGroupId: sgs.roleSg.get(role)! }, 9092));
    ['search', 'api'].forEach((role) => ingress(sgs.searchSg, { referencedGroupId: sgs.roleSg.get(role)! }, 443));
    ingress(sgs.dataSg, { referencedGroupId: sgs.lambdaSg }, 3306);
    // A CIDR rule that covers the whole VPC folds onto the VPC anchor…
    ingress(sgs.dataSg, { cidrIpv4: V.vpc.cidr }, 5432);
    // …while one covering a single subnet anchors on that subnet (admin SSH).
    const bastionSubnet = V.publics[0]?.subnet;
    if (bastionSubnet) {
      LB_CLIENT_ROLES.forEach((role) =>
        ingress(sgs.roleSg.get(role)!, { cidrIpv4: bastionSubnet.cidr }, 22)
      );
    }

    // -- IAM: instance profiles on a share of the private subnets --
    const roleOfEc2 = new Map<string, string>();
    APP_ROLES.forEach((role) => (V.ec2ByRole.get(role) ?? []).forEach((id) => roleOfEc2.set(id, role)));
    const grantsByRoleArn = new Map<string, RoleGrantFact>();
    V.privates.forEach((plan) => {
      if (!rng.chance(PROFILE_SUBNET_SHARE)) return;
      const inside = nodes.filter((n) => n.kind === 'ec2' && n.subnetId === plan.subnet.id);
      if (!inside.length) return;
      const role = roleOfEc2.get(inside[0].id) ?? 'app';
      const roleArn = `arn:aws:iam::${accountId}:role/${V.env}-${role}-instance-role`;
      if (!grantsByRoleArn.has(roleArn)) {
        const picked = buckets.length
          ? Array.from(new Set([rng.pick(buckets).id, ...(rng.chance(0.5) ? [rng.pick(buckets).id] : [])]))
          : [];
        const table = tables.length && rng.chance(0.5) ? rng.pick(tables).id : null;
        const grant: RoleGrantFact = {
          roleArn,
          actions: ['s3:GetObject', 's3:PutObject', ...(table ? ['dynamodb:GetItem', 'dynamodb:Query'] : [])],
          resources: [
            ...picked.map((id) => `arn:aws:s3:::${id.slice(3)}/*`),
            ...(table ? [`arn:aws:dynamodb:${region}:${accountId}:table/${table.slice('dynamodb:'.length)}`] : []),
          ],
        };
        grantsByRoleArn.set(roleArn, grant);
        roleGrants.push(grant);
      }
      inside.forEach((n) => {
        n.meta.roleArn = roleArn;
      });
    });

    // -- Lambda roles and event sources --
    lambdas.forEach((fn) => {
      const fnName = fn.name;
      const roleArn = `arn:aws:iam::${accountId}:role/${fnName}-role`;
      fn.meta.roleArn = roleArn;
      const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${fnName}`;
      if (rng.chance(LAMBDA_WILDCARD_SHARE)) {
        // "Resource": "*" reaches every bucket in the account. That is a badge on
        // the node, never a line (ADR-014); inferEdges drops the wildcard itself.
        // 와일드카드는 노드 배지로만 남는다.
        fn.meta.iamWildcard = true;
        roleGrants.push({ roleArn, actions: ['s3:*'], resources: ['*'] });
      } else if (buckets.length) {
        roleGrants.push({
          roleArn,
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${rng.pick(buckets).id.slice(3)}/*`],
        });
      }
      if (buckets.length && rng.chance(LAMBDA_S3_TRIGGER_SHARE)) {
        const bucket = rng.pick(buckets).id.slice(3);
        const hit = bucketNotifications.find((b) => b.bucket === bucket);
        if (hit) hit.functionArns.push(functionArn);
        else bucketNotifications.push({ bucket, functionArns: [functionArn] });
      }
      if (tables.length && rng.chance(LAMBDA_STREAM_TRIGGER_SHARE)) {
        const table = rng.pick(tables).id.slice('dynamodb:'.length);
        eventSources.push({
          sourceArn: `arn:aws:dynamodb:${region}:${accountId}:table/${table}/stream/2026-01-01T00:00:00.000`,
          functionArn,
          enabled: rng.chance(0.85),
        });
      }
    });

    // -- VPC endpoints: gateway through route tables, interface through ENIs --
    const privateSubnetIds = V.privates.map((plan) => plan.subnet.id);
    const privateRtb = rng.awsId('rtb');
    routeTableSubnets[privateRtb] = privateSubnetIds;
    ofKind('endpoint', V.vpc.id).forEach((ep) => {
      const gateway = ep.meta.endpointType === 'Gateway';
      endpoints.push({
        endpointId: ep.id,
        serviceName: String(ep.meta.serviceName ?? ''),
        endpointType: gateway ? 'Gateway' : 'Interface',
        ...(gateway ? { routeTableIds: [privateRtb] } : { subnetIds: privateSubnetIds }),
      });
      if (gateway) ep.meta.routeTableIds = [privateRtb];
      else ep.meta.subnetIds = privateSubnetIds;
    });
  });

  // -- CloudFront origins and Route 53 records (account-global) --
  const publicAlbs = nodes.filter((n) => n.kind === 'alb' && n.meta.scheme === 'internet-facing');
  const staticBuckets = nodes.filter((n) => n.kind === 's3' && /assets|uploads/.test(n.name));
  const dists = nodes.filter((n) => n.kind === 'cloudfront');
  dists.forEach((d, i) => {
    const domains: string[] = [];
    const alb = publicAlbs[i % Math.max(1, publicAlbs.length)];
    if (alb && typeof alb.meta.dnsName === 'string') domains.push(alb.meta.dnsName);
    const bucket = staticBuckets[i % Math.max(1, staticBuckets.length)];
    if (bucket && typeof bucket.meta.domain === 'string') domains.push(bucket.meta.domain);
    if (domains.length) origins.push({ distributionId: String(d.meta.distributionId ?? ''), domains });
  });

  nodes
    .filter((n) => n.kind === 'route53' && !n.meta.privateZone)
    .forEach((zone, i) => {
      const targets: string[] = [];
      const dist = dists[i % Math.max(1, dists.length)];
      if (dist && typeof dist.meta.domainName === 'string') targets.push(dist.meta.domainName);
      const alb = publicAlbs[i % Math.max(1, publicAlbs.length)];
      if (alb && typeof alb.meta.dnsName === 'string') targets.push(alb.meta.dnsName);
      if (targets.length) dnsRecords.push({ zoneName: zone.name, type: 'A', targets });
      zone.meta.records = targets.length;
    });

  return {
    securityGroupRules,
    roleGrants,
    endpoints,
    routeTableSubnets,
    eventSources,
    bucketNotifications,
    origins,
    dnsRecords,
  };
}
