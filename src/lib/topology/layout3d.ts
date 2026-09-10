// 3D layout: TopologyGraph -> world coordinates for every element.
// Pure and deterministic; the renderer only draws what this returns and never
// computes a position itself. Clustering (folding N same-kind nodes in one
// subnet into a stack) is a layout concern, so the renderer sees stacks as
// ordinary placed items. See docs/decisions/012-topology-3d-layout.md.
// 순수 3D 레이아웃. 렌더러는 여기서 준 좌표만 그린다. 클러스터링도 레이아웃 책임이다.
import {
  NODE_KINDS,
  isGlobalKind,
  type EdgeKind,
  type NodeKind,
  type Tier,
  type TopologyGraph,
  type TopologyNode,
  type TopologySubnet,
} from './types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Size2 {
  x: number;
  z: number;
}

export interface LayoutOptions {
  // Same-kind nodes per subnet above which they fold into one stack. <= 0 or
  // non-finite disables clustering. Default 24 (config.topology3d.clusterThreshold).
  // 서브넷 안 같은 종류 노드가 이 값을 넘으면 스택 하나로 접는다. 0 이하면 접지 않는다.
  clusterThreshold?: number;
  // Subnet ids whose stacks are unfolded. UI state, not part of the filter.
  // 펼친 서브넷. UI 상태이며 필터가 아니다.
  expanded?: Iterable<string>;
}

// World-unit constants. Everything else is derived from these.
// 월드 단위 상수. 나머지 치수는 여기서 파생된다.
export const LAYOUT = {
  cell: 1.2, // grid pitch between nodes / 노드 격자 간격
  nodeSize: 0.7, // edge length of a single node / 노드 한 변
  subnetPad: 0.9,
  subnetGap: 1.2,
  azGap: 2.4,
  tierGap: 2.0,
  rowGap: 1.4, // between service rows and tier bands / 서비스 행과 티어 띠 사이
  vpcPad: 2.0,
  vpcGap: 6.0,
  trayGap: 6.0,
  trayPad: 1.5,
  trayCols: 8,
  platformY: 0.25, // subnet platform thickness / 서브넷 단 두께
  plateY: 0.12, // VPC plate thickness / VPC 바닥판 두께
  clusterMaxHeight: 4, // stack height cap, in node sizes / 스택 최대 높이 (노드 크기 배수)
} as const;

export interface VpcBox {
  id: string;
  name: string;
  center: Vec3; // y = 0 is the plate top / y=0이 바닥판 윗면
  size: Size2;
}

export interface AzLane {
  vpcId: string;
  az: string;
  center: Vec3;
  size: Size2;
}

export interface TierBand {
  vpcId: string;
  tier: Tier;
  center: Vec3;
  size: Size2;
}

export interface SubnetPlatform {
  id: string;
  vpcId: string;
  az: string;
  tier: Tier;
  name: string;
  center: Vec3; // centre of the platform slab / 단의 중심 (y는 두께의 절반)
  size: Size2;
  nodeCount: number; // nodes inside after filtering / 필터 후 노드 수
  clusterCount: number; // stacks currently folded on it / 접힌 스택 수
  expandable: boolean; // has a kind group over the threshold / 임계값을 넘는 그룹이 있다
  expanded: boolean;
}

export interface TrayBox {
  center: Vec3;
  size: Size2;
  count: number;
}

export interface PlacedNode {
  id: string;
  kind: NodeKind;
  name: string;
  position: Vec3; // centre of the node mesh / 노드 메시 중심
  state?: string;
  vpcId?: string;
  subnetId?: string;
}

export interface PlacedCluster {
  id: string; // `${subnetId}:${kind}`
  kind: NodeKind;
  subnetId: string;
  vpcId: string;
  count: number;
  memberIds: string[];
  position: Vec3; // centre of the stack / 스택 중심
  height: number; // world units / 월드 단위
}

export interface PlacedEdge {
  id: string;
  kind: EdgeKind;
  fromId: string; // anchor-level id: node, cluster, subnet or VPC / 앵커 단위 id
  toId: string;
  from: Vec3;
  mid: Vec3; // lifted midpoint so lines arc over the platforms / 위로 띄운 중간점
  to: Vec3;
  sourceIds: string[]; // graph edge ids folded into this one / 이 선으로 접힌 원본 엣지
}

export type LabelKind = 'vpc' | 'az' | 'subnet' | 'cluster' | 'tray';

export interface PlacedLabel {
  id: string;
  kind: LabelKind;
  text: string;
  position: Vec3;
  size: number; // font size in world units / 월드 단위 글자 크기
  anchorId: string; // element the label belongs to / 라벨이 붙은 요소
}

export interface LayoutBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  radius: number; // half diagonal; never 0 / 대각선의 절반, 0이 아님
}

export interface LayoutStats {
  nodes: number; // nodes in the input graph / 입력 노드 수
  drawnNodes: number; // nodes placed individually / 개별로 그린 노드
  clusters: number;
  clusteredNodes: number; // nodes hidden inside stacks / 스택 안에 숨은 노드
  edges: number; // input edges / 입력 엣지 수
  drawnEdges: number; // after folding onto anchors / 앵커 기준으로 접은 뒤
  labels: number;
}

export interface Layout3D {
  vpcs: VpcBox[];
  azLanes: AzLane[];
  tierBands: TierBand[];
  subnets: SubnetPlatform[];
  tray: TrayBox | null;
  nodes: PlacedNode[];
  clusters: PlacedCluster[];
  edges: PlacedEdge[];
  labels: PlacedLabel[];
  // Every element id in the input (VPC, subnet, node — clustered members included)
  // to the point an edge should attach to.
  // 입력의 모든 요소 id(클러스터 멤버 포함)와 엣지가 붙을 지점.
  anchors: Map<string, Vec3>;
  // node id -> cluster id for members hidden in a stack / 스택에 숨은 노드의 클러스터 id
  clusterOf: Map<string, string>;
  bounds: LayoutBounds;
  stats: LayoutStats;
}

// ---- helpers ----

const KIND_ORDER = new Map<NodeKind, number>(NODE_KINDS.map((k, i) => [k, i]));
const byName = <T extends { name: string; id: string }>(a: T, b: T): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const byKindThenName = (a: TopologyNode, b: TopologyNode): number =>
  (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || byName(a, b);

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// Service rows hold VPC-level nodes that have no subnet. Front = internet edge,
// back = data services, the middle takes everything else.
// 서브넷이 없는 VPC 노드는 서비스 행에 둔다. 앞은 인터넷 경계, 뒤는 데이터 서비스.
type RowName = 'front' | 'mid' | 'back';
type BlockName = RowName | Tier;
const BACK_ROW_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['rds', 'elasticache', 'msk', 'opensearch']);
const FRONT_ROW_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['igw', 'tgw']);

function rowOf(n: TopologyNode): RowName {
  if (FRONT_ROW_KINDS.has(n.kind)) return 'front';
  if (n.kind === 'alb' || n.kind === 'nlb') {
    return n.meta.scheme === 'internet-facing' ? 'front' : 'mid';
  }
  if (BACK_ROW_KINDS.has(n.kind)) return 'back';
  return 'mid';
}

// Stack height grows with the log of the member count and is capped so a
// 1,000-instance subnet does not become a tower.
// 스택 높이는 멤버 수의 로그로 자라고 상한이 있다.
export function clusterHeight(count: number): number {
  const factor = Math.min(LAYOUT.clusterMaxHeight, 1 + Math.log2(Math.max(1, count)) / 2);
  return LAYOUT.nodeSize * factor;
}

interface GridSpec {
  cols: number;
  rows: number;
  width: number;
  depth: number;
}

function gridFor(slots: number, pad: number, maxCols = Infinity): GridSpec {
  const n = Math.max(1, slots);
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    width: cols * LAYOUT.cell + 2 * pad,
    depth: rows * LAYOUT.cell + 2 * pad,
  };
}

// Cell centre for slot i in a grid whose top-left corner is (left, back).
// Rows advance toward the camera (+z) so the first row is at the back.
// 격자 i번째 칸의 중심. 행은 카메라 쪽(+z)으로 진행한다.
function cellCenter(grid: GridSpec, i: number, left: number, backZ: number, pad: number): { x: number; z: number } {
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  return {
    x: left + pad + (col + 0.5) * LAYOUT.cell,
    z: backZ + pad + (row + 0.5) * LAYOUT.cell,
  };
}

interface SubnetPlan {
  subnet: TopologySubnet;
  nodes: TopologyNode[]; // sorted / 정렬됨
  groups: { kind: NodeKind; nodes: TopologyNode[]; clustered: boolean }[];
  slots: number;
  grid: GridSpec;
  expandable: boolean;
  expanded: boolean;
}

interface LanePlan {
  az: string;
  width: number;
  byTier: Record<Tier, SubnetPlan[]>;
}

// ---- main ----

export function computeLayout(g: TopologyGraph, opts: LayoutOptions = {}): Layout3D {
  const rawThreshold = opts.clusterThreshold ?? 24;
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : Infinity;
  const expanded = new Set(opts.expanded ?? []);

  const vpcs: VpcBox[] = [];
  const azLanes: AzLane[] = [];
  const tierBands: TierBand[] = [];
  const subnets: SubnetPlatform[] = [];
  const nodes: PlacedNode[] = [];
  const clusters: PlacedCluster[] = [];
  const labels: PlacedLabel[] = [];
  const anchors = new Map<string, Vec3>();
  const clusterOf = new Map<string, string>();

  const subnetById = new Map(g.subnets.map((s) => [s.id, s]));
  const nodesBySubnet = new Map<string, TopologyNode[]>();
  const looseByVpc = new Map<string, TopologyNode[]>(); // VPC nodes without a (known) subnet
  const trayNodes: TopologyNode[] = [];

  for (const n of g.nodes) {
    if (n.subnetId && subnetById.has(n.subnetId)) {
      const list = nodesBySubnet.get(n.subnetId);
      if (list) list.push(n);
      else nodesBySubnet.set(n.subnetId, [n]);
    } else if (n.vpcId && (g.vpcs.some((v) => v.id === n.vpcId) || !isGlobalKind(n.kind))) {
      const list = looseByVpc.get(n.vpcId);
      if (list) list.push(n);
      else looseByVpc.set(n.vpcId, [n]);
    } else {
      trayNodes.push(n);
    }
  }

  let xCursor = 0;
  const nodeY = LAYOUT.platformY + LAYOUT.nodeSize / 2;
  const rowY = LAYOUT.nodeSize / 2;

  const sortedVpcs = [...g.vpcs].sort(byName);
  for (const vpc of sortedVpcs) {
    // -- subnet plans grouped by AZ lane and tier --
    const vpcSubnets = g.subnets.filter((s) => s.vpcId === vpc.id).sort(byName);
    const loose = (looseByVpc.get(vpc.id) ?? []).sort(byKindThenName);
    const azSet = new Set<string>(vpcSubnets.map((s) => s.az));
    if (azSet.size === 0) loose.forEach((n) => n.az && azSet.add(n.az));
    const azs = Array.from(azSet).sort();
    if (azs.length === 0) azs.push('');
    const azIndex = new Map(azs.map((a, i) => [a, i]));

    const lanes: LanePlan[] = azs.map((az) => ({ az, width: 0, byTier: { public: [], private: [] } }));
    const laneOf = (az: string): LanePlan => lanes[azIndex.get(az) ?? 0];

    for (const s of vpcSubnets) {
      const inside = (nodesBySubnet.get(s.id) ?? []).sort(byKindThenName);
      const isExpanded = expanded.has(s.id);
      const groups: SubnetPlan['groups'] = [];
      let expandable = false;
      for (const kind of NODE_KINDS) {
        const members = inside.filter((n) => n.kind === kind);
        if (!members.length) continue;
        const over = members.length > threshold;
        if (over) expandable = true;
        groups.push({ kind, nodes: members, clustered: over && !isExpanded });
      }
      const slots = groups.reduce((acc, grp) => acc + (grp.clustered ? 1 : grp.nodes.length), 0);
      const plan: SubnetPlan = {
        subnet: s,
        nodes: inside,
        groups,
        slots,
        grid: gridFor(slots, LAYOUT.subnetPad),
        expandable,
        expanded: isExpanded && expandable,
      };
      laneOf(s.az).byTier[s.tier].push(plan);
    }

    // Lane width = widest tier row inside it; tier depth = deepest subnet in
    // that tier across the VPC so bands line up across lanes.
    // 레인 폭은 티어 행 중 가장 넓은 것, 티어 깊이는 VPC 전체에서 가장 깊은 서브넷.
    const tierDepth: Record<Tier, number> = { public: 0, private: 0 };
    for (const lane of lanes) {
      let width = LAYOUT.cell + 2 * LAYOUT.subnetPad;
      (['public', 'private'] as const).forEach((tier) => {
        const plans = lane.byTier[tier];
        if (!plans.length) return;
        const rowWidth = plans.reduce((acc, p) => acc + p.grid.width, 0) + (plans.length - 1) * LAYOUT.subnetGap;
        width = Math.max(width, rowWidth);
        tierDepth[tier] = Math.max(tierDepth[tier], ...plans.map((p) => p.grid.depth));
      });
      lane.width = width;
    }
    const innerWidth = lanes.reduce((acc, l) => acc + l.width, 0) + (lanes.length - 1) * LAYOUT.azGap;

    // -- service rows --
    const rows: Record<RowName, TopologyNode[]> = { front: [], mid: [], back: [] };
    loose.forEach((n) => rows[rowOf(n)].push(n));
    const rowSort = (a: TopologyNode, b: TopologyNode): number =>
      (azIndex.get(a.az ?? '') ?? azs.length) - (azIndex.get(b.az ?? '') ?? azs.length) || byKindThenName(a, b);
    const perLine = Math.max(1, Math.floor(innerWidth / LAYOUT.cell));
    const rowSpec = (name: RowName): { items: TopologyNode[]; lines: number; depth: number } => {
      const items = rows[name].sort(rowSort);
      const lines = items.length ? Math.ceil(items.length / perLine) : 0;
      return { items, lines, depth: lines * LAYOUT.cell };
    };
    const front = rowSpec('front');
    const mid = rowSpec('mid');
    const back = rowSpec('back');

    // Blocks from the camera (front, +z) to the back.
    // 카메라 쪽(+z, 앞)에서 뒤로 가는 블록 순서.
    const allBlocks: { name: BlockName; depth: number }[] = [
      { name: 'front', depth: front.depth },
      { name: 'public', depth: tierDepth.public },
      { name: 'mid', depth: mid.depth },
      { name: 'private', depth: tierDepth.private },
      { name: 'back', depth: back.depth },
    ];
    const blocks = allBlocks.filter((b) => b.depth > 0);
    const innerDepth = Math.max(
      LAYOUT.cell,
      blocks.reduce((acc, b) => acc + b.depth, 0) + Math.max(0, blocks.length - 1) * LAYOUT.tierGap
    );

    const width = innerWidth + 2 * LAYOUT.vpcPad;
    const depth = innerDepth + 2 * LAYOUT.vpcPad;
    const left = xCursor;
    const cx = left + width / 2;
    const frontZ = depth / 2; // VPC is centred on z = 0 / VPC는 z=0에 중심
    const innerLeft = left + LAYOUT.vpcPad;

    vpcs.push({ id: vpc.id, name: vpc.name, center: v3(cx, -LAYOUT.plateY / 2, 0), size: { x: width, z: depth } });
    anchors.set(vpc.id, v3(cx, 0, frontZ));
    labels.push({
      id: `label:${vpc.id}`,
      kind: 'vpc',
      text: `${vpc.name}  ${vpc.cidr}`,
      position: v3(left + 0.6, 0.02, frontZ - 0.9),
      size: 0.9,
      anchorId: vpc.id,
    });

    // Block z ranges, front to back.
    // 블록별 z 구간 (앞→뒤).
    const blockZ = new Map<string, { front: number; back: number }>();
    let z = frontZ - LAYOUT.vpcPad;
    blocks.forEach((b, i) => {
      blockZ.set(b.name, { front: z, back: z - b.depth });
      z -= b.depth + (i < blocks.length - 1 ? LAYOUT.tierGap : 0);
    });

    // AZ lanes span the tier bands only (service rows run the full width).
    // AZ 레인은 티어 띠 구간만 덮는다.
    const laneFront = blockZ.get('public')?.front ?? blockZ.get('private')?.front ?? frontZ - LAYOUT.vpcPad;
    const laneBack = blockZ.get('private')?.back ?? blockZ.get('public')?.back ?? laneFront - LAYOUT.cell;
    let laneX = innerLeft;
    for (const lane of lanes) {
      const laneCx = laneX + lane.width / 2;
      azLanes.push({
        vpcId: vpc.id,
        az: lane.az,
        center: v3(laneCx, 0.01, (laneFront + laneBack) / 2),
        size: { x: lane.width, z: laneFront - laneBack },
      });
      if (lane.az) {
        labels.push({
          id: `label:${vpc.id}:${lane.az}`,
          kind: 'az',
          text: lane.az,
          position: v3(laneX + 0.3, 0.03, laneFront + 0.15),
          size: 0.55,
          anchorId: vpc.id,
        });
      }

      (['public', 'private'] as const).forEach((tier) => {
        const range = blockZ.get(tier);
        const plans = lane.byTier[tier];
        if (!range || !plans.length) return;
        const rowWidth = plans.reduce((acc, p) => acc + p.grid.width, 0) + (plans.length - 1) * LAYOUT.subnetGap;
        let sx = laneCx - rowWidth / 2; // centre the row inside the lane / 레인 안에서 가운데 정렬
        for (const plan of plans) {
          const s = plan.subnet;
          const backZ = range.back + (range.front - range.back - plan.grid.depth) / 2; // vertically centred in the band
          const platCenter = v3(sx + plan.grid.width / 2, LAYOUT.platformY / 2, backZ + plan.grid.depth / 2);
          subnets.push({
            id: s.id,
            vpcId: vpc.id,
            az: s.az,
            tier: s.tier,
            name: s.name,
            center: platCenter,
            size: { x: plan.grid.width, z: plan.grid.depth },
            nodeCount: plan.nodes.length,
            clusterCount: plan.groups.filter((grp) => grp.clustered).length,
            expandable: plan.expandable,
            expanded: plan.expanded,
          });
          anchors.set(s.id, v3(platCenter.x, LAYOUT.platformY, platCenter.z));
          labels.push({
            id: `label:${s.id}`,
            kind: 'subnet',
            text: s.name,
            position: v3(sx + 0.25, LAYOUT.platformY + 0.02, backZ + plan.grid.depth - 0.2),
            size: 0.38,
            anchorId: s.id,
          });

          let slot = 0;
          for (const grp of plan.groups) {
            if (grp.clustered) {
              const c = cellCenter(plan.grid, slot, sx, backZ, LAYOUT.subnetPad);
              slot += 1;
              const height = clusterHeight(grp.nodes.length);
              const id = `${s.id}:${grp.kind}`;
              const position = v3(c.x, LAYOUT.platformY + height / 2, c.z);
              clusters.push({
                id,
                kind: grp.kind,
                subnetId: s.id,
                vpcId: vpc.id,
                count: grp.nodes.length,
                memberIds: grp.nodes.map((n) => n.id),
                position,
                height,
              });
              const anchor = v3(c.x, LAYOUT.platformY + height, c.z);
              anchors.set(id, anchor);
              grp.nodes.forEach((n) => {
                anchors.set(n.id, anchor);
                clusterOf.set(n.id, id);
              });
              labels.push({
                id: `label:${id}`,
                kind: 'cluster',
                text: `${grp.kind} ×${grp.nodes.length}`,
                position: v3(c.x, LAYOUT.platformY + height + 0.15, c.z),
                size: 0.42,
                anchorId: id,
              });
            } else {
              for (const n of grp.nodes) {
                const c = cellCenter(plan.grid, slot, sx, backZ, LAYOUT.subnetPad);
                slot += 1;
                const position = v3(c.x, nodeY, c.z);
                nodes.push({ id: n.id, kind: n.kind, name: n.name, position, state: n.state, vpcId: vpc.id, subnetId: s.id });
                anchors.set(n.id, position);
              }
            }
          }
          sx += plan.grid.width + LAYOUT.subnetGap;
        }
      });
      laneX += lane.width + LAYOUT.azGap;
    }

    // Service rows: left-to-right lines across the VPC width.
    // 서비스 행: VPC 폭을 따라 왼쪽에서 오른쪽으로 줄 세운다.
    for (const row of [
      { name: 'front' as const, spec: front },
      { name: 'mid' as const, spec: mid },
      { name: 'back' as const, spec: back },
    ]) {
      const range = blockZ.get(row.name);
      if (!range || !row.spec.items.length) continue;
      row.spec.items.forEach((n, i) => {
        const line = Math.floor(i / perLine);
        const col = i % perLine;
        const inLine = Math.min(perLine, row.spec.items.length - line * perLine);
        const lineWidth = inLine * LAYOUT.cell;
        const x = cx - lineWidth / 2 + (col + 0.5) * LAYOUT.cell;
        const zPos = range.front - (line + 0.5) * LAYOUT.cell;
        const position = v3(x, rowY, zPos);
        nodes.push({ id: n.id, kind: n.kind, name: n.name, position, state: n.state, vpcId: vpc.id });
        anchors.set(n.id, position);
      });
    }

    (['public', 'private'] as const).forEach((tier) => {
      const range = blockZ.get(tier);
      if (!range) return;
      tierBands.push({
        vpcId: vpc.id,
        tier,
        center: v3(cx, 0.005, (range.front + range.back) / 2),
        size: { x: innerWidth + LAYOUT.vpcPad, z: range.front - range.back },
      });
    });

    xCursor += width + LAYOUT.vpcGap;
  }

  // -- global tray --
  let tray: TrayBox | null = null;
  if (trayNodes.length) {
    trayNodes.sort(byKindThenName);
    const grid = gridFor(trayNodes.length, LAYOUT.trayPad, LAYOUT.trayCols);
    const left = vpcs.length ? xCursor - LAYOUT.vpcGap + LAYOUT.trayGap : 0;
    const backZ = -grid.depth / 2;
    tray = { center: v3(left + grid.width / 2, -LAYOUT.plateY / 2, 0), size: { x: grid.width, z: grid.depth }, count: trayNodes.length };
    trayNodes.forEach((n, i) => {
      const c = cellCenter(grid, i, left, backZ, LAYOUT.trayPad);
      const position = v3(c.x, rowY, c.z);
      nodes.push({ id: n.id, kind: n.kind, name: n.name, position, state: n.state });
      anchors.set(n.id, position);
    });
    labels.push({
      id: 'label:tray',
      kind: 'tray',
      text: `global  ×${trayNodes.length}`,
      position: v3(left + 0.4, 0.02, grid.depth / 2 - 0.7),
      size: 0.7,
      anchorId: 'tray',
    });
  }

  // -- edges folded onto anchors --
  const edges: PlacedEdge[] = [];
  const edgeIndex = new Map<string, PlacedEdge>();
  for (const e of g.edges) {
    const from = anchors.get(e.from);
    const to = anchors.get(e.to);
    if (!from || !to) continue;
    const fromId = clusterOf.get(e.from) ?? e.from;
    const toId = clusterOf.get(e.to) ?? e.to;
    const key = `${e.kind}:${fromId}->${toId}`;
    const existing = edgeIndex.get(key);
    if (existing) {
      existing.sourceIds.push(e.id);
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const lift = Math.min(4, Math.max(0.6, dist * 0.12));
    const placed: PlacedEdge = {
      id: key,
      kind: e.kind,
      fromId,
      toId,
      from,
      mid: v3((from.x + to.x) / 2, Math.max(from.y, to.y) + lift, (from.z + to.z) / 2),
      to,
      sourceIds: [e.id],
    };
    edgeIndex.set(key, placed);
    edges.push(placed);
  }

  // -- bounds --
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  const grow = (p: Vec3, hx = 0, hy = 0, hz = 0) => {
    min.x = Math.min(min.x, p.x - hx);
    min.y = Math.min(min.y, p.y - hy);
    min.z = Math.min(min.z, p.z - hz);
    max.x = Math.max(max.x, p.x + hx);
    max.y = Math.max(max.y, p.y + hy);
    max.z = Math.max(max.z, p.z + hz);
  };
  vpcs.forEach((b) => grow(b.center, b.size.x / 2, LAYOUT.plateY, b.size.z / 2));
  if (tray) grow(tray.center, tray.size.x / 2, LAYOUT.plateY, tray.size.z / 2);
  nodes.forEach((n) => grow(n.position, LAYOUT.nodeSize, LAYOUT.nodeSize, LAYOUT.nodeSize));
  clusters.forEach((c) => grow(c.position, LAYOUT.nodeSize, c.height / 2, LAYOUT.nodeSize));
  if (!Number.isFinite(min.x)) {
    min.x = min.y = min.z = -1;
    max.x = max.y = max.z = 1;
  }
  const center = v3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
  const radius = Math.max(
    1,
    Math.sqrt((max.x - min.x) ** 2 + (max.y - min.y) ** 2 + (max.z - min.z) ** 2) / 2
  );

  return {
    vpcs,
    azLanes,
    tierBands,
    subnets,
    tray,
    nodes,
    clusters,
    edges,
    labels,
    anchors,
    clusterOf,
    bounds: { min, max, center, radius },
    stats: {
      nodes: g.nodes.length,
      drawnNodes: nodes.length,
      clusters: clusters.length,
      clusteredNodes: clusterOf.size,
      edges: g.edges.length,
      drawnEdges: edges.length,
      labels: labels.length,
    },
  };
}
