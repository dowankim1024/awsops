import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARAMS,
  PRESETS,
  generateFromPreset,
  generateGraph,
  mulberry32,
  normalizeParams,
} from '../adapters/generator';
import { applyFilter, createDefaultFilter, mergeFilter } from '../filter';
import { NODE_KINDS, type NodeKind } from '../types';
import { validateGraph } from '../validate';

const FIXED = { now: new Date('2026-01-01T00:00:00.000Z') };
const countKind = (g: ReturnType<typeof generateGraph>, k: NodeKind) =>
  g.nodes.filter((n) => n.kind === k).length;

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 5 }, () => a());
    const second = Array.from({ length: 5 }, () => b());
    expect(first).toEqual(second);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('diverges for a different seed', () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
});

describe('normalizeParams', () => {
  it('clamps out-of-range values instead of throwing', () => {
    const p = normalizeParams({ vpcs: 99, azsPerVpc: 0, subnetsPerAzPerTier: -3, albsPerVpc: 1000 });
    expect(p.vpcs).toBe(4);
    expect(p.azsPerVpc).toBe(1);
    expect(p.subnetsPerAzPerTier).toBe(1);
    expect(p.albsPerVpc).toBe(12);
  });

  it('falls back to the default params for missing fields', () => {
    expect(normalizeParams({})).toEqual({
      ...DEFAULT_PARAMS,
      ec2PerPublicSubnet: [0, 2],
      extras: { ...DEFAULT_PARAMS.extras },
    });
  });

  it('gives public subnets their own smaller instance range', () => {
    expect(normalizeParams({ ec2PerSubnet: [40, 60] }).ec2PerPublicSubnet).toEqual([0, 2]);
  });
});

describe('generateGraph determinism', () => {
  it('returns an identical graph for the same seed and params', () => {
    const a = generateGraph(PRESETS.medium, FIXED);
    const b = generateGraph(PRESETS.medium, FIXED);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('returns a different graph for a different seed', () => {
    const a = generateGraph({ ...PRESETS.medium, seed: 1 }, FIXED);
    const b = generateGraph({ ...PRESETS.medium, seed: 2 }, FIXED);
    expect(a.vpcs[0].id).not.toEqual(b.vpcs[0].id);
    expect(a.subnets.length).toEqual(b.subnets.length); // structure is params, not seed
  });

  it('takes its timestamp and seed from the caller, not the clock', () => {
    const g = generateGraph(PRESETS.small, FIXED);
    expect(g.meta).toMatchObject({
      source: 'generator',
      generatedAt: '2026-01-01T00:00:00.000Z',
      seed: PRESETS.small.seed,
    });
  });
});

describe('generated graph shape', () => {
  const g = generateGraph(PRESETS.medium, FIXED);

  it('validates', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('creates subnets = vpcs x azs x tiers x subnetsPerAzPerTier', () => {
    const p = PRESETS.medium;
    expect(g.subnets.length).toBe(p.vpcs * p.azsPerVpc * 2 * p.subnetsPerAzPerTier);
    expect(new Set(g.subnets.map((s) => s.tier))).toEqual(new Set(['public', 'private']));
  });

  it('keeps every subnet CIDR inside its VPC CIDR', () => {
    const vpcOctet = new Map(g.vpcs.map((v) => [v.id, v.cidr.split('.')[1]]));
    g.subnets.forEach((s) => {
      expect(s.cidr.split('.')[1]).toBe(vpcOctet.get(s.vpcId));
    });
  });

  it('gives every EC2 a subnet, an AZ and a private IP inside its subnet', () => {
    const subnet = new Map(g.subnets.map((s) => [s.id, s]));
    g.nodes
      .filter((n) => n.kind === 'ec2')
      .forEach((n) => {
        const s = subnet.get(String(n.subnetId));
        expect(s).toBeDefined();
        expect(n.az).toBe(s!.az);
        expect(String(n.meta.privateIp).startsWith(s!.cidr.replace(/\.0\/\d+$/, '.'))).toBe(true);
      });
  });

  it('routes public subnets to the IGW and private subnets to a NAT in their AZ', () => {
    const nat = new Map(g.nodes.filter((n) => n.kind === 'nat').map((n) => [n.id, n]));
    const igw = new Set(g.nodes.filter((n) => n.kind === 'igw').map((n) => n.id));
    const subnet = new Map(g.subnets.map((s) => [s.id, s]));
    const routes = g.edges.filter((e) => e.kind === 'route');
    expect(routes.length).toBeGreaterThan(0);
    routes.forEach((e) => {
      const s = subnet.get(e.from);
      expect(s).toBeDefined();
      if (s!.tier === 'public') expect(igw.has(e.to)).toBe(true);
      else expect(nat.get(e.to)!.az).toBe(s!.az);
    });
  });

  it('points every load balancer target edge at an EC2 in the same VPC', () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const targets = g.edges.filter((e) => e.kind === 'target');
    expect(targets.length).toBeGreaterThan(0);
    targets.forEach((e) => {
      const lb = byId.get(e.from)!;
      const inst = byId.get(e.to)!;
      expect(['alb', 'nlb']).toContain(lb.kind);
      expect(inst.kind).toBe('ec2');
      expect(inst.vpcId).toBe(lb.vpcId);
    });
  });

  it('leaves account-global kinds without a VPC and VPC kinds with one', () => {
    g.nodes.forEach((n) => {
      const global = ['s3', 'dynamodb', 'cloudfront', 'route53'].includes(n.kind);
      expect(n.vpcId === undefined).toBe(global);
    });
  });

  it('spreads MSK and OpenSearch across AZs without pinning a subnet', () => {
    g.nodes
      .filter((n) => n.kind === 'msk' || n.kind === 'opensearch')
      .forEach((n) => {
        expect(n.subnetId).toBeUndefined();
        expect(n.az).toBeUndefined();
        expect(Array.isArray(n.meta.subnetIds)).toBe(true);
        expect((n.meta.azs as string[]).length).toBeGreaterThan(0);
      });
  });

  it('honours the extras counts', () => {
    Object.entries(PRESETS.medium.extras).forEach(([kind, count]) => {
      expect(countKind(g, kind as NodeKind)).toBe(count);
    });
  });

  it('uses AWS-shaped ids so a fixture is indistinguishable from live data', () => {
    expect(g.vpcs[0].id).toMatch(/^vpc-0[0-9a-f]{16}$/);
    expect(g.subnets[0].id).toMatch(/^subnet-0[0-9a-f]{16}$/);
    expect(g.nodes.find((n) => n.kind === 'ec2')!.id).toMatch(/^i-0[0-9a-f]{16}$/);
    expect(g.nodes.find((n) => n.kind === 'alb')!.id).toMatch(/^alb:/);
  });

  it('never emits a kind outside the contract', () => {
    g.nodes.forEach((n) => expect(NODE_KINDS).toContain(n.kind));
  });
});

describe('presets', () => {
  it.each(['small', 'medium', 'large', 'stress'] as const)('%s validates', (name) => {
    expect(validateGraph(generateFromPreset(name, FIXED))).toEqual([]);
  });

  it('grows monotonically from small to stress', () => {
    const sizes = (['small', 'medium', 'large', 'stress'] as const).map(
      (n) => generateFromPreset(n, FIXED).nodes.length
    );
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  // The plan's success criterion for Phase 3 rendering.
  // Phase 3 렌더링 성공 기준.
  it('stress meets the plan target: 1,000+ EC2, 30+ subnets, 2 VPCs', () => {
    const g = generateFromPreset('stress', FIXED);
    expect(countKind(g, 'ec2')).toBeGreaterThanOrEqual(1000);
    expect(g.subnets.length).toBeGreaterThanOrEqual(30);
    expect(g.vpcs.length).toBe(2);
  });

  it('builds the stress preset in under 100ms', () => {
    generateFromPreset('stress', FIXED); // warm up the module
    const t0 = performance.now();
    const g = generateFromPreset('stress', FIXED);
    const ms = performance.now() - t0;
    expect(g.nodes.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(100);
  });
});

describe('generated graphs work with the filter', () => {
  const g = generateFromPreset('large', FIXED);

  it('narrows to one VPC by default', () => {
    const out = applyFilter(g, createDefaultFilter());
    expect(out.vpcs).toHaveLength(1);
    expect(out.nodes.every((n) => n.vpcId === undefined || n.vpcId === g.vpcs[0].id)).toBe(true);
  });

  it('drops a whole tier on a tier patch', () => {
    const f = mergeFilter(createDefaultFilter(), { tiers: { public: false } });
    const out = applyFilter(g, f);
    expect(out.subnets.every((s) => s.tier === 'private')).toBe(true);
    expect(out.nodes.filter((n) => n.kind === 'nat')).toHaveLength(0); // NATs live in public subnets
  });

  it('drops a kind on a kind patch', () => {
    const out = applyFilter(g, mergeFilter(createDefaultFilter(), { kinds: { lambda: false } }));
    expect(countKind(out, 'lambda')).toBe(0);
    expect(countKind(out, 'ec2')).toBeGreaterThan(0);
  });
});
