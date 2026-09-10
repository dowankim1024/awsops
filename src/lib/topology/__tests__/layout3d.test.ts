import { describe, expect, it } from 'vitest';
import { generateFromPreset, generateGraph } from '../adapters/generator';
import { applyFilter, createDefaultFilter, mergeFilter } from '../filter';
import { LAYOUT, clusterHeight, computeLayout, type Layout3D, type Vec3 } from '../layout3d';
import { emptyGraph, type TopologyGraph, type TopologyNode } from '../types';

const node = (id: string, kind: TopologyNode['kind'], extra: Partial<TopologyNode> = {}): TopologyNode => ({
  id,
  kind,
  name: id,
  meta: {},
  ...extra,
});

// One VPC, two AZs, a public subnet with a NAT and 2 bastions, a private subnet
// with 30 EC2 (over the default threshold) and 3 lambdas, plus VPC-level services.
// VPC 1개, AZ 2개. 프라이빗 서브넷에 EC2 30대(임계값 초과)와 람다 3개.
function smallGraph(): TopologyGraph {
  const g: TopologyGraph = {
    meta: { source: 'fixture', generatedAt: '2026-09-10T00:00:00Z' },
    vpcs: [{ id: 'vpc-a', name: 'prod-vpc', cidr: '10.0.0.0/16' }],
    subnets: [
      { id: 'sn-pub-a', vpcId: 'vpc-a', az: 'ap-northeast-2a', cidr: '10.0.0.0/24', tier: 'public', name: 'pub-a' },
      { id: 'sn-prv-a', vpcId: 'vpc-a', az: 'ap-northeast-2a', cidr: '10.0.1.0/24', tier: 'private', name: 'prv-a' },
      { id: 'sn-prv-c', vpcId: 'vpc-a', az: 'ap-northeast-2c', cidr: '10.0.2.0/24', tier: 'private', name: 'prv-c' },
    ],
    nodes: [
      node('igw-1', 'igw', { vpcId: 'vpc-a' }),
      node('nat-a', 'nat', { vpcId: 'vpc-a', subnetId: 'sn-pub-a', az: 'ap-northeast-2a' }),
      node('i-bastion-1', 'ec2', { vpcId: 'vpc-a', subnetId: 'sn-pub-a', az: 'ap-northeast-2a', state: 'running' }),
      node('i-bastion-2', 'ec2', { vpcId: 'vpc-a', subnetId: 'sn-pub-a', az: 'ap-northeast-2a', state: 'stopped' }),
      node('alb:web', 'alb', { vpcId: 'vpc-a', meta: { scheme: 'internet-facing' } }),
      node('alb:internal', 'alb', { vpcId: 'vpc-a', meta: { scheme: 'internal' } }),
      node('rds:db', 'rds', { vpcId: 'vpc-a', az: 'ap-northeast-2c' }),
      node('s3:bucket', 's3'),
      node('dynamodb:table', 'dynamodb'),
    ],
    edges: [
      { id: 'attach:igw-1->vpc-a', from: 'igw-1', to: 'vpc-a', kind: 'attach' },
      { id: 'route:sn-pub-a->igw-1', from: 'sn-pub-a', to: 'igw-1', kind: 'route' },
      { id: 'route:sn-prv-a->nat-a', from: 'sn-prv-a', to: 'nat-a', kind: 'route' },
      { id: 'egress:nat-a->igw-1', from: 'nat-a', to: 'igw-1', kind: 'egress' },
      { id: 'dangling', from: 'alb:web', to: 'i-missing', kind: 'target' },
    ],
  };
  for (let i = 0; i < 30; i += 1) {
    const id = `i-app-${String(i).padStart(2, '0')}`;
    g.nodes.push(node(id, 'ec2', { vpcId: 'vpc-a', subnetId: 'sn-prv-a', az: 'ap-northeast-2a', state: 'running' }));
    g.edges.push({ id: `target:alb:web->${id}`, from: 'alb:web', to: id, kind: 'target' });
  }
  for (let i = 0; i < 3; i += 1) {
    g.nodes.push(node(`lambda:fn-${i}`, 'lambda', { vpcId: 'vpc-a', subnetId: 'sn-prv-c', az: 'ap-northeast-2c' }));
  }
  return g;
}

const overlaps = (a: { center: Vec3; size: { x: number; z: number } }, b: { center: Vec3; size: { x: number; z: number } }): boolean =>
  Math.abs(a.center.x - b.center.x) < (a.size.x + b.size.x) / 2 - 1e-6 &&
  Math.abs(a.center.z - b.center.z) < (a.size.z + b.size.z) / 2 - 1e-6;

const inside = (p: Vec3, box: { center: Vec3; size: { x: number; z: number } }, slack = 0): boolean =>
  Math.abs(p.x - box.center.x) <= box.size.x / 2 + slack && Math.abs(p.z - box.center.z) <= box.size.z / 2 + slack;

function assertNoOverlap(layout: Layout3D) {
  for (let i = 0; i < layout.subnets.length; i += 1) {
    for (let j = i + 1; j < layout.subnets.length; j += 1) {
      expect(overlaps(layout.subnets[i], layout.subnets[j]), `${layout.subnets[i].id} vs ${layout.subnets[j].id}`).toBe(false);
    }
  }
  for (let i = 0; i < layout.vpcs.length; i += 1) {
    for (let j = i + 1; j < layout.vpcs.length; j += 1) {
      expect(overlaps(layout.vpcs[i], layout.vpcs[j])).toBe(false);
    }
  }
  layout.trays.forEach((t) => layout.vpcs.forEach((v) => expect(overlaps(v, t), `${t.id} vs ${v.id}`).toBe(false)));
  for (let i = 0; i < layout.trays.length; i += 1) {
    for (let j = i + 1; j < layout.trays.length; j += 1) {
      expect(overlaps(layout.trays[i], layout.trays[j]), `${layout.trays[i].id} vs ${layout.trays[j].id}`).toBe(false);
    }
  }
}

describe('computeLayout', () => {
  it('is deterministic', () => {
    const g = generateFromPreset('medium');
    const a = computeLayout(g);
    const b = computeLayout(g);
    expect(JSON.stringify({ ...a, anchors: Array.from(a.anchors), clusterOf: Array.from(a.clusterOf) })).toBe(
      JSON.stringify({ ...b, anchors: Array.from(b.anchors), clusterOf: Array.from(b.clusterOf) })
    );
  });

  it('handles an empty graph without NaN bounds', () => {
    const l = computeLayout(emptyGraph('generator', '2026-09-10T00:00:00Z'));
    expect(l.vpcs).toHaveLength(0);
    expect(l.nodes).toHaveLength(0);
    expect(l.bounds.radius).toBeGreaterThan(0);
    expect(Number.isFinite(l.bounds.center.x)).toBe(true);
  });

  it('folds a kind group over the threshold into one stack and unfolds it when expanded', () => {
    const g = smallGraph();
    const folded = computeLayout(g, { clusterThreshold: 24 });
    expect(folded.clusters).toHaveLength(1);
    const c = folded.clusters[0];
    expect(c.id).toBe('sn-prv-a:ec2');
    expect(c.count).toBe(30);
    expect(c.memberIds).toHaveLength(30);
    expect(c.height).toBeCloseTo(clusterHeight(30));
    // Members are not drawn individually but still have an anchor at the stack top.
    // 멤버는 개별로 그리지 않지만 스택 꼭대기에 앵커가 있다.
    expect(folded.nodes.some((n) => n.id === 'i-app-00')).toBe(false);
    expect(folded.anchors.get('i-app-00')).toEqual(folded.anchors.get('sn-prv-a:ec2'));
    expect(folded.clusterOf.get('i-app-00')).toBe('sn-prv-a:ec2');
    expect(folded.stats.clusteredNodes).toBe(30);
    expect(folded.stats.drawnNodes + folded.stats.clusteredNodes).toBe(g.nodes.length);
    const platform = folded.subnets.find((s) => s.id === 'sn-prv-a')!;
    expect(platform.expandable).toBe(true);
    expect(platform.expanded).toBe(false);
    expect(platform.clusterCount).toBe(1);

    const open = computeLayout(g, { clusterThreshold: 24, expanded: ['sn-prv-a'] });
    expect(open.clusters).toHaveLength(0);
    expect(open.nodes.filter((n) => n.subnetId === 'sn-prv-a')).toHaveLength(30);
    const openPlatform = open.subnets.find((s) => s.id === 'sn-prv-a')!;
    expect(openPlatform.expanded).toBe(true);
    expect(openPlatform.size.x).toBeGreaterThan(platform.size.x);
    open.nodes
      .filter((n) => n.subnetId === 'sn-prv-a')
      .forEach((n) => expect(inside(n.position, openPlatform)).toBe(true));
  });

  it('never clusters when the threshold is disabled', () => {
    const g = smallGraph();
    expect(computeLayout(g, { clusterThreshold: 0 }).clusters).toHaveLength(0);
    expect(computeLayout(g, { clusterThreshold: Number.NaN }).clusters).toHaveLength(0);
    expect(computeLayout(g, { clusterThreshold: 1000 }).clusters).toHaveLength(0);
  });

  it('places subnet nodes on their platform and platforms inside their VPC', () => {
    const l = computeLayout(smallGraph());
    const vpc = l.vpcs[0];
    l.subnets.forEach((s) => expect(inside(s.center, vpc)).toBe(true));
    l.nodes
      .filter((n) => n.subnetId)
      .forEach((n) => {
        const platform = l.subnets.find((s) => s.id === n.subnetId)!;
        expect(inside(n.position, platform), n.id).toBe(true);
        expect(n.position.y).toBeCloseTo(LAYOUT.platformY + LAYOUT.nodeSize / 2);
      });
    assertNoOverlap(l);
  });

  it('puts the internet edge in front of the public tier and data services behind the private tier', () => {
    const l = computeLayout(smallGraph());
    const pos = (id: string) => l.nodes.find((n) => n.id === id)!.position;
    const pub = l.subnets.find((s) => s.tier === 'public')!;
    const prv = l.subnets.find((s) => s.tier === 'private')!;
    // +z is toward the camera. / +z가 카메라 쪽.
    expect(pos('igw-1').z).toBeGreaterThan(pub.center.z + pub.size.z / 2);
    expect(pos('alb:web').z).toBeGreaterThan(pub.center.z + pub.size.z / 2);
    expect(pos('alb:internal').z).toBeLessThan(pub.center.z - pub.size.z / 2);
    expect(pos('alb:internal').z).toBeGreaterThan(prv.center.z + prv.size.z / 2);
    expect(pos('rds:db').z).toBeLessThan(prv.center.z - prv.size.z / 2);
    expect(pub.center.z).toBeGreaterThan(prv.center.z);
    // Every VPC-level node sits inside the VPC plate. / VPC 노드는 모두 바닥판 안.
    ['igw-1', 'alb:web', 'alb:internal', 'rds:db'].forEach((id) => expect(inside(pos(id), l.vpcs[0])).toBe(true));
  });

  it('draws unconnected account-global nodes in a side tray right of every VPC', () => {
    const l = computeLayout(smallGraph());
    const side = l.trays.find((t) => t.role === 'side')!;
    expect(side).toBeDefined();
    expect(side.count).toBe(2);
    const vpc = l.vpcs[0];
    expect(side.center.x - side.size.x / 2).toBeGreaterThan(vpc.center.x + vpc.size.x / 2);
    ['s3:bucket', 'dynamodb:table'].forEach((id) => {
      const p = l.nodes.find((n) => n.id === id)!.position;
      expect(inside(p, side)).toBe(true);
    });
    expect(l.labels.some((lb) => lb.kind === 'tray')).toBe(true);
  });

  it('moves connected globals into the flow: edge kinds in front, data kinds behind', () => {
    const g = smallGraph();
    g.nodes.push(node('cloudfront:E1', 'cloudfront', { meta: { distributionId: 'E1' } }));
    g.nodes.push(node('route53:example.com.', 'route53', { name: 'example.com' }));
    g.edges.push(
      { id: 'origin:route53:example.com.->cloudfront:E1', from: 'route53:example.com.', to: 'cloudfront:E1', kind: 'origin' },
      { id: 'origin:cloudfront:E1->alb:web', from: 'cloudfront:E1', to: 'alb:web', kind: 'origin' },
      { id: 'permits:i-app-00->s3:bucket', from: 'i-app-00', to: 's3:bucket', kind: 'permits' }
    );
    const l = computeLayout(g);
    const vpc = l.vpcs[0];
    const front = l.trays.find((t) => t.role === 'front')!;
    const back = l.trays.find((t) => t.role === 'back')!;
    const side = l.trays.find((t) => t.role === 'side')!;
    expect(front.count).toBe(2);
    expect(back.count).toBe(1);
    // dynamodb:table has no edge, so it stays on the side / 선이 없는 것만 옆에 남는다
    expect(side.count).toBe(1);
    expect(front.center.z - front.size.z / 2).toBeGreaterThan(vpc.center.z + vpc.size.z / 2);
    expect(back.center.z + back.size.z / 2).toBeLessThan(vpc.center.z - vpc.size.z / 2);
    ['cloudfront:E1', 'route53:example.com.'].forEach((id) =>
      expect(inside(l.nodes.find((n) => n.id === id)!.position, front)).toBe(true)
    );
    expect(inside(l.nodes.find((n) => n.id === 's3:bucket')!.position, back)).toBe(true);
    assertNoOverlap(l);
  });

  it('lifts an inferred edge above the explicit edge joining the same anchors', () => {
    const g = smallGraph();
    g.edges.push({ id: 'allows:alb:web->i-app-00', from: 'alb:web', to: 'i-app-00', kind: 'allows' });
    const l = computeLayout(g);
    const stack = l.clusters.find((c) => c.subnetId === 'sn-prv-a' && c.kind === 'ec2')!;
    const target = l.edges.find((e) => e.kind === 'target' && e.fromId === 'alb:web' && e.toId === stack.id)!;
    const allows = l.edges.find((e) => e.kind === 'allows' && e.fromId === 'alb:web' && e.toId === stack.id)!;
    expect(allows.mid.y).toBeGreaterThan(target.mid.y);
    expect(allows.from).toEqual(target.from);
  });

  it('folds edges onto anchors, lifts the midpoint and drops dangling ones', () => {
    const l = computeLayout(smallGraph());
    const targets = l.edges.filter((e) => e.kind === 'target');
    // 30 ALB->EC2 edges collapse to one line into the stack. / 30개 타겟 엣지가 한 선으로.
    expect(targets).toHaveLength(1);
    expect(targets[0].toId).toBe('sn-prv-a:ec2');
    expect(targets[0].sourceIds).toHaveLength(30);
    expect(l.edges.some((e) => e.id.includes('i-missing'))).toBe(false);
    expect(l.stats.edges).toBe(smallGraph().edges.length);
    expect(l.stats.drawnEdges).toBe(l.edges.length);
    l.edges.forEach((e) => {
      expect(e.mid.y).toBeGreaterThan(Math.max(e.from.y, e.to.y));
      expect(e.mid.x).toBeCloseTo((e.from.x + e.to.x) / 2);
    });
    // Subnet and VPC anchors exist for route / attach edges. / 서브넷·VPC 앵커.
    expect(l.anchors.has('sn-pub-a')).toBe(true);
    expect(l.anchors.has('vpc-a')).toBe(true);
    const attach = l.edges.find((e) => e.kind === 'attach')!;
    expect(attach.toId).toBe('vpc-a');
  });

  it('labels every VPC, AZ lane, subnet and stack', () => {
    const l = computeLayout(smallGraph());
    const kinds = l.labels.map((x) => x.kind);
    expect(kinds.filter((k) => k === 'vpc')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'az')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'subnet')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'cluster')).toHaveLength(1);
    expect(l.labels.find((x) => x.kind === 'cluster')!.text).toBe('ec2 ×30');
    expect(l.stats.labels).toBe(l.labels.length);
  });

  it('bounds contain everything', () => {
    const l = computeLayout(generateFromPreset('large'));
    const within = (p: Vec3) =>
      p.x >= l.bounds.min.x - 1 && p.x <= l.bounds.max.x + 1 && p.z >= l.bounds.min.z - 1 && p.z <= l.bounds.max.z + 1;
    l.nodes.forEach((n) => expect(within(n.position)).toBe(true));
    l.clusters.forEach((c) => expect(within(c.position)).toBe(true));
    l.vpcs.forEach((v) => expect(within(v.center)).toBe(true));
    expect(l.bounds.radius).toBeGreaterThan(1);
  });

  it('lays out the stress preset without overlap in under 100ms', () => {
    const g = generateFromPreset('stress');
    const f = applyFilter(g, createDefaultFilter());
    const t0 = performance.now();
    const l = computeLayout(f);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
    expect(l.stats.nodes).toBe(f.nodes.length);
    expect(l.stats.drawnNodes + l.stats.clusteredNodes).toBe(f.nodes.length);
    expect(l.clusters.length).toBeGreaterThan(0);
    // Every node and subnet has an anchor. / 모든 노드·서브넷에 앵커.
    f.nodes.forEach((n) => expect(l.anchors.has(n.id), n.id).toBe(true));
    f.subnets.forEach((s) => expect(l.anchors.has(s.id)).toBe(true));
    assertNoOverlap(l);
    // Two VPCs side by side on the X axis. / VPC 2개가 X축으로 나란히.
    const whole = computeLayout(g);
    expect(whole.vpcs).toHaveLength(2);
    expect(whole.vpcs[1].center.x - whole.vpcs[1].size.x / 2).toBeGreaterThan(whole.vpcs[0].center.x + whole.vpcs[0].size.x / 2);
    assertNoOverlap(whole);
  });

  it('keeps empty subnets as platforms when the filter includes them', () => {
    const g = generateGraph({ vpcs: 1, azsPerVpc: 2, subnetsPerAzPerTier: 1, ec2PerSubnet: [0, 0], ec2PerPublicSubnet: [0, 0], lambdaPerVpc: 0, albsPerVpc: 0, rdsPerVpc: 0, natPerAz: 0, extras: {} });
    const withEmpty = applyFilter(g, mergeFilter(createDefaultFilter(), { includeEmptySubnets: true }));
    const l = computeLayout(withEmpty);
    expect(l.subnets).toHaveLength(4);
    l.subnets.forEach((s) => {
      expect(s.nodeCount).toBe(0);
      expect(s.size.x).toBeGreaterThan(0);
    });
    assertNoOverlap(l);
  });
});

describe('edge folding onto subnets (ADR-014)', () => {
  // Three instances in one private subnet, all allowed to reach one database and
  // all permitted on one bucket — the shape that made the scene unreadable.
  // 한 서브넷의 인스턴스 셋이 같은 DB·버킷에 닿는 모양. 화면을 못 읽게 만들던 그것.
  const fanGraph = (): TopologyGraph => {
    const g = smallGraph();
    g.nodes.push(node('s3:bucket2', 's3'));
    ['i-app-00', 'i-app-01', 'i-app-02'].forEach((id) => {
      g.edges.push(
        { id: `allows:${id}->rds:db`, from: id, to: 'rds:db', kind: 'allows', meta: { derived: 'sg', ports: ['3306'] } },
        { id: `permits:${id}->s3:bucket2`, from: id, to: 's3:bucket2', kind: 'permits', meta: { derived: 'iam' } }
      );
    });
    // one lone instance in the public subnet reaches the database too
    g.edges.push({ id: 'allows:i-bastion-1->rds:db', from: 'i-bastion-1', to: 'rds:db', kind: 'allows', meta: { derived: 'sg' } });
    return g;
  };

  it('folds three same-subnet inferred edges into one line from the subnet', () => {
    // clustering off, so the fold is the edge fold and not the stack fold
    const l = computeLayout(fanGraph(), { clusterThreshold: 0, edgeFoldThreshold: 3 });
    const allows = l.edges.filter((e) => e.kind === 'allows' && e.toId === 'rds:db');
    expect(allows.map((e) => e.fromId).sort()).toEqual(['i-bastion-1', 'sn-prv-a']);
    const folded = allows.find((e) => e.fromId === 'sn-prv-a')!;
    expect(folded.sourceIds).toHaveLength(3);
    expect(l.edges.filter((e) => e.kind === 'permits')).toHaveLength(1);
  });

  it('leaves explicit relationships per node', () => {
    const l = computeLayout(fanGraph(), { clusterThreshold: 0, edgeFoldThreshold: 3 });
    const targets = l.edges.filter((e) => e.kind === 'target');
    expect(targets).toHaveLength(30); // one per instance, never folded onto the subnet
    expect(targets.every((e) => e.toId.startsWith('i-'))).toBe(true);
  });

  it('keeps a group under the threshold as separate lines, and can be disabled', () => {
    const high = computeLayout(fanGraph(), { clusterThreshold: 0, edgeFoldThreshold: 4 });
    expect(high.edges.filter((e) => e.kind === 'allows' && e.toId === 'rds:db')).toHaveLength(4);
    const off = computeLayout(fanGraph(), { clusterThreshold: 0, edgeFoldThreshold: 1 });
    expect(off.edges.filter((e) => e.kind === 'allows' && e.toId === 'rds:db')).toHaveLength(4);
  });

  it('indexes a folded edge under every element it stands for', () => {
    const l = computeLayout(fanGraph(), { clusterThreshold: 0, edgeFoldThreshold: 3 });
    const idx = (id: string) => l.edgeIndexByElement.get(id) ?? [];
    const folded = l.edges.findIndex((e) => e.kind === 'allows' && e.fromId === 'sn-prv-a');
    expect(folded).toBeGreaterThanOrEqual(0);
    // every member instance finds it, and so does the subnet it folded onto
    ['i-app-00', 'i-app-01', 'i-app-02', 'sn-prv-a', 'rds:db'].forEach((id) =>
      expect(idx(id)).toContain(folded)
    );
    expect(idx('i-bastion-2')).not.toContain(folded);
    // indices are sorted and unique
    l.edgeIndexByElement.forEach((list) => {
      expect(list).toEqual(Array.from(new Set(list)).sort((a, b) => a - b));
    });
  });

  it('finds a clustered member’s edges through the index', () => {
    const g = fanGraph();
    const l = computeLayout(g, { clusterThreshold: 24 }); // sn-prv-a holds 30 EC2 -> one stack
    const stack = l.clusters.find((c) => c.subnetId === 'sn-prv-a' && c.kind === 'ec2')!;
    expect(stack).toBeDefined();
    const member = l.edgeIndexByElement.get('i-app-00') ?? [];
    expect(member.length).toBeGreaterThan(0);
    member.forEach((i) => {
      const e = l.edges[i];
      expect([e.fromId, e.toId]).toContain(stack.id);
    });
  });

  it('spreads edge heights deterministically without breaking the per-kind order', () => {
    const a = computeLayout(fanGraph(), { clusterThreshold: 0 });
    const b = computeLayout(fanGraph(), { clusterThreshold: 0 });
    expect(a.edges.map((e) => e.mid.y)).toEqual(b.edges.map((e) => e.mid.y));
    const heights = new Set(a.edges.filter((e) => e.kind === 'target').map((e) => e.mid.y.toFixed(4)));
    expect(heights.size).toBeGreaterThan(1); // same kind, same length, still separated
  });
});
