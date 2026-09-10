import { describe, expect, it } from 'vitest';

import { generateFromPreset } from '../adapters/generator';
import { ipInCidr } from '../adapters/live';
import { anonymizeGraph } from '../anonymize';
import { type TopologyGraph } from '../types';
import { validateGraph } from '../validate';

const ACCOUNT = '815090125359';
const BRAND = 'plickcorp';

// A hand-built stand-in for a live graph, carrying every kind of identifier the
// anonymizer has to deal with: account id, brand name, IPs, ARNs, DNS names.
// 익명화가 다뤄야 할 식별자를 모두 담은 합성 라이브 그래프.
const liveLike = (): TopologyGraph => ({
  meta: { source: 'live', accountId: ACCOUNT, generatedAt: '2026-01-01T00:00:00.000Z' },
  vpcs: [{ id: 'vpc-0aaa1111bbbb2222c', name: `${BRAND}-prod-vpc`, cidr: '10.42.0.0/16' }],
  subnets: [
    {
      id: 'subnet-0111aaaa2222bbbb3',
      vpcId: 'vpc-0aaa1111bbbb2222c',
      az: 'ap-northeast-2a',
      cidr: '10.42.1.0/24',
      tier: 'public',
      name: `${BRAND}-public-a`,
    },
    {
      id: 'subnet-0222aaaa3333bbbb4',
      vpcId: 'vpc-0aaa1111bbbb2222c',
      az: 'ap-northeast-2c',
      cidr: '10.42.11.0/24',
      tier: 'private',
      name: `${BRAND}-private-c`,
    },
  ],
  nodes: [
    {
      id: 'i-0abc1234def56789a',
      kind: 'ec2',
      name: `${BRAND}-web-01`,
      vpcId: 'vpc-0aaa1111bbbb2222c',
      subnetId: 'subnet-0222aaaa3333bbbb4',
      az: 'ap-northeast-2c',
      state: 'running',
      meta: {
        nameTag: `${BRAND}-web-01`,
        instanceType: 'm6i.xlarge',
        privateIp: '10.42.11.37',
        publicIp: '13.124.55.6',
        eksCluster: `${BRAND}-eks`,
      },
    },
    {
      id: `alb:${BRAND}-web-alb`,
      kind: 'alb',
      name: `${BRAND}-web-alb`,
      vpcId: 'vpc-0aaa1111bbbb2222c',
      meta: {
        arn: `arn:aws:elasticloadbalancing:ap-northeast-2:${ACCOUNT}:loadbalancer/app/${BRAND}-web-alb/50dc6c495c0c9188`,
        scheme: 'internet-facing',
        dnsName: `${BRAND}-web-alb-1234567890.ap-northeast-2.elb.amazonaws.com`,
        availabilityZones: ['ap-northeast-2a', 'ap-northeast-2c'],
        securityGroups: ['sg-0999888877776666a'],
      },
    },
    {
      id: 'igw-0777666655554444b',
      kind: 'igw',
      name: `${BRAND}-igw`,
      vpcId: 'vpc-0aaa1111bbbb2222c',
      meta: {},
    },
  ],
  edges: [
    {
      id: `target:alb:${BRAND}-web-alb->i-0abc1234def56789a`,
      from: `alb:${BRAND}-web-alb`,
      to: 'i-0abc1234def56789a',
      kind: 'target',
    },
    {
      id: 'route:subnet-0111aaaa2222bbbb3->igw-0777666655554444b',
      from: 'subnet-0111aaaa2222bbbb3',
      to: 'igw-0777666655554444b',
      kind: 'route',
      label: '0.0.0.0/0',
    },
  ],
});

const json = (g: TopologyGraph) => JSON.stringify(g);

describe('anonymizeGraph removes identity', () => {
  const out = anonymizeGraph(liveLike());
  const text = json(out);

  it('replaces the account id everywhere, including inside ARNs', () => {
    expect(text).not.toContain(ACCOUNT);
    expect(out.meta.accountId).toMatch(/^\d{12}$/);
    expect(out.meta.accountId).not.toBe(ACCOUNT);
    expect(String(out.nodes[1].meta.arn)).toContain(out.meta.accountId);
  });

  it('replaces the brand token in names, ids, ARNs and DNS names', () => {
    expect(text.toLowerCase()).not.toContain(BRAND);
  });

  it('replaces every resource id', () => {
    const before = json(liveLike());
    ['vpc-0aaa1111bbbb2222c', 'subnet-0111aaaa2222bbbb3', 'i-0abc1234def56789a', 'igw-0777666655554444b', 'sg-0999888877776666a'].forEach(
      (id) => {
        expect(before).toContain(id);
        expect(text).not.toContain(id);
      }
    );
  });

  it('replaces private and public IPs', () => {
    expect(text).not.toContain('10.42.11.37');
    expect(text).not.toContain('13.124.55.6');
    expect(out.nodes[0].meta.publicIp).toMatch(/^203\.0\.113\.\d+$/);
  });

  it('marks the result and keeps the original source', () => {
    expect(out.meta.anonymized).toBe(true);
    expect(out.meta.source).toBe('live');
  });
});

describe('anonymizeGraph keeps the graph usable', () => {
  const src = liveLike();
  const out = anonymizeGraph(src);

  it('still validates, so every reference survived the rewrite', () => {
    expect(validateGraph(out)).toEqual([]);
  });

  it('keeps counts, kinds, tiers, AZs and states', () => {
    expect(out.nodes.map((n) => n.kind)).toEqual(src.nodes.map((n) => n.kind));
    expect(out.subnets.map((s) => s.tier)).toEqual(src.subnets.map((s) => s.tier));
    expect(out.subnets.map((s) => s.az)).toEqual(src.subnets.map((s) => s.az));
    expect(out.nodes[0].state).toBe('running');
  });

  it('keeps AWS ids in AWS format', () => {
    expect(out.vpcs[0].id).toMatch(/^vpc-0[0-9a-f]{16}$/);
    expect(out.subnets[0].id).toMatch(/^subnet-0[0-9a-f]{16}$/);
    expect(out.nodes[0].id).toMatch(/^i-0[0-9a-f]{16}$/);
    expect(String(out.nodes[1].meta.securityGroups)).toMatch(/^sg-0[0-9a-f]{16}$/);
  });

  it('keeps AWS vocabulary that carries no identity', () => {
    expect(out.nodes[0].meta.instanceType).toBe('m6i.xlarge');
    expect(out.nodes[1].meta.scheme).toBe('internet-facing');
    expect(out.nodes[1].meta.availabilityZones).toEqual(['ap-northeast-2a', 'ap-northeast-2c']);
    expect(String(out.nodes[1].meta.arn)).toContain('arn:aws:elasticloadbalancing:ap-northeast-2:');
    expect(String(out.nodes[1].meta.dnsName)).toContain('.ap-northeast-2.elb.amazonaws.com');
    expect(out.edges[1].label).toBe('0.0.0.0/0');
  });

  it('keeps generic tokens so names stay readable', () => {
    expect(out.nodes[0].name).toMatch(/-web-01$/);
    expect(out.subnets[0].name).toMatch(/-public-a$/);
  });

  it('keeps the node id and the node name in agreement', () => {
    expect(out.nodes[1].id).toBe(`alb:${out.nodes[1].name}`);
    expect(out.nodes[1].name).toBe(out.nodes[0].name.replace(/-web-01$/, '-web-alb'));
  });

  it('keeps subnet CIDRs inside the VPC CIDR', () => {
    out.subnets.forEach((s) => {
      expect(ipInCidr(s.cidr.split('/')[0], out.vpcs[0].cidr)).toBe(true);
    });
  });

  it('keeps each private IP inside its own subnet', () => {
    const subnet = new Map(out.subnets.map((s) => [s.id, s]));
    const ec2 = out.nodes[0];
    expect(ipInCidr(String(ec2.meta.privateIp), subnet.get(String(ec2.subnetId))!.cidr)).toBe(true);
  });
});

describe('anonymizeGraph determinism', () => {
  it('is stable for the same seed', () => {
    expect(json(anonymizeGraph(liveLike()))).toEqual(json(anonymizeGraph(liveLike())));
  });

  it('produces different stand-ins for a different seed', () => {
    const a = anonymizeGraph(liveLike(), { seed: 1 });
    const b = anonymizeGraph(liveLike(), { seed: 2 });
    expect(a.vpcs[0].id).not.toEqual(b.vpcs[0].id);
    expect(a.meta.accountId).not.toEqual(b.meta.accountId);
  });

  it('accepts an explicit replacement account id', () => {
    expect(anonymizeGraph(liveLike(), { accountId: '000000000000' }).meta.accountId).toBe('000000000000');
  });
});

describe('anonymizeGraph on generated data', () => {
  const g = generateFromPreset('medium', { now: new Date('2026-01-01T00:00:00.000Z') });
  const out = anonymizeGraph(g);

  it('validates and keeps the node and edge counts', () => {
    expect(validateGraph(out)).toEqual([]);
    expect(out.nodes).toHaveLength(g.nodes.length);
    expect(out.edges).toHaveLength(g.edges.length);
  });

  it('leaves no node id or subnet id from the source graph', () => {
    const before = new Set([...g.nodes.map((n) => n.id), ...g.subnets.map((s) => s.id)]);
    const collide = [...out.nodes.map((n) => n.id), ...out.subnets.map((s) => s.id)].filter((id) =>
      before.has(id)
    );
    // `kind:name` ids survive when the name held nothing identifying (prod-web-alb).
    // 이름에 식별 정보가 없으면 `kind:name` ID는 그대로 남는다.
    expect(collide.every((id) => id.includes(':'))).toBe(true);
  });
});
