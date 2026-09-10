import { describe, expect, it } from 'vitest';
import {
  attachedPolicyArns,
  ipInCidr,
  policyStatements,
  toTopologyGraph,
  usedRoleArns,
} from '../adapters/live';
import { validateGraph } from '../validate';
import { liveInferRows, liveRows } from './fixtures/live-rows';

const NOW = new Date('2026-09-09T00:00:00Z');
const graph = toTopologyGraph(liveRows, { now: NOW });
const byId = (id: string) => graph.nodes.find((n) => n.id === id);
const subnet = (id: string) => graph.subnets.find((s) => s.id === id);

describe('live adapter', () => {
  it('produces a valid graph with live metadata', () => {
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.meta).toEqual({ source: 'live', generatedAt: NOW.toISOString(), accountId: '111111111111' });
  });

  it('is deterministic for the same rows and clock', () => {
    expect(toTopologyGraph(liveRows, { now: NOW })).toEqual(graph);
  });

  it('lists VPCs once, in row order, with Name-tag fallback', () => {
    expect(graph.vpcs).toEqual([
      { id: 'vpc-0aaa1111', name: 'prod-vpc', cidr: '10.0.0.0/16' },
      { id: 'vpc-0bbb2222', name: 'dev-vpc', cidr: '10.1.0.0/16' },
    ]);
  });

  it('tiers subnets by route table, then main table, then map_public_ip_on_launch', () => {
    expect(subnet('subnet-0pub0a')?.tier).toBe('public'); // explicit association, igw route
    expect(subnet('subnet-0prv0a')?.tier).toBe('private'); // explicit association, nat route
    expect(subnet('subnet-0db00a')?.tier).toBe('private'); // no association -> main table, no igw
    expect(subnet('subnet-0db00a')?.name).toBe('subnet-0db00a'); // Name-tag fallback
    expect(subnet('subnet-0dev0p')?.tier).toBe('public'); // no route tables at all -> flag
    expect(subnet('subnet-0dev0q')?.tier).toBe('private');
  });

  it('drops terminated instances and deleted gateways, keeps stopped ones', () => {
    expect(byId('i-0dead0000000008')).toBeUndefined();
    expect(byId('tgw-attach-0dead')).toBeUndefined();
    expect(byId('i-0api00000000006')?.state).toBe('stopped');
  });

  it('places nodes with subnet-derived AZ and kind-specific meta', () => {
    expect(byId('i-0eks00000000004')).toMatchObject({
      kind: 'ec2',
      name: 'eks-worker',
      vpcId: 'vpc-0aaa1111',
      subnetId: 'subnet-0prv0a',
      az: 'ap-northeast-2a',
      state: 'running',
      meta: { nameTag: 'eks-worker', eksCluster: 'prod-eks', privateIp: '10.0.10.5', instanceType: 't3.medium' },
    });
    expect(byId('i-0bast0000000003')).toMatchObject({ name: 'i-0bast0000000003', meta: { nameTag: null } });
    expect(byId('nat-0c0c0c0c')).toMatchObject({ kind: 'nat', name: 'nat-0c0c0c0c', az: 'ap-northeast-2c' });
    expect(byId('alb:prod-alb')).toMatchObject({ kind: 'alb', meta: { scheme: 'internet-facing' } });
    expect(byId('nlb:prod-nlb')).toMatchObject({ kind: 'nlb', meta: { scheme: 'internal' } });
    expect(byId('tgw-attach-0x0x0x0x')).toMatchObject({ kind: 'tgw', name: 'tgw-0x0x0x0x' });
    expect(byId('eks:prod-eks')).toMatchObject({ kind: 'eks', vpcId: 'vpc-0aaa1111' });
    expect(byId('rds:prod-db')).toMatchObject({ kind: 'rds', az: 'ap-northeast-2a', meta: { engine: 'postgres' } });
    expect(byId('msk:prod-kafka')).toMatchObject({
      kind: 'msk',
      vpcId: 'vpc-0aaa1111',
      state: 'ACTIVE',
      meta: { azs: ['ap-northeast-2a', 'ap-northeast-2c'] },
    });
    expect(byId('opensearch:prod-search')).toMatchObject({ meta: { azs: ['ap-northeast-2c'] } });
    expect(byId('lambda:fn-report')).toMatchObject({ subnetId: 'subnet-0prv0c', az: 'ap-northeast-2c', meta: { runtime: 'python3.12' } });
    expect(byId('vpce-0003')).toMatchObject({ kind: 'endpoint', name: 'ecr.api', meta: { endpointType: 'Interface' } });
  });

  it('keeps account-global resources without a vpcId', () => {
    expect(byId('s3:prod-backup')).toMatchObject({ kind: 's3', meta: { region: 'us-east-1' } });
    expect('vpcId' in byId('s3:prod-backup')!).toBe(false);
    expect(byId('dynamodb:prod-sessions')).toMatchObject({ kind: 'dynamodb' });
    expect(byId('cloudfront:E1AAAAAAAAAAAA')?.name).toBe('cdn.example.com');
    expect(byId('cloudfront:E2BBBBBBBBBBBB')?.name).toBe('d222.cloudfront.net');
    expect(byId('route53:example.com.')).toMatchObject({ name: 'example.com', meta: { privateZone: false } });
  });

  it('resolves load balancer targets by instance id and by IP within the VPC', () => {
    const targets = graph.edges.filter((e) => e.kind === 'target').map((e) => `${e.from}->${e.to}`);
    expect(targets).toEqual([
      'alb:prod-alb->i-0eks00000000004', // 10.0.10.5 in subnet-0prv0a, eks-named
      'alb:prod-alb->i-0eks00000000005', // same subnet, eks-named sibling
      'alb:prod-alb->i-0eks00000000009', // 10.0.11.7 -> subnet-0prv0c, eks preferred over app
      'alb:prod-alb->i-0web00000000001',
      'alb:prod-alb->i-0web00000000002',
      'nlb:prod-nlb->i-0api00000000006',
    ]);
  });

  it('derives route, attach and egress edges from route tables', () => {
    const of = (kind: string) => graph.edges.filter((e) => e.kind === kind).map((e) => `${e.from}->${e.to}`);
    expect(of('route')).toEqual([
      'subnet-0pub0a->igw-0aaa1111',
      'subnet-0pub0c->igw-0aaa1111',
      'subnet-0prv0a->nat-0a0a0a0a',
      'subnet-0prv0c->nat-0c0c0c0c',
      'subnet-0prv0c->tgw-attach-0x0x0x0x',
    ]);
    expect(graph.edges.find((e) => e.from === 'subnet-0prv0c' && e.to === 'tgw-attach-0x0x0x0x')?.label).toBe('10.99.0.0/16');
    expect(of('attach')).toEqual(['igw-0aaa1111->vpc-0aaa1111', 'tgw-attach-0x0x0x0x->vpc-0aaa1111']);
    expect(of('egress')).toEqual(['nat-0a0a0a0a->igw-0aaa1111', 'nat-0c0c0c0c->igw-0aaa1111']);
  });

  it('handles an empty account', () => {
    const empty = toTopologyGraph(
      { vpcSubnets: [], ec2: [], elb: [], nat: [], routeTables: [], targetGroups: [] },
      { now: NOW }
    );
    expect(validateGraph(empty)).toEqual([]);
    expect(empty).toEqual({ meta: { source: 'live', generatedAt: NOW.toISOString() }, vpcs: [], subnets: [], nodes: [], edges: [] });
  });
});

describe('ipInCidr', () => {
  it('matches inside and rejects outside / malformed', () => {
    expect(ipInCidr('10.0.10.5', '10.0.10.0/24')).toBe(true);
    expect(ipInCidr('10.0.11.5', '10.0.10.0/24')).toBe(false);
    expect(ipInCidr('10.0.11.5', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('not-an-ip', '10.0.10.0/24')).toBe(false);
    expect(ipInCidr('10.0.10.5', '10.0.10.0/40')).toBe(false);
  });
});

describe('live adapter: configuration inference (ADR-014)', () => {
  const g = toTopologyGraph(liveInferRows, { accountId: '111111111111', now: NOW });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edge = (kind: string, from: string, to: string) =>
    g.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it('stays a valid graph', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('reads security groups out of all three row shapes', () => {
    expect(byId.get('i-0web00000000001')!.meta.securityGroups).toEqual(['sg-0web']); // [{GroupId}]
    expect(byId.get('rds:prod-db')!.meta.securityGroups).toEqual(['sg-0data']); // [{VpcSecurityGroupId}]
    expect(byId.get('alb:prod-alb')!.meta.securityGroups).toEqual(['sg-0alb']); // plain array
    expect(byId.get('lambda:fn-01')!.meta.securityGroups).toEqual(['sg-0app']);
  });

  it('resolves an instance profile to its role and a Lambda to its own', () => {
    expect(byId.get('i-0app00000000007')!.meta.roleArn).toBe('arn:aws:iam::111111111111:role/prod-app-role');
    expect(byId.get('i-0web00000000001')!.meta.roleArn).toBeNull();
    expect(byId.get('lambda:fn-01')!.meta.roleArn).toBe('arn:aws:iam::111111111111:role/prod-fn-role');
  });

  it('chains the request path through the security groups', () => {
    expect(edge('allows', 'igw-0aaa1111', 'alb:prod-alb')?.meta?.ports).toEqual(['443']);
    expect(edge('allows', 'alb:prod-alb', 'i-0web00000000001')).toBeDefined();
    expect(edge('allows', 'i-0web00000000001', 'i-0app00000000007')).toBeDefined();
    expect(edge('allows', 'i-0app00000000007', 'rds:prod-db')?.meta?.ports).toEqual(['3306']);
    // a public subnet's CIDR anchors on that subnet, not on every node in it
    expect(edge('allows', 'subnet-0pub0a', 'i-0app00000000007')?.meta?.ports).toEqual(['22']);
    // the egress rule opens nothing
    expect(g.edges.some((e) => e.kind === 'allows' && e.from === 'i-0app00000000007' && e.to === 'igw-0aaa1111')).toBe(false);
  });

  it('draws an inline IAM grant and turns the managed wildcard into a badge', () => {
    const permit = edge('permits', 'i-0app00000000007', 's3:prod-assets');
    expect(permit?.meta?.actions).toEqual(['s3:getobject']);
    expect(permit?.meta?.roleArn).toBe('arn:aws:iam::111111111111:role/prod-app-role');
    expect(byId.get('i-0app00000000007')!.meta.iamWildcard).toBe(true);
    // the Deny statement never becomes an edge
    expect(g.edges.filter((e) => e.kind === 'permits' && e.to === 's3:prod-assets')).toHaveLength(1);
    expect(edge('permits', 'lambda:fn-01', 'dynamodb:prod-sessions')).toBeDefined();
  });

  it('routes a gateway endpoint through its route table and an interface one through its subnet', () => {
    expect(edge('endpoint', 'subnet-0prv0a', 'vpce-0001')).toBeDefined(); // s3, Gateway via rtb-0prva
    expect(edge('endpoint', 'subnet-0prv0c', 'vpce-0003')).toBeDefined(); // ecr.api, Interface
    expect(g.edges.some((e) => e.kind === 'endpoint' && e.from === 'subnet-0prv0c' && e.to === 'vpce-0001')).toBe(false);
  });

  it('draws bucket notifications and stream mappings', () => {
    expect(edge('triggers', 's3:prod-assets', 'lambda:fn-01')?.meta?.derived).toBe('event');
    const stream = edge('triggers', 'dynamodb:prod-sessions', 'lambda:fn-report');
    expect(stream).toBeDefined();
    expect(stream!.meta?.disabled).toBeUndefined(); // state 'Enabled'
  });

  it('matches CloudFront origins and Route 53 records by exact domain only', () => {
    expect(edge('origin', 'cloudfront:E1AAAAAAAAAAAA', 'alb:prod-alb')).toBeDefined();
    expect(g.edges.some((e) => e.to.includes('partner'))).toBe(false);
    expect(edge('origin', 'route53:example.com.', 'cloudfront:E1AAAAAAAAAAAA')).toBeDefined();
    expect(edge('origin', 'route53:example.com.', 'alb:prod-alb')).toBeDefined();
    // a record whose zone is not in the account resolves to nothing
    expect(g.edges.filter((e) => e.kind === 'origin')).toHaveLength(3);
    expect(byId.get('route53:example.com.')!.meta.records).toBe(2);
  });

  it('produces the pre-4.6 graph when the inference queries did not run', () => {
    const plain = toTopologyGraph(liveRows, { accountId: '111111111111', now: NOW });
    expect(plain.edges.some((e) => e.meta?.derived)).toBe(false);
  });
});

describe('live adapter: narrowing the IAM passes', () => {
  it('asks only for the roles resources actually use', () => {
    expect(usedRoleArns(liveInferRows)).toEqual([
      'arn:aws:iam::111111111111:role/prod-app-role',
      'arn:aws:iam::111111111111:role/prod-fn-role',
    ]);
    expect(usedRoleArns(liveRows)).toEqual([]);
  });

  it('collects the managed policies those roles attach', () => {
    expect(attachedPolicyArns(liveInferRows.roles!)).toEqual(['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess']);
  });

  it('reads policy statements out of every document shape', () => {
    const statement = { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] };
    expect(policyStatements({ Statement: [statement] })).toEqual([statement]);
    expect(policyStatements({ Statement: statement })).toEqual([statement]);
    expect(policyStatements([{ PolicyName: 'p', PolicyDocument: { Statement: [statement] } }])).toEqual([statement]);
    expect(policyStatements({ 'inline-name': { Statement: [statement] } })).toEqual([statement]);
    expect(policyStatements(null)).toEqual([]);
    expect(policyStatements('not a policy')).toEqual([]);
  });
});
