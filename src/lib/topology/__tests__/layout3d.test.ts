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
  if (layout.tray) layout.vpcs.forEach((v) => expect(overlaps(v, layout.tray!)).toBe(false));
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

  it('draws account-global nodes in a tray to the right of every VPC', () => {
    const l = computeLayout(smallGraph());
    expect(l.tray).not.toBeNull();
    expect(l.tray!.count).toBe(2);
    const vpc = l.vpcs[0];
    expect(l.tray!.center.x - l.tray!.size.x / 2).toBeGreaterThan(vpc.center.x + vpc.size.x / 2);
    ['s3:bucket', 'dynamodb:table'].forEach((id) => {
      const p = l.nodes.find((n) => n.id === id)!.position;
      expect(inside(p, l.tray!)).toBe(true);
    });
    expect(l.labels.some((lb) => lb.kind === 'tray')).toBe(true);
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
