// FossFLOW isometric model generator.
// TS port of dac-poc/generate_fossflow.py — builds a FossFLOW-importable
// model JSON from a TopologyGraph (src/lib/topology/types.ts). Steampipe rows
// are turned into that graph by src/lib/topology/adapters/live.ts; this file no
// longer knows any column names. Layout is computed on a logical tile grid
// (x = column, y = row) that FossFLOW renders rotated 45 degrees.
// TopologyGraph만 입력으로 받는다. Steampipe 컬럼은 어댑터가 처리한다.
import { fossflowIcons } from './icons';
import type { TopologyGraph, TopologyNode, TopologySubnet } from '@/lib/topology/types';

interface Row {
  [key: string]: any;
}

// Layer toggles the topology chat can flip. VPC-scoped layers default to
// visible; account-global tray layers (S3/DynamoDB/CloudFront/Route53)
// default to hidden.
// 채팅이 제어하는 레이어 토글 — VPC 귀속 레이어는 기본 표시,
// 계정 전역 트레이 레이어는 기본 숨김.
export interface TopologyOptions {
  includeEmpty?: boolean;
  showIgw?: boolean;
  showTgw?: boolean;
  showRds?: boolean;
  showEgress?: boolean;
  showEks?: boolean;
  showElasticache?: boolean;
  showMsk?: boolean;
  showOpensearch?: boolean;
  showLambda?: boolean;
  showEndpoints?: boolean;
  showS3?: boolean;
  showDynamodb?: boolean;
  showCloudfront?: boolean;
  showRoute53?: boolean;
}

export interface FossflowModel {
  title: string;
  description: string;
  icons: typeof fossflowIcons;
  colors: { id: string; value: string }[];
  items: Row[];
  views: Row[];
  fitToScreen: boolean;
}

// Icons every SP tiles; label boxes span ~2 tiles, so SP=4 plus alternating
// labelHeight keeps neighboring labels from colliding.
const SP = 4;
const COLS = 3;
const GAP_SUBNET = 2;
const GAP_AZ = 3;
const LABEL_LOW = 60;
const LABEL_HIGH = 140;
const VPC_PAD = 2;

const COLORS = [
  { id: 'col-vpc', value: '#ede9fe' },
  { id: 'col-pub', value: '#dcedc8' },
  { id: 'col-prv', value: '#d0e7f5' },
  { id: 'col-alb', value: '#e2d9f3' },
  { id: 'col-eks', value: '#fcd9a8' },
  { id: 'col-ext', value: '#e7e7ee' },
  { id: 'col-edge', value: '#2563eb' },
  { id: 'col-egress', value: '#9ca3af' },
];

function shortId(rid: string | null | undefined): string {
  const s = rid || 'unknown';
  const idx = s.indexOf('-');
  return idx > 0 ? `${s.slice(0, idx)}-${s.slice(idx + 1, idx + 7)}` : s;
}

const metaStr = (n: TopologyNode, key: string): string => {
  const v = n.meta[key];
  return typeof v === 'string' ? v : '';
};
const metaList = (n: TopologyNode, key: string): string[] => {
  const v = n.meta[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

export function listVpcs(graph: TopologyGraph): TopologyGraph['vpcs'] {
  return graph.vpcs;
}

export function buildFossflowModel(
  graph: TopologyGraph,
  vpcFilter: string,
  opts: TopologyOptions = {}
): FossflowModel | null {
  const show = {
    igw: opts.showIgw !== false,
    tgw: opts.showTgw !== false,
    rds: opts.showRds !== false,
    egress: opts.showEgress !== false,
    eks: opts.showEks !== false,
    elasticache: opts.showElasticache !== false,
    msk: opts.showMsk !== false,
    opensearch: opts.showOpensearch !== false,
    lambda: opts.showLambda !== false,
    endpoints: opts.showEndpoints !== false,
    // account-global tray layers: opt-in
    s3: opts.showS3 === true,
    dynamodb: opts.showDynamodb === true,
    cloudfront: opts.showCloudfront === true,
    route53: opts.showRoute53 === true,
  };
  const vpc = graph.vpcs.find((v) => v.id === vpcFilter || v.name === vpcFilter);
  if (!vpc) return null;
  const vpcId = vpc.id;
  const vpcName = vpc.name;
  const vpcCidr = vpc.cidr;

  const inVpc = graph.nodes.filter((n) => n.vpcId === vpcId);
  const ofKind = (...kinds: TopologyNode['kind'][]) => inVpc.filter((n) => kinds.includes(n.kind));
  const globalOfKind = (kind: TopologyNode['kind']) =>
    graph.nodes.filter((n) => n.vpcId === undefined && n.kind === kind);

  const vEc2 = ofKind('ec2');
  const vElb = ofKind('alb', 'nlb');
  const vNat = ofKind('nat');
  const vIgw = show.igw ? ofKind('igw') : [];
  const vTgw = show.tgw ? ofKind('tgw') : [];
  const vRds = show.rds ? ofKind('rds') : [];
  const vCache = show.elasticache ? ofKind('elasticache') : [];
  const vLambda = show.lambda ? ofKind('lambda') : [];
  const vEndpoints = show.endpoints ? ofKind('endpoint') : [];
  const vSubnets = graph.subnets.filter((s) => s.vpcId === vpcId);

  const azSuffix = (az: string) => (az ? az.split('-').pop() : '?');
  const natLabel = (n: TopologyNode) =>
    vNat.length > 1 ? `NAT GW (${azSuffix(n.az || '')})` : 'NAT GW';

  // ---- subnet grid (AZ x tier) ----
  const groupBySubnet = (list: TopologyNode[]) => {
    const m = new Map<string, TopologyNode[]>();
    list.forEach((n) => {
      if (!n.subnetId) return;
      if (!m.has(n.subnetId)) m.set(n.subnetId, []);
      m.get(n.subnetId)!.push(n);
    });
    return m;
  };
  const ec2InSubnet = groupBySubnet(vEc2);
  const natInSubnet = groupBySubnet(vNat);
  // VPC Lambdas live inside their subnets (capped per subnet to keep boxes sane)
  // VPC 람다는 소속 서브넷 안에 배치 (서브넷당 상한)
  const LAMBDA_CAP = 6;
  const lambdaInSubnet = groupBySubnet(vLambda);

  const grid = new Map<string, { public: TopologySubnet[]; private: TopologySubnet[] }>();
  [...vSubnets]
    .sort((a, b) => `${a.az}${a.id}`.localeCompare(`${b.az}${b.id}`))
    .forEach((s) => {
      const sid = s.id;
      if (
        !ec2InSubnet.get(sid)?.length &&
        !natInSubnet.get(sid)?.length &&
        !lambdaInSubnet.get(sid)?.length &&
        !opts.includeEmpty
      )
        return;
      const az = s.az || 'unknown';
      if (!grid.has(az)) grid.set(az, { public: [], private: [] });
      grid.get(az)![s.tier].push(s);
    });
  // Managed data services join their AZ column as dedicated boxes.
  // AZ 귀속 매니지드 서비스는 AZ 칼럼에 전용 박스로 배치.
  interface ServiceEntry {
    id: string;
    name: string;
    icon: string;
    desc: string;
  }
  const serviceBoxesByAz = new Map<string, Map<string, ServiceEntry[]>>();
  const addServiceEntry = (az: string, boxLabel: string, entry: ServiceEntry) => {
    if (!serviceBoxesByAz.has(az)) serviceBoxesByAz.set(az, new Map());
    const boxes = serviceBoxesByAz.get(az)!;
    if (!boxes.has(boxLabel)) boxes.set(boxLabel, []);
    if (!boxes.get(boxLabel)!.some((e) => e.id === entry.id)) boxes.get(boxLabel)!.push(entry);
    if (!grid.has(az)) grid.set(az, { public: [], private: [] });
  };
  vRds.forEach((n) =>
    addServiceEntry(n.az || 'unknown', 'RDS', {
      id: `rds-${n.name}`,
      name: n.name,
      icon: 'aws-rds',
      desc: metaStr(n, 'engine'),
    })
  );
  vCache.forEach((n) =>
    addServiceEntry(n.az || 'unknown', 'ElastiCache', {
      id: `cache-${n.name}`,
      name: n.name,
      icon: 'aws-elasticache',
      desc: metaStr(n, 'engine'),
    })
  );
  if (show.msk) {
    ofKind('msk').forEach((n) => {
      metaList(n, 'azs').forEach((az) =>
        addServiceEntry(az, 'MSK', {
          id: `msk-${n.name}-${az}`,
          name: n.name,
          icon: 'aws-managed-streaming-for-apache-kafka',
          desc: n.state || '',
        })
      );
    });
  }
  if (show.opensearch) {
    ofKind('opensearch').forEach((n) => {
      metaList(n, 'azs').forEach((az) =>
        addServiceEntry(az, 'OpenSearch', {
          id: `os-${n.name}-${az}`,
          name: n.name,
          icon: 'aws-opensearch-service',
          desc: metaStr(n, 'engineVersion'),
        })
      );
    });
  }

  const azs = Array.from(grid.keys()).sort();

  const subnetLabel = (s: TopologySubnet) => {
    const leaf = s.name.split('/').pop();
    return `${leaf} (${s.cidr})`;
  };

  // ---- ALB targets come from the graph's target edges ----
  const targetsOf = new Map<string, string[]>();
  graph.edges.forEach((e) => {
    if (e.kind !== 'target') return;
    if (!targetsOf.has(e.from)) targetsOf.set(e.from, []);
    targetsOf.get(e.from)!.push(e.to);
  });
  const resolveTargets = (lbId: string): string[] => [...(targetsOf.get(lbId) || [])].sort();

  // ---- assemble model pieces ----
  const modelItems: Row[] = [];
  const viewItems: Row[] = [];
  const connectors: Row[] = [];
  const rectangles: Row[] = [];
  const textBoxes: Row[] = [];
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${++seq}`;

  const addNode = (id: string, name: string, icon: string, x: number, y: number, desc = '', labelH?: number) => {
    modelItems.push({ id, name, icon, ...(desc ? { description: desc } : {}) });
    viewItems.push({ id, tile: { x, y }, ...(labelH ? { labelHeight: labelH } : {}) });
  };
  const addRect = (x1: number, y1: number, x2: number, y2: number, color: string) =>
    rectangles.push({ id: uid('rect'), color, from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  const addText = (x: number, y: number, content: string, fontSize: number) =>
    textBoxes.push({ id: uid('txt'), tile: { x, y }, content: content.slice(0, 100), fontSize });
  const addConn = (
    a: string,
    b: string,
    color: string,
    style: 'SOLID' | 'DASHED' | 'DOTTED' = 'SOLID',
    label?: string,
    width = 8
  ) =>
    connectors.push({
      id: uid('conn'),
      color,
      style,
      width,
      ...(label ? { description: label } : {}),
      anchors: [
        { id: uid('anc'), ref: { item: a } },
        { id: uid('anc'), ref: { item: b } },
      ],
    });

  const nodeByInstance = new Set<string>();
  const natItemIds: string[] = [];

  // Duplicate Name tags (e.g. ASG nodes) get an instance-id suffix so they stay distinguishable
  // 동일 Name 태그(ASG 노드 등)는 인스턴스 ID 접미사로 구분
  const nameTag = (n: TopologyNode) => metaStr(n, 'nameTag');
  const nameCount = new Map<string, number>();
  vEc2.forEach((n) => {
    const tag = nameTag(n);
    if (tag) nameCount.set(tag, (nameCount.get(tag) || 0) + 1);
  });
  const ec2Label = (n: TopologyNode) => {
    const tag = nameTag(n);
    if (!tag) return shortId(n.id);
    return (nameCount.get(tag) || 0) > 1 ? `${tag} (${shortId(n.id)})` : tag;
  };

  // Tile positions of EC2 nodes, kept for the EKS cluster overlay
  // EKS 클러스터 오버레이용 EC2 노드 타일 좌표 기록
  const ec2Tiles = new Map<string, { x: number; y: number; cluster: string | null }>();

  const placeSubnet = (s: TopologySubnet, ox: number, oy: number, tier: 'pub' | 'prv'): [number, number] => {
    const sid = s.id;
    const lambdas = (lambdaInSubnet.get(sid) || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const residents: ['nat' | 'ec2' | 'lambda', TopologyNode][] = [
      ...(natInSubnet.get(sid) || []).map((x): ['nat', TopologyNode] => ['nat', x]),
      ...(ec2InSubnet.get(sid) || [])
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((x): ['ec2', TopologyNode] => ['ec2', x]),
      ...lambdas.slice(0, LAMBDA_CAP).map((x): ['lambda', TopologyNode] => ['lambda', x]),
    ];
    const n = Math.max(1, residents.length);
    const cols = Math.min(n, COLS);
    const rows = Math.ceil(n / COLS);
    const w = (cols - 1) * SP + 4;
    const h = (rows - 1) * SP + 4;
    addRect(ox, oy, ox + w, oy + h, tier === 'pub' ? 'col-pub' : 'col-prv');
    addText(ox, oy - 1, subnetLabel(s), 0.25);
    residents.forEach(([kind, r], i) => {
      const cx = ox + 2 + (i % COLS) * SP;
      const cy = oy + 2 + Math.floor(i / COLS) * SP;
      const lh = i % 2 ? LABEL_HIGH : LABEL_LOW;
      if (kind === 'nat') {
        const iid = `nat-${r.id}`;
        addNode(iid, natLabel(r), 'router', cx, cy, '', lh);
        natItemIds.push(iid);
      } else if (kind === 'lambda') {
        addNode(`lambda-${r.name}`, r.name, 'aws-lambda', cx, cy, metaStr(r, 'runtime'), lh);
      } else {
        const iid = r.id;
        addNode(iid, ec2Label(r), 'aws-ec2', cx, cy, '', lh);
        nodeByInstance.add(iid);
        ec2Tiles.set(iid, { x: cx, y: cy, cluster: metaStr(r, 'eksCluster') || null });
      }
    });
    if (lambdas.length > LAMBDA_CAP) {
      addText(ox, oy + h + 1, `+${lambdas.length - LAMBDA_CAP} more Lambda`, 0.22);
    }
    return [w, h];
  };

  // Service box: same footprint rules as a subnet box (RDS/Cache/MSK/OpenSearch, external tray)
  const placeServiceBox = (
    label: string,
    entries: ServiceEntry[],
    ox: number,
    oy: number,
    color = 'col-prv'
  ): [number, number] => {
    const n = Math.max(1, entries.length);
    const cols = Math.min(n, COLS);
    const rows = Math.ceil(n / COLS);
    const w = (cols - 1) * SP + 4;
    const h = (rows - 1) * SP + 4;
    addRect(ox, oy, ox + w, oy + h, color);
    addText(ox, oy - 1, label, 0.25);
    entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e, i) => {
        const cx = ox + 2 + (i % COLS) * SP;
        const cy = oy + 2 + Math.floor(i / COLS) * SP;
        addNode(e.id, e.name, e.icon, cx, cy, e.desc, i % 2 ? LABEL_HIGH : LABEL_LOW);
      });
    return [w, h];
  };

  // ---- lay out AZ columns inside the VPC ----
  const albRowH = vElb.length ? SP + 1 : 0;
  let azX = VPC_PAD + 1;
  const azTop = VPC_PAD + 1 + albRowH + 1;
  let maxBottom = azTop;
  azs.forEach((az) => {
    const tiers = grid.get(az)!;
    const subnets: [TopologySubnet, 'pub' | 'prv'][] = [
      ...tiers.public.map((s): [TopologySubnet, 'pub'] => [s, 'pub']),
      ...tiers.private.map((s): [TopologySubnet, 'prv'] => [s, 'prv']),
    ];
    const azBoxes = Array.from(serviceBoxesByAz.get(az)?.entries() || []);
    let colW = 0;
    subnets.forEach(([s]) => {
      const sid = s.id;
      const n = Math.max(
        1,
        (ec2InSubnet.get(sid)?.length || 0) +
          (natInSubnet.get(sid)?.length || 0) +
          Math.min(lambdaInSubnet.get(sid)?.length || 0, LAMBDA_CAP)
      );
      colW = Math.max(colW, (Math.min(n, COLS) - 1) * SP + 4);
    });
    azBoxes.forEach(([, entries]) => {
      colW = Math.max(colW, (Math.min(entries.length, COLS) - 1) * SP + 4);
    });
    let y = azTop + 1;
    addText(azX, azTop - 1, `AZ ${az}`, 0.3);
    subnets.forEach(([s, tier]) => {
      const [, h] = placeSubnet(s, azX, y, tier);
      y += h + GAP_SUBNET;
    });
    azBoxes.forEach(([label, entries]) => {
      const [, h] = placeServiceBox(label, entries, azX, y);
      y += h + GAP_SUBNET;
    });
    maxBottom = Math.max(maxBottom, y - GAP_SUBNET);
    azX += colW + GAP_AZ;
  });

  const vpcW = Math.max(azX - GAP_AZ + VPC_PAD, 10);
  const vpcH = maxBottom + VPC_PAD - 1;

  // ALBs centered at top inside the VPC, grouped in an ingress band
  // ALB는 VPC 상단 중앙에 인그레스 밴드로 그룹핑
  const albIds: [string, TopologyNode][] = [];
  if (vElb.length) {
    const n = vElb.length;
    const albY = VPC_PAD + 1;
    const startX = Math.max(VPC_PAD + 1, Math.floor((vpcW - (n - 1) * SP) / 2));
    addRect(startX - 1, albY - 1, startX + (n - 1) * SP + 1, albY + 1, 'col-alb');
    addText(startX - 1, albY - 2, 'Load Balancer (ingress)', 0.25);
    [...vElb]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e, i) => {
        const iid = `elb-${e.name.replace(/[^A-Za-z0-9-]/g, '-')}`;
        addNode(
          iid,
          e.name,
          'aws-elastic-load-balancing',
          startX + i * SP,
          albY,
          metaStr(e, 'scheme'),
          i % 2 ? LABEL_HIGH : LABEL_LOW
        );
        albIds.push([iid, e]);
      });
  }

  addRect(0, 0, vpcW, vpcH, 'col-vpc');
  addText(0, -1, `${vpcName} (${vpcCidr})`, 0.35);
  addNode('internet', 'Internet', 'cloud', Math.floor(vpcW / 2), -3);

  // IGW on the VPC boundary between Internet and the ALB band, labeled with its Name tag
  // IGW는 VPC 경계(Internet과 ALB 밴드 사이)에 Name 태그로 표기
  const igwId = vIgw.length ? `igw-node-${vIgw[0].id}` : null;
  if (igwId) {
    addNode(igwId, vIgw[0].name, 'router', Math.floor(vpcW / 2), 0, 'Internet Gateway');
  }

  // TGW attachments on the left VPC boundary, labeled with Name tags
  // TGW 어태치먼트는 VPC 좌측 경계에 Name 태그로 표기
  vTgw.forEach((t, i) => {
    addNode(
      `tgw-node-${t.id}`,
      t.name,
      'aws-transit-gateway',
      0,
      Math.floor(vpcH / 2) + i * SP,
      'Transit Gateway attachment',
      i % 2 ? LABEL_HIGH : LABEL_LOW
    );
  });

  // EKS cluster overlays per contiguous node group (unshift so they render above
  // subnet sheets). One box per cluster x subnet — a whole-cluster bounding box
  // would swallow everything between the AZ columns.
  // EKS 클러스터 오버레이 — 클러스터×서브넷 단위 (전체 바운딩 박스는 AZ 사이를
  // 전부 덮어버리므로 인접 노드 그룹별로 분리)
  if (show.eks) {
    const byClusterSubnet = new Map<string, { x: number; y: number }[]>();
    vEc2.forEach((n) => {
      const t = ec2Tiles.get(n.id);
      if (!t || !t.cluster) return;
      const key = `${t.cluster}|${n.subnetId}`;
      if (!byClusterSubnet.has(key)) byClusterSubnet.set(key, []);
      byClusterSubnet.get(key)!.push(t);
    });
    byClusterSubnet.forEach((tiles, key) => {
      const cluster = key.split('|')[0];
      const xs = tiles.map((t) => t.x);
      const ys = tiles.map((t) => t.y);
      rectangles.unshift({
        id: uid('rect'),
        color: 'col-eks',
        from: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 },
        to: { x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 },
      });
      addText(Math.min(...xs) - 1, Math.max(...ys) + 2, `EKS ${cluster}`, 0.22);
    });
  }

  // VPC endpoints on the right boundary (capped)
  // VPC 엔드포인트는 우측 경계 배치 (상한)
  const EP_CAP = 8;
  vEndpoints.slice(0, EP_CAP).forEach((e, i) => {
    addNode(
      `vpce-${e.id}`,
      e.name,
      'cube',
      vpcW,
      3 + i * SP,
      `${metaStr(e, 'endpointType')} endpoint`,
      i % 2 ? LABEL_HIGH : LABEL_LOW
    );
  });
  if (vEndpoints.length > EP_CAP) {
    addText(vpcW, 3 + EP_CAP * SP, `+${vEndpoints.length - EP_CAP} more endpoints`, 0.22);
  }

  // Account-global tray right of the VPC (opt-in layers, capped per type)
  // VPC 밖 계정 전역 트레이 (opt-in 레이어, 타입별 상한)
  const TRAY_CAP = 9;
  const trayBoxes: [string, ServiceEntry[], number][] = [];
  const addTray = (
    label: string,
    list: TopologyNode[],
    toEntry: (n: TopologyNode) => ServiceEntry
  ) => {
    if (list.length) trayBoxes.push([label, list.slice(0, TRAY_CAP).map(toEntry), list.length]);
  };
  if (show.s3)
    addTray('S3', globalOfKind('s3'), (n) => ({
      id: `s3-${n.name}`,
      name: n.name,
      icon: 'aws-simple-storage-service',
      desc: metaStr(n, 'region'),
    }));
  if (show.dynamodb)
    addTray('DynamoDB', globalOfKind('dynamodb'), (n) => ({
      id: `ddb-${n.name}`,
      name: n.name,
      icon: 'aws-dynamodb',
      desc: '',
    }));
  if (show.cloudfront)
    addTray('CloudFront', globalOfKind('cloudfront'), (n) => ({
      id: `cf-${metaStr(n, 'distributionId')}`,
      name: n.name,
      icon: 'aws-cloudfront',
      desc: metaStr(n, 'distributionId'),
    }));
  if (show.route53)
    addTray('Route 53', globalOfKind('route53'), (n) => ({
      id: `r53-${n.id.slice('route53:'.length)}`,
      name: n.name,
      icon: 'aws-route-53',
      desc: n.meta.privateZone ? 'private zone' : 'public zone',
    }));
  if (trayBoxes.length) {
    const trayX = vpcW + 4;
    addText(trayX, 0, 'Account-global (external)', 0.3);
    let ty = 2;
    trayBoxes.forEach(([label, entries, total]) => {
      const [, h] = placeServiceBox(label, entries, trayX, ty, 'col-ext');
      if (total > entries.length) {
        addText(trayX, ty + h + 1, `+${total - entries.length} more`, 0.22);
        ty += 1;
      }
      ty += h + GAP_SUBNET;
    });
  }

  // ---- connectors ----
  const seen = new Set<string>();
  const connOnce = (
    a: string,
    b: string,
    color: string,
    style: 'SOLID' | 'DASHED' | 'DOTTED' = 'SOLID',
    label?: string,
    width = 8
  ) => {
    const key = `${a}->${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    addConn(a, b, color, style, label, width);
  };
  const ingressHub = igwId || 'internet';
  if (igwId) connOnce('internet', igwId, 'col-edge', 'SOLID', 'HTTPS');
  albIds.forEach(([iid, e]) => {
    if (metaStr(e, 'scheme') === 'internet-facing')
      connOnce(ingressHub, iid, 'col-edge', 'SOLID', igwId ? undefined : 'HTTPS');
    resolveTargets(e.id).forEach((inst) => {
      if (nodeByInstance.has(inst)) connOnce(iid, inst, 'col-edge');
    });
  });
  if (show.egress && natItemIds.length) {
    const nat0 = natItemIds[0];
    nodeByInstance.forEach((inst) => connOnce(inst, nat0, 'col-egress', 'DOTTED', undefined, 4));
    connOnce(nat0, ingressHub, 'col-egress', 'DASHED', undefined, 6);
  }

  // ---- recenter layout on the origin (initial camera looks at tile 0,0) ----
  const xs: number[] = [];
  const ys: number[] = [];
  viewItems.forEach((v) => {
    xs.push(v.tile.x);
    ys.push(v.tile.y);
  });
  textBoxes.forEach((t) => {
    xs.push(t.tile.x);
    ys.push(t.tile.y);
  });
  rectangles.forEach((r) => {
    xs.push(r.from.x, r.to.x);
    ys.push(r.from.y, r.to.y);
  });
  const dx = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
  const dy = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
  viewItems.concat(textBoxes).forEach((v) => {
    v.tile.x -= dx;
    v.tile.y -= dy;
  });
  rectangles.forEach((r) => {
    r.from.x -= dx;
    r.to.x -= dx;
    r.from.y -= dy;
    r.to.y -= dy;
  });

  return {
    title: `AWSops - ${vpcName}`,
    description: `Auto-generated from Steampipe data (${vpcId}, ${vpcCidr})`,
    icons: fossflowIcons,
    colors: COLORS,
    items: modelItems,
    views: [
      {
        id: 'view-main',
        name: `${vpcName} topology`,
        items: viewItems,
        rectangles,
        connectors,
        textBoxes,
      },
    ],
    // Consumed by the page as fitToView (fossflow fits the diagram on mount)
    fitToScreen: true,
  };
}
