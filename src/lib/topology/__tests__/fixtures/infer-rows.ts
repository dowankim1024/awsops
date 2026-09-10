// A small but complete account for the inference rules: one VPC, two subnets,
// a public ALB, a web and an app instance, an RDS behind a data SG, a bucket, a
// table, a Lambda, a gateway endpoint, a CloudFront distribution and a zone.
// Each rule has something to match and something to miss.
// 추론 규칙용 작은 계정. 규칙마다 맞는 것과 빗나가는 것을 하나씩 둔다.
import { type InferInput } from '../../infer';
import { type TopologyGraph, type TopologyNode } from '../../types';

export const ACC = '111111111111';
export const REGION = 'ap-northeast-2';

export const SG = {
  alb: 'sg-0alb',
  web: 'sg-0web',
  app: 'sg-0app',
  data: 'sg-0data',
  orphan: 'sg-0orphan', // no member in the graph / 그래프에 멤버가 없는 그룹
};

const node = (id: string, kind: TopologyNode['kind'], extra: Partial<TopologyNode> = {}): TopologyNode => ({
  id,
  kind,
  name: id,
  meta: {},
  ...extra,
});

export const ALB_DNS = 'prod-web-alb-123456789.ap-northeast-2.elb.amazonaws.com';
export const CF_DOMAIN = 'd111111abcdef8.cloudfront.net';
export const BUCKET = 'prod-assets';
export const TABLE = 'prod-orders';
export const ROLE_APP = `arn:aws:iam::${ACC}:role/prod-app-instance-role`;
export const ROLE_WILD = `arn:aws:iam::${ACC}:role/prod-wildcard-role`;
export const FN = 'prod-resize-images';
export const FN_ARN = `arn:aws:lambda:${REGION}:${ACC}:function:${FN}`;

export function buildGraph(): TopologyGraph {
  return {
    meta: { source: 'fixture', accountId: ACC, generatedAt: '2026-09-10T00:00:00.000Z' },
    vpcs: [{ id: 'vpc-0a', name: 'prod-vpc', cidr: '10.10.0.0/16' }],
    subnets: [
      { id: 'subnet-pub', vpcId: 'vpc-0a', az: `${REGION}a`, cidr: '10.10.0.0/24', tier: 'public', name: 'pub-a' },
      { id: 'subnet-prv', vpcId: 'vpc-0a', az: `${REGION}a`, cidr: '10.10.1.0/24', tier: 'private', name: 'prv-a' },
    ],
    nodes: [
      node('igw-0a', 'igw', { vpcId: 'vpc-0a' }),
      node('alb:prod-web-alb', 'alb', {
        name: 'prod-web-alb',
        vpcId: 'vpc-0a',
        meta: { scheme: 'internet-facing', dnsName: ALB_DNS, securityGroups: [SG.alb] },
      }),
      node('i-0web', 'ec2', {
        name: 'prod-web-01',
        vpcId: 'vpc-0a',
        subnetId: 'subnet-pub',
        az: `${REGION}a`,
        meta: { securityGroups: [SG.web] },
      }),
      node('i-0app', 'ec2', {
        name: 'prod-app-01',
        vpcId: 'vpc-0a',
        subnetId: 'subnet-prv',
        az: `${REGION}a`,
        meta: { securityGroups: [SG.app], roleArn: ROLE_APP },
      }),
      node('rds:prod-db', 'rds', {
        name: 'prod-db',
        vpcId: 'vpc-0a',
        meta: { engine: 'aurora-mysql', securityGroups: [SG.data] },
      }),
      node(`lambda:${FN}`, 'lambda', {
        name: FN,
        vpcId: 'vpc-0a',
        subnetId: 'subnet-prv',
        meta: { runtime: 'nodejs20.x', roleArn: ROLE_WILD },
      }),
      node('vpce-0s3', 'endpoint', {
        name: 's3',
        vpcId: 'vpc-0a',
        meta: { serviceName: `com.amazonaws.${REGION}.s3`, endpointType: 'Gateway' },
      }),
      node('vpce-0ssm', 'endpoint', {
        name: 'ssm',
        vpcId: 'vpc-0a',
        meta: { serviceName: `com.amazonaws.${REGION}.ssm`, endpointType: 'Interface' },
      }),
      node(`s3:${BUCKET}`, 's3', {
        name: BUCKET,
        meta: { region: REGION, domain: `${BUCKET}.s3.${REGION}.amazonaws.com` },
      }),
      node(`dynamodb:${TABLE}`, 'dynamodb', { name: TABLE }),
      node('cloudfront:E1ABCDEFGHIJK', 'cloudfront', {
        name: 'cdn.example.com',
        meta: { distributionId: 'E1ABCDEFGHIJK', domainName: CF_DOMAIN, aliases: ['cdn.example.com'] },
      }),
      node('route53:example.com.', 'route53', { name: 'example.com', meta: { privateZone: false } }),
    ],
    edges: [],
  };
}

export function buildInput(): InferInput {
  return {
    securityGroupRules: [
      // internet -> public ALB
      { groupId: SG.alb, isEgress: false, cidrIpv4: '0.0.0.0/0', fromPort: 443, toPort: 443, ipProtocol: 'tcp' },
      // ALB -> web instance
      { groupId: SG.web, isEgress: false, referencedGroupId: SG.alb, fromPort: 80, toPort: 80, ipProtocol: 'tcp' },
      // web -> app
      { groupId: SG.app, isEgress: false, referencedGroupId: SG.web, fromPort: 8080, toPort: 8080, ipProtocol: 'tcp' },
      // app -> data, two ports on the same pair
      { groupId: SG.data, isEgress: false, referencedGroupId: SG.app, fromPort: 3306, toPort: 3306, ipProtocol: 'tcp' },
      { groupId: SG.data, isEgress: false, referencedGroupId: SG.app, fromPort: 6379, toPort: 6379, ipProtocol: 'tcp' },
      // whole-VPC CIDR folds onto the VPC anchor
      { groupId: SG.data, isEgress: false, cidrIpv4: '10.10.0.0/16', fromPort: 5432, toPort: 5432, ipProtocol: 'tcp' },
      // one subnet's CIDR anchors on that subnet
      { groupId: SG.app, isEgress: false, cidrIpv4: '10.10.0.0/24', fromPort: 22, toPort: 22, ipProtocol: 'tcp' },
      // egress rules are ignored
      { groupId: SG.app, isEgress: true, cidrIpv4: '0.0.0.0/0', fromPort: -1, toPort: -1, ipProtocol: '-1' },
      // a group nothing belongs to produces nothing
      { groupId: SG.orphan, isEgress: false, referencedGroupId: SG.app, fromPort: 443, toPort: 443, ipProtocol: 'tcp' },
    ],
    roleGrants: [
      {
        roleArn: ROLE_APP,
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`arn:aws:s3:::${BUCKET}/*`],
      },
      {
        roleArn: ROLE_APP,
        actions: ['dynamodb:Query'],
        resources: [`arn:aws:dynamodb:${REGION}:${ACC}:table/${TABLE}`],
      },
      // wildcard resource: badge only, never a line
      { roleArn: ROLE_WILD, actions: ['s3:*'], resources: ['*'] },
      // a bucket that is not in the graph
      { roleArn: ROLE_APP, actions: ['s3:GetObject'], resources: ['arn:aws:s3:::not-in-graph/*'] },
      // nobody holds this role
      { roleArn: `arn:aws:iam::${ACC}:role/unused`, actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${BUCKET}/*`] },
    ],
    endpoints: [
      { endpointId: 'vpce-0s3', serviceName: `com.amazonaws.${REGION}.s3`, endpointType: 'Gateway', routeTableIds: ['rtb-0prv'] },
      { endpointId: 'vpce-0ssm', serviceName: `com.amazonaws.${REGION}.ssm`, endpointType: 'Interface', subnetIds: ['subnet-prv', 'subnet-gone'] },
      { endpointId: 'vpce-0gone', serviceName: 'x', endpointType: 'Gateway', routeTableIds: ['rtb-0prv'] },
    ],
    routeTableSubnets: { 'rtb-0prv': ['subnet-prv'] },
    eventSources: [
      {
        sourceArn: `arn:aws:dynamodb:${REGION}:${ACC}:table/${TABLE}/stream/2026-01-01T00:00:00.000`,
        functionArn: FN_ARN,
        enabled: false,
      },
      // a table that is not in the graph
      {
        sourceArn: `arn:aws:dynamodb:${REGION}:${ACC}:table/ghost/stream/2026-01-01T00:00:00.000`,
        functionArn: FN_ARN,
        enabled: true,
      },
    ],
    bucketNotifications: [
      { bucket: BUCKET, functionArns: [FN_ARN, `arn:aws:lambda:${REGION}:${ACC}:function:ghost`] },
    ],
    origins: [
      { distributionId: 'E1ABCDEFGHIJK', domains: [ALB_DNS, `${BUCKET}.s3.${REGION}.amazonaws.com`, 'origin.partner.example.net'] },
      { distributionId: 'ENOSUCHDIST', domains: [ALB_DNS] },
    ],
    dnsRecords: [
      { zoneName: 'example.com.', type: 'A', targets: [CF_DOMAIN] },
      { zoneName: 'example.com', type: 'CNAME', targets: [ALB_DNS] },
      { zoneName: 'example.com', type: 'TXT', targets: [CF_DOMAIN] },
      { zoneName: 'other.example.org', type: 'A', targets: [CF_DOMAIN] },
    ],
  };
}
