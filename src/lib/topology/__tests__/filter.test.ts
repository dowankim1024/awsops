import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  applyFilter,
  createDefaultFilter,
  filterFromSearchParams,
  filterToSearchParams,
  mergeFilter,
  resolveVpcId,
} from '../filter';
import { GLOBAL_KINDS, NODE_KINDS, type TopologyGraph, type TopologyNode } from '../types';
import { validateGraph } from '../validate';

const node = (
  id: string,
  kind: TopologyNode['kind'],
  extra: Partial<TopologyNode> = {}
): TopologyNode => ({ id, kind, name: id, meta: {}, ...extra });

// Two VPCs, two AZs, public/private tiers, an empty subnet, and global tray nodes.
const graph: TopologyGraph = {
  meta: { source: 'fixture', generatedAt: '2026-09-09T00:00:00Z' },
  vpcs: [
    { id: 'vpc-a', name: 'prod', cidr: '10.0.0.0/16' },
    { id: 'vpc-b', name: 'dev', cidr: '10.1.0.0/16' },
  ],
  subnets: [
    { id: 'sn-pub-a', vpcId: 'vpc-a', az: 'ap-northeast-2a', cidr: '10.0.0.0/24', tier: 'public', name: 'pub-a' },
    { id: 'sn-prv-a', vpcId: 'vpc-a', az: 'ap-northeast-2a', cidr: '10.0.1.0/24', tier: 'private', name: 'prv-a' },
    { id: 'sn-prv-c', vpcId: 'vpc-a', az: 'ap-northeast-2c', cidr: '10.0.2.0/24', tier: 'private', name: 'prv-c' },
    { id: 'sn-empty', vpcId: 'vpc-a', az: 'ap-northeast-2c', cidr: '10.0.3.0/24', tier: 'private', name: 'empty' },
    { id: 'sn-dev', vpcId: 'vpc-b', az: 'ap-northeast-2a', cidr: '10.1.0.0/24', tier: 'public', name: 'dev' },
  ],
  nodes: [
    node('i-web', 'ec2', { name: 'web-1', vpcId: 'vpc-a', subnetId: 'sn-pub-a', az: 'ap-northeast-2a' }),
    node('nat-a', 'nat', { vpcId: 'vpc-a', subnetId: 'sn-pub-a', az: 'ap-northeast-2a' }),
    node('i-api', 'ec2', { name: 'api-1', vpcId: 'vpc-a', subnetId: 'sn-prv-a', az: 'ap-northeast-2a' }),
    node('lambda:fn', 'lambda', { name: 'fn', vpcId: 'vpc-a', subnetId: 'sn-prv-c', az: 'ap-northeast-2c' }),
    node('i-app', 'ec2', { name: 'app-1', vpcId: 'vpc-a', subnetId: 'sn-prv-c', az: 'ap-northeast-2c' }),
    node('alb:prod', 'alb', { name: 'prod', vpcId: 'vpc-a' }),
    node('rds:db', 'rds', { name: 'db', vpcId: 'vpc-a', az: 'ap-northeast-2c' }),
    node('igw-a', 'igw', { vpcId: 'vpc-a' }),
    node('i-dev', 'ec2', { name: 'dev-1', vpcId: 'vpc-b', subnetId: 'sn-dev', az: 'ap-northeast-2a' }),
    node('s3:bucket', 's3', { name: 'bucket' }),
    node('route53:zone', 'route53', { name: 'zone' }),
  ],
  edges: [
    { id: 'e1', from: 'alb:prod', to: 'i-web', kind: 'target' },
    { id: 'e2', from: 'alb:prod', to: 'i-api', kind: 'target' },
    { id: 'e3', from: 'sn-prv-a', to: 'nat-a', kind: 'route', label: '0.0.0.0/0' },
    { id: 'e4', from: 'sn-pub-a', to: 'igw-a', kind: 'route' },
    { id: 'e5', from: 'igw-a', to: 'vpc-a', kind: 'attach' },
    { id: 'e6', from: 'nat-a', to: 'igw-a', kind: 'egress' },
  ],
};

const ids = (g: TopologyGraph) => ({
  vpcs: g.vpcs.map((v) => v.id),
  subnets: g.subnets.map((s) => s.id),
  nodes: g.nodes.map((n) => n.id),
  edges: g.edges.map((e) => e.id),
});

describe('fixture graph', () => {
  it('is a valid TopologyGraph', () => {
    expect(validateGraph(graph)).toEqual([]);
  });
});

describe('DEFAULT_FILTER', () => {
  it('shows every tier and every VPC-scoped kind, hides account-global kinds', () => {
    expect(DEFAULT_FILTER.tiers).toEqual({ public: true, private: true });
    NODE_KINDS.forEach((k) => expect(DEFAULT_FILTER.kinds[k]).toBe(!GLOBAL_KINDS.includes(k)));
    expect(DEFAULT_FILTER.vpcId).toBeNull();
    expect(DEFAULT_FILTER.azs).toBeNull();
  });
  it('createDefaultFilter returns a fresh, mutable copy', () => {
    const a = createDefaultFilter();
    const b = createDefaultFilter();
    a.kinds.ec2 = false;
    expect(b.kinds.ec2).toBe(true);
    expect(DEFAULT_FILTER.kinds.ec2).toBe(true);
  });
});

describe('applyFilter', () => {
  it('defaults to the first VPC and drops empty subnets and hidden global kinds', () => {
    const out = applyFilter(graph, createDefaultFilter());
    expect(ids(out)).toEqual({
      vpcs: ['vpc-a'],
      subnets: ['sn-pub-a', 'sn-prv-a', 'sn-prv-c'],
      nodes: ['i-web', 'nat-a', 'i-api', 'lambda:fn', 'i-app', 'alb:prod', 'rds:db', 'igw-a'],
      edges: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    });
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(graph);
    applyFilter(graph, mergeFilter(createDefaultFilter(), { tiers: { public: false }, query: 'api' }));
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('selects another VPC and keeps global nodes when their kind is on', () => {
    const f = mergeFilter(createDefaultFilter(), { vpcId: 'vpc-b', kinds: { s3: true } });
    const out = applyFilter(graph, f);
    expect(ids(out)).toEqual({
      vpcs: ['vpc-b'],
      subnets: ['sn-dev'],
      nodes: ['i-dev', 's3:bucket'],
      edges: [],
    });
  });

  it('falls back to the first VPC for an unknown vpcId', () => {
    expect(resolveVpcId(graph, { vpcId: 'vpc-nope' })).toBe('vpc-a');
    expect(applyFilter(graph, mergeFilter(createDefaultFilter(), { vpcId: 'vpc-nope' })).vpcs[0].id).toBe('vpc-a');
  });

  it('hiding the public tier removes its subnets, their nodes, and dangling edges', () => {
    const out = applyFilter(graph, mergeFilter(createDefaultFilter(), { tiers: { public: false } }));
    expect(out.subnets.map((s) => s.id)).toEqual(['sn-prv-a', 'sn-prv-c']);
    expect(out.nodes.map((n) => n.id)).not.toContain('i-web');
    expect(out.nodes.map((n) => n.id)).not.toContain('nat-a');
    // ALB itself has no subnet, so it stays; its edge to i-web goes, to i-api stays
    expect(out.edges.map((e) => e.id)).toEqual(['e2', 'e5']);
  });

  it('hiding a kind removes those nodes and edges only', () => {
    const out = applyFilter(graph, mergeFilter(createDefaultFilter(), { kinds: { lambda: false, igw: false } }));
    const n = out.nodes.map((x) => x.id);
    expect(n).not.toContain('lambda:fn');
    expect(n).not.toContain('igw-a');
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('AZ filter applies to subnets and to subnet-less nodes with an az, not to AZ-less nodes', () => {
    const out = applyFilter(graph, mergeFilter(createDefaultFilter(), { azs: ['ap-northeast-2a'] }));
    expect(out.subnets.map((s) => s.id)).toEqual(['sn-pub-a', 'sn-prv-a']);
    const n = out.nodes.map((x) => x.id);
    expect(n).toEqual(['i-web', 'nat-a', 'i-api', 'alb:prod', 'igw-a']); // rds (2c) gone, alb/igw kept
  });

  it('includeEmptySubnets keeps subnets with no nodes', () => {
    const out = applyFilter(graph, mergeFilter(createDefaultFilter(), { includeEmptySubnets: true }));
    expect(out.subnets.map((s) => s.id)).toContain('sn-empty');
  });

  it('query matches node name or id case-insensitively and then prunes emptied subnets', () => {
    const out = applyFilter(graph, mergeFilter(createDefaultFilter(), { query: 'API' }));
    expect(out.nodes.map((n) => n.id)).toEqual(['i-api']);
    expect(out.subnets.map((s) => s.id)).toEqual(['sn-prv-a']);
    expect(out.edges.map((e) => e.id)).toEqual([]); // alb dropped by query, so e2 goes too
    const byId = applyFilter(graph, mergeFilter(createDefaultFilter(), { query: 'nat-' }));
    expect(byId.nodes.map((n) => n.id)).toEqual(['nat-a']);
  });

  it('a chat-style compound patch works end to end', () => {
    // "퍼블릭 서브넷이랑 람다는 빼고 a존만 보여줘"
    const f = mergeFilter(createDefaultFilter(), {
      tiers: { public: false },
      kinds: { lambda: false },
      azs: ['ap-northeast-2a'],
    });
    const out = applyFilter(graph, f);
    expect(ids(out)).toEqual({
      vpcs: ['vpc-a'],
      subnets: ['sn-prv-a'],
      nodes: ['i-api', 'alb:prod', 'igw-a'],
      edges: ['e2', 'e5'],
    });
  });
});

describe('mergeFilter', () => {
  it('merges tiers and kinds per key and ignores unknown keys / non-booleans', () => {
    const f = mergeFilter(createDefaultFilter(), {
      tiers: { public: false, bogus: false } as any,
      kinds: { lambda: false, notakind: false, ec2: 'no' } as any,
    });
    expect(f.tiers).toEqual({ public: false, private: true });
    expect(f.kinds.lambda).toBe(false);
    expect(f.kinds.ec2).toBe(true);
    expect(Object.keys(f.kinds)).toHaveLength(NODE_KINDS.length);
  });
  it('treats undefined as "keep", null azs as "all", and dedupes azs', () => {
    const base = mergeFilter(createDefaultFilter(), { vpcId: 'vpc-b', azs: ['x', 'x', 'y', ''] });
    expect(base.azs).toEqual(['x', 'y']);
    const kept = mergeFilter(base, { vpcId: undefined, azs: undefined });
    expect(kept.vpcId).toBe('vpc-b');
    expect(kept.azs).toEqual(['x', 'y']);
    expect(mergeFilter(base, { azs: null }).azs).toBeNull();
    expect(mergeFilter(base, { vpcId: null }).vpcId).toBeNull();
  });
  it('returns a new object and leaves the input untouched', () => {
    const a = createDefaultFilter();
    const b = mergeFilter(a, { kinds: { ec2: false } });
    expect(b).not.toBe(a);
    expect(a.kinds.ec2).toBe(true);
    expect(b.kinds.ec2).toBe(false);
  });
});

describe('URL round trip', () => {
  it('default filter serialises to an empty query string', () => {
    expect(filterToSearchParams(createDefaultFilter()).toString()).toBe('');
  });
  it('writes only non-default entries', () => {
    const f = mergeFilter(createDefaultFilter(), {
      vpcId: 'vpc-b',
      tiers: { public: false },
      kinds: { lambda: false, s3: true },
      azs: ['ap-northeast-2a', 'ap-northeast-2c'],
      includeEmptySubnets: true,
      query: 'web 1',
    });
    const p = filterToSearchParams(f);
    expect(Object.fromEntries(p.entries())).toEqual({
      vpc: 'vpc-b',
      tiers: 'private',
      hide: 'lambda',
      show: 's3',
      az: 'ap-northeast-2a,ap-northeast-2c',
      empty: '1',
      q: 'web 1',
    });
    expect(filterFromSearchParams(p)).toEqual(f);
  });
  it('parses an empty tiers list and ignores unknown kinds', () => {
    const f = filterFromSearchParams(new URLSearchParams('tiers=&hide=lambda,ghost&show=notreal'));
    expect(f.tiers).toEqual({ public: false, private: false });
    expect(f.kinds.lambda).toBe(false);
    expect((f.kinds as any).ghost).toBeUndefined();
  });
  it('round-trips every kind toggled', () => {
    const f = createDefaultFilter();
    NODE_KINDS.forEach((k) => (f.kinds[k] = !f.kinds[k]));
    expect(filterFromSearchParams(filterToSearchParams(f))).toEqual(f);
  });
});
