import { describe, expect, it } from 'vitest';

import {
  bucketFromDomain,
  cidrContains,
  dataResourceNodeId,
  eventSourceNodeId,
  inferEdges,
  lambdaNodeId,
  withInferredEdges,
} from '../infer';
import { type TopologyEdge } from '../types';
import { validateGraph } from '../validate';
import {
  BUCKET,
  FN,
  ROLE_APP,
  ROLE_WILD,
  SG,
  TABLE,
  buildGraph,
  buildInput,
} from './fixtures/infer-rows';

const graph = buildGraph();
const edges = inferEdges(buildInput(), graph);

const find = (kind: TopologyEdge['kind'], from: string, to: string): TopologyEdge | undefined =>
  edges.find((e) => e.kind === kind && e.from === from && e.to === to);
const ofKind = (kind: TopologyEdge['kind']): TopologyEdge[] => edges.filter((e) => e.kind === kind);

describe('cidrContains', () => {
  it('accepts a covering range and an equal range', () => {
    expect(cidrContains('10.10.0.0/16', '10.10.1.0/24')).toBe(true);
    expect(cidrContains('10.10.1.0/24', '10.10.1.0/24')).toBe(true);
    expect(cidrContains('0.0.0.0/0', '10.10.1.0/24')).toBe(true);
  });

  it('rejects a narrower, disjoint or malformed range', () => {
    expect(cidrContains('10.10.1.0/24', '10.10.0.0/16')).toBe(false);
    expect(cidrContains('10.20.0.0/16', '10.10.1.0/24')).toBe(false);
    expect(cidrContains('10.10.0.0/33', '10.10.1.0/24')).toBe(false);
    expect(cidrContains('nonsense', '10.10.1.0/24')).toBe(false);
  });
});

describe('ARN and domain parsing', () => {
  it('maps data resource ARNs onto node ids', () => {
    expect(dataResourceNodeId('arn:aws:s3:::prod-assets')).toBe('s3:prod-assets');
    expect(dataResourceNodeId('arn:aws:s3:::prod-assets/data/*')).toBe('s3:prod-assets');
    expect(dataResourceNodeId('arn:aws:dynamodb:ap-northeast-2:1:table/orders')).toBe('dynamodb:orders');
    expect(dataResourceNodeId('arn:aws:dynamodb:ap-northeast-2:1:table/orders/index/by-user')).toBe(
      'dynamodb:orders'
    );
  });

  it('refuses wildcards and other services', () => {
    expect(dataResourceNodeId('*')).toBeNull();
    expect(dataResourceNodeId('arn:aws:s3:::*')).toBeNull();
    expect(dataResourceNodeId('arn:aws:sqs:ap-northeast-2:1:queue')).toBeNull();
    expect(dataResourceNodeId('')).toBeNull();
  });

  it('maps Lambda and event-source ARNs', () => {
    expect(lambdaNodeId('arn:aws:lambda:ap-northeast-2:1:function:fn')).toBe('lambda:fn');
    expect(lambdaNodeId('arn:aws:lambda:ap-northeast-2:1:function:fn:PROD')).toBe('lambda:fn');
    expect(lambdaNodeId('arn:aws:s3:::b')).toBeNull();
    expect(eventSourceNodeId('arn:aws:dynamodb:r:1:table/orders/stream/2026-01-01T00:00:00.000')).toBe(
      'dynamodb:orders'
    );
    expect(eventSourceNodeId('arn:aws:kafka:r:1:cluster/kafka-01/abc-1')).toBe('msk:kafka-01');
    expect(eventSourceNodeId('arn:aws:kinesis:r:1:stream/events')).toBeNull();
  });

  it('reads the bucket out of an S3 origin domain', () => {
    expect(bucketFromDomain('prod-assets.s3.ap-northeast-2.amazonaws.com')).toBe('prod-assets');
    expect(bucketFromDomain('prod-assets.s3.amazonaws.com')).toBe('prod-assets');
    expect(bucketFromDomain('prod-assets.s3-website-ap-northeast-2.amazonaws.com')).toBe('prod-assets');
    expect(bucketFromDomain('origin.partner.example.net')).toBeNull();
  });
});

describe('allows (security groups)', () => {
  it('draws A -> B for an ingress rule that references A’s group', () => {
    const e = find('allows', 'alb:prod-web-alb', 'i-0web');
    expect(e?.meta?.derived).toBe('sg');
    expect(e?.meta?.ports).toEqual(['80']);
    expect(e?.meta?.protocol).toBe('tcp');
    expect(find('allows', 'i-0web', 'i-0app')).toBeDefined();
  });

  it('merges two rules on the same pair into one edge carrying both ports', () => {
    const same = edges.filter((e) => e.kind === 'allows' && e.from === 'i-0app' && e.to === 'rds:prod-db');
    expect(same).toHaveLength(1);
    expect(same[0].meta?.ports).toEqual(['3306', '6379']);
  });

  it('anchors 0.0.0.0/0 on the internet gateway', () => {
    expect(find('allows', 'igw-0a', 'alb:prod-web-alb')?.meta?.ports).toEqual(['443']);
  });

  it('folds a whole-VPC CIDR rule onto the VPC and a subnet CIDR onto that subnet', () => {
    expect(find('allows', 'vpc-0a', 'rds:prod-db')?.meta?.ports).toEqual(['5432']);
    expect(find('allows', 'subnet-pub', 'i-0app')?.meta?.ports).toEqual(['22']);
    // the VPC-wide rule must not also produce one line per subnet
    expect(find('allows', 'subnet-prv', 'rds:prod-db')).toBeUndefined();
  });

  it('ignores egress rules and groups with no member', () => {
    expect(edges.some((e) => e.to === 'i-0app' && e.from === 'igw-0a')).toBe(false);
    expect(edges.some((e) => e.to === SG.orphan || e.from === SG.orphan)).toBe(false);
  });
});

describe('permits (IAM)', () => {
  it('draws the holder of the role to the explicit resource ARN', () => {
    const bucket = find('permits', 'i-0app', `s3:${BUCKET}`);
    expect(bucket?.meta?.derived).toBe('iam');
    expect(bucket?.meta?.roleArn).toBe(ROLE_APP);
    expect(bucket?.meta?.actions).toEqual(['s3:GetObject', 's3:PutObject']);
    expect(find('permits', 'i-0app', `dynamodb:${TABLE}`)?.meta?.actions).toEqual(['dynamodb:Query']);
  });

  it('never draws a wildcard resource', () => {
    expect(edges.some((e) => e.kind === 'permits' && e.from === `lambda:${FN}`)).toBe(false);
    expect(edges.some((e) => e.meta?.roleArn === ROLE_WILD)).toBe(false);
  });

  it('skips resources and roles that are not in the graph', () => {
    expect(edges.some((e) => e.to === 's3:not-in-graph')).toBe(false);
    expect(ofKind('permits')).toHaveLength(2);
  });
});

describe('endpoint (VPC endpoints)', () => {
  it('routes a gateway endpoint through its route tables and an interface one through its subnets', () => {
    expect(find('endpoint', 'subnet-prv', 'vpce-0s3')?.meta?.derived).toBe('endpoint');
    expect(find('endpoint', 'subnet-prv', 'vpce-0ssm')).toBeDefined();
  });

  it('drops unknown subnets and endpoints that have no node', () => {
    expect(edges.some((e) => e.from === 'subnet-gone' || e.to === 'vpce-0gone')).toBe(false);
    expect(ofKind('endpoint')).toHaveLength(2);
  });
});

describe('triggers (events)', () => {
  it('draws a bucket notification and a stream mapping', () => {
    expect(find('triggers', `s3:${BUCKET}`, `lambda:${FN}`)?.meta?.derived).toBe('event');
    expect(find('triggers', `dynamodb:${TABLE}`, `lambda:${FN}`)?.meta?.disabled).toBe(true);
  });

  it('skips a source or a function that is not in the graph', () => {
    expect(edges.some((e) => e.to === 'lambda:ghost' || e.from === 'dynamodb:ghost')).toBe(false);
    expect(ofKind('triggers')).toHaveLength(2);
  });
});

describe('origin (CloudFront / Route 53)', () => {
  it('matches an origin domain against the ALB dns name and the bucket domain', () => {
    expect(find('origin', 'cloudfront:E1ABCDEFGHIJK', 'alb:prod-web-alb')?.meta?.derived).toBe('dns');
    expect(find('origin', 'cloudfront:E1ABCDEFGHIJK', `s3:${BUCKET}`)).toBeDefined();
  });

  it('leaves a custom origin domain and an unknown distribution unconnected', () => {
    expect(edges.some((e) => e.to.includes('partner'))).toBe(false);
    expect(edges.some((e) => e.from === 'cloudfront:ENOSUCHDIST')).toBe(false);
  });

  it('resolves a zone by name with or without the trailing dot, A/AAAA/CNAME only', () => {
    expect(find('origin', 'route53:example.com.', 'cloudfront:E1ABCDEFGHIJK')).toBeDefined();
    expect(find('origin', 'route53:example.com.', 'alb:prod-web-alb')).toBeDefined();
    expect(ofKind('origin')).toHaveLength(4); // the TXT record and the unknown zone are skipped
  });
});

describe('inferEdges as a whole', () => {
  it('is deterministic and produces no self edges or duplicate ids', () => {
    const again = inferEdges(buildInput(), buildGraph());
    expect(again).toEqual(edges);
    expect(edges.some((e) => e.from === e.to)).toBe(false);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });

  it('every edge carries a derived source and keeps the graph valid', () => {
    expect(edges.every((e) => Boolean(e.meta?.derived))).toBe(true);
    const merged = withInferredEdges(graph, buildInput());
    expect(validateGraph(merged)).toEqual([]);
    expect(merged.edges).toHaveLength(edges.length);
  });

  it('returns nothing for an empty input', () => {
    expect(inferEdges({}, graph)).toEqual([]);
    expect(withInferredEdges(graph, {})).toBe(graph);
  });

  it('lets an explicit edge win over an inferred one with the same id', () => {
    const explicit: TopologyEdge = {
      id: 'allows:igw-0a->alb:prod-web-alb',
      from: 'igw-0a',
      to: 'alb:prod-web-alb',
      kind: 'allows',
    };
    const merged = withInferredEdges({ ...graph, edges: [explicit] }, buildInput());
    expect(merged.edges.filter((e) => e.id === explicit.id)).toEqual([explicit]);
  });
});

describe('generated flows connect the whole request path', () => {
  it('reaches every data service from the public zone in the medium preset', async () => {
    const { PRESETS, generateGraph } = await import('../adapters/generator');
    const g = generateGraph(PRESETS.medium, { now: new Date('2026-01-01T00:00:00.000Z') });
    const adjacency = new Map<string, string[]>();
    g.edges.forEach((e) => {
      const list = adjacency.get(e.from);
      if (list) list.push(e.to);
      else adjacency.set(e.from, [e.to]);
    });
    const start = g.nodes.find((n) => n.kind === 'route53' && !n.meta.privateZone);
    expect(start).toBeDefined();
    const seen = new Set([start!.id]);
    const queue = [start!.id];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    for (const kind of ['cloudfront', 'alb', 'ec2', 'rds', 'elasticache', 's3', 'dynamodb', 'msk', 'opensearch'] as const) {
      expect(g.nodes.some((n) => n.kind === kind && seen.has(n.id))).toBe(true);
    }
  });
});
