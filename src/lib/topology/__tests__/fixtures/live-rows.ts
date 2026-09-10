// Synthetic Steampipe relationship rows (same columns as src/lib/queries/relationships.ts).
// Covers: two VPCs, explicit + main route tables, the map_public_ip_on_launch fallback,
// duplicate Name tags, a terminated instance, EKS-tagged workers, instance and IP
// targets, multi-AZ NAT, deleted TGW attachment, MSK/OpenSearch subnet placement,
// Lambda and endpoint caps, and every account-global tray kind.
// 합성 Steampipe 행. 생성기와 어댑터가 다루는 분기를 모두 한 번씩 밟는다.
import type { LiveTopologyRows } from '../../adapters/live';

const A = 'vpc-0aaa1111';
const B = 'vpc-0bbb2222';
const ACC = '111111111111';

const subnet = (
  vpc: string,
  id: string,
  cidr: string,
  az: string,
  name: string | null,
  mapPublic = false
) => ({
  account_id: ACC,
  vpc_id: vpc,
  vpc_cidr: vpc === A ? '10.0.0.0/16' : '10.1.0.0/16',
  vpc_name: vpc === A ? 'prod-vpc' : 'dev-vpc',
  subnet_id: id,
  subnet_cidr: cidr,
  availability_zone: az,
  subnet_name: name,
  map_public_ip_on_launch: mapPublic,
});

const ec2 = (
  id: string,
  name: string | null,
  subnet: string,
  state = 'running',
  extra: Record<string, unknown> = {}
) => ({
  account_id: ACC,
  instance_id: id,
  instance_type: 't3.medium',
  instance_state: state,
  vpc_id: A,
  subnet_id: subnet,
  private_ip_address: null,
  public_ip_address: null,
  name,
  eks_cluster: null,
  ...extra,
});

export const liveRows: LiveTopologyRows = {
  vpcSubnets: [
    subnet(A, 'subnet-0pub0a', '10.0.0.0/24', 'ap-northeast-2a', 'prod-public-a'),
    subnet(A, 'subnet-0pub0c', '10.0.1.0/24', 'ap-northeast-2c', 'prod-public-c'),
    subnet(A, 'subnet-0prv0a', '10.0.10.0/24', 'ap-northeast-2a', 'prod/private-a'),
    subnet(A, 'subnet-0prv0c', '10.0.11.0/24', 'ap-northeast-2c', 'prod-private-c'),
    subnet(A, 'subnet-0db00a', '10.0.20.0/24', 'ap-northeast-2a', null),
    subnet(A, 'subnet-0iso0c', '10.0.21.0/24', 'ap-northeast-2c', 'prod-isolated-c'),
    subnet(B, 'subnet-0dev0p', '10.1.0.0/24', 'ap-northeast-2a', 'dev-public', true),
    subnet(B, 'subnet-0dev0q', '10.1.1.0/24', 'ap-northeast-2a', 'dev-private', false),
  ],
  ec2: [
    ec2('i-0web00000000001', 'web', 'subnet-0pub0a', 'running', { public_ip_address: '3.3.3.1' }),
    ec2('i-0web00000000002', 'web', 'subnet-0pub0c'),
    ec2('i-0bast0000000003', null, 'subnet-0pub0a'),
    ec2('i-0eks00000000004', 'eks-worker', 'subnet-0prv0a', 'running', {
      eks_cluster: 'prod-eks',
      private_ip_address: '10.0.10.5',
    }),
    ec2('i-0eks00000000005', 'eks-worker', 'subnet-0prv0a', 'running', {
      eks_cluster: 'prod-eks',
      private_ip_address: '10.0.10.6',
    }),
    ec2('i-0api00000000006', 'api', 'subnet-0prv0a', 'stopped'),
    ec2('i-0app00000000007', 'app', 'subnet-0prv0c', 'running', { private_ip_address: '10.0.11.7' }),
    ec2('i-0dead0000000008', 'old', 'subnet-0prv0c', 'terminated'),
    ec2('i-0eks00000000009', 'eks-worker', 'subnet-0prv0c', 'running', { eks_cluster: 'prod-eks' }),
    { ...ec2('i-0dev00000000010', 'dev', 'subnet-0dev0p'), vpc_id: B },
  ],
  elb: [
    {
      account_id: ACC,
      elb_name: 'prod-alb',
      arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/app/prod-alb/1',
      type: 'application',
      scheme: 'internet-facing',
      vpc_id: A,
      dns_name: 'prod-alb-1.ap-northeast-2.elb.amazonaws.com',
      availability_zones: [{ ZoneName: 'ap-northeast-2a' }, { ZoneName: 'ap-northeast-2c' }],
      security_groups: ['sg-0alb'],
    },
    {
      account_id: ACC,
      elb_name: 'prod-nlb',
      arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/net/prod-nlb/2',
      type: 'network',
      scheme: 'internal',
      vpc_id: A,
      dns_name: 'prod-nlb-2.elb.ap-northeast-2.amazonaws.com',
      availability_zones: [],
      security_groups: null,
    },
  ],
  nat: [
    { account_id: ACC, nat_gateway_id: 'nat-0a0a0a0a', vpc_id: A, subnet_id: 'subnet-0pub0a', state: 'available', name: 'prod-nat-a' },
    { account_id: ACC, nat_gateway_id: 'nat-0c0c0c0c', vpc_id: A, subnet_id: 'subnet-0pub0c', state: 'available', name: null },
  ],
  routeTables: [
    {
      account_id: ACC,
      route_table_id: 'rtb-0pub',
      vpc_id: A,
      associations: [{ SubnetId: 'subnet-0pub0a' }, { SubnetId: 'subnet-0pub0c' }],
      routes: [
        { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' },
        { DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0aaa1111' },
      ],
    },
    {
      account_id: ACC,
      route_table_id: 'rtb-0prva',
      vpc_id: A,
      associations: [{ SubnetId: 'subnet-0prv0a' }],
      routes: [
        { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' },
        { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0a0a0a0a' },
      ],
    },
    {
      account_id: ACC,
      route_table_id: 'rtb-0prvc',
      vpc_id: A,
      associations: [{ SubnetId: 'subnet-0prv0c' }],
      routes: [
        { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' },
        { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0c0c0c0c' },
        { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-0x0x0x0x' },
      ],
    },
    {
      account_id: ACC,
      route_table_id: 'rtb-0main',
      vpc_id: A,
      associations: [{ Main: true }],
      routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }],
    },
  ],
  targetGroups: [
    {
      account_id: ACC,
      target_group_arn: 'arn:tg-web',
      target_group_name: 'tg-web',
      vpc_id: A,
      load_balancer_arns: ['arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/app/prod-alb/1'],
      target_health_descriptions: [
        { Target: { Id: 'i-0web00000000001', Port: 80 } },
        { Target: { Id: 'i-0web00000000002', Port: 80 } },
        { Target: { Id: 'i-0dead0000000008', Port: 80 } },
        { Target: { Id: 'i-0notinvpc000000', Port: 80 } },
      ],
    },
    {
      account_id: ACC,
      target_group_arn: 'arn:tg-ip',
      target_group_name: 'tg-ip',
      vpc_id: A,
      load_balancer_arns: ['arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/app/prod-alb/1'],
      target_health_descriptions: [
        { Target: { Id: '10.0.10.5', Port: 30080 } },
        { Target: { Id: '10.0.11.7', Port: 30080 } },
        { Target: { Id: '192.168.1.1', Port: 30080 } },
      ],
    },
    {
      account_id: ACC,
      target_group_arn: 'arn:tg-nlb',
      target_group_name: 'tg-nlb',
      vpc_id: A,
      load_balancer_arns: ['arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/net/prod-nlb/2'],
      target_health_descriptions: [{ Target: { Id: 'i-0api00000000006', Port: 8080 } }],
    },
  ],
  igw: [{ account_id: ACC, internet_gateway_id: 'igw-0aaa1111', vpc_id: A, name: 'prod-igw' }],
  tgw: [
    {
      account_id: ACC,
      transit_gateway_attachment_id: 'tgw-attach-0x0x0x0x',
      transit_gateway_id: 'tgw-0x0x0x0x',
      resource_id: A,
      resource_type: 'vpc',
      state: 'available',
      name: null,
    },
    {
      account_id: ACC,
      transit_gateway_attachment_id: 'tgw-attach-0dead',
      transit_gateway_id: 'tgw-0x0x0x0x',
      resource_id: A,
      resource_type: 'vpc',
      state: 'deleted',
      name: 'old-attach',
    },
  ],
  rds: [
    {
      account_id: ACC,
      db_instance_identifier: 'prod-db',
      engine: 'postgres',
      db_instance_class: 'db.r6g.large',
      vpc_id: A,
      availability_zone: 'ap-northeast-2a',
      endpoint_address: 'prod-db.xxxx.ap-northeast-2.rds.amazonaws.com',
    },
  ],
  elasticache: [
    { cache_cluster_id: 'prod-redis', engine: 'redis', availability_zone: 'ap-northeast-2c', vpc_id: A },
  ],
  msk: [{ cluster_name: 'prod-kafka', state: 'ACTIVE', client_subnets: ['subnet-0prv0c', 'subnet-0prv0a'] }],
  opensearch: [{ domain_name: 'prod-search', engine_version: 'OpenSearch_2.11', subnet_ids: ['subnet-0prv0c'] }],
  lambdaVpc: [
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `fn-${String(i + 1).padStart(2, '0')}`,
      runtime: 'nodejs20.x',
      vpc_id: A,
      vpc_subnet_ids: ['subnet-0prv0a', 'subnet-0prv0c'],
    })),
    { name: 'fn-report', runtime: 'python3.12', vpc_id: A, vpc_subnet_ids: ['subnet-0prv0c'] },
  ],
  vpcEndpoints: Array.from({ length: 10 }, (_, i) => ({
    vpc_endpoint_id: `vpce-0${String(i + 1).padStart(3, '0')}`,
    vpc_id: A,
    service_name: `com.amazonaws.ap-northeast-2.${['s3', 'dynamodb', 'ecr.api', 'ecr.dkr', 'logs', 'sts', 'ssm', 'ec2', 'kms', 'sqs'][i]}`,
    vpc_endpoint_type: i < 2 ? 'Gateway' : 'Interface',
  })),
  s3: [
    { name: 'prod-assets', region: 'ap-northeast-2' },
    { name: 'prod-logs', region: 'ap-northeast-2' },
    { name: 'prod-backup', region: 'us-east-1' },
  ],
  dynamodb: [{ name: 'prod-sessions' }],
  cloudfront: [
    { id: 'E1AAAAAAAAAAAA', domain_name: 'd111.cloudfront.net', aliases: ['cdn.example.com'] },
    { id: 'E2BBBBBBBBBBBB', domain_name: 'd222.cloudfront.net', aliases: { Items: [], Quantity: 0 } },
  ],
  route53: [
    { name: 'example.com.', private_zone: false },
    { name: 'internal.', private_zone: true },
  ],
};

// Option sets the FossFLOW parity test replays against the saved snapshot.
// FossFLOW 동일성 테스트가 스냅샷과 비교하는 옵션 조합.
export const fossflowCases: { label: string; vpc: string; opts: Record<string, boolean> }[] = [
  { label: 'prod default', vpc: A, opts: {} },
  {
    label: 'prod by name, empty subnets, tray layers',
    vpc: 'prod-vpc',
    opts: { includeEmpty: true, showS3: true, showDynamodb: true, showCloudfront: true, showRoute53: true },
  },
  {
    label: 'prod all layers off',
    vpc: A,
    opts: {
      showEgress: false,
      showEks: false,
      showIgw: false,
      showTgw: false,
      showLambda: false,
      showEndpoints: false,
      showRds: false,
      showElasticache: false,
      showMsk: false,
      showOpensearch: false,
    },
  },
  { label: 'dev (no route tables)', vpc: B, opts: {} },
];

// ---- configuration inference (ADR-014) ----
// A separate bag so the FossFLOW parity snapshot keeps replaying the original
// rows: the same account plus the settings the five rules read.
// 별도 묶음으로 둔다. FossFLOW 동일성 스냅샷은 원본 행을 그대로 다시 돌려야 한다.
const SG = { alb: 'sg-0alb', web: 'sg-0web', app: 'sg-0app', data: 'sg-0data' };
const PROFILE = `arn:aws:iam::${ACC}:instance-profile/prod-app`;
const ROLE_APP = `arn:aws:iam::${ACC}:role/prod-app-role`;
const ROLE_LAMBDA = `arn:aws:iam::${ACC}:role/prod-fn-role`;
const MANAGED = 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess';

const sgOf = (id: string): string[] => {
  if (id.startsWith('i-0web') || id.startsWith('i-0bast')) return [SG.web];
  return [SG.app];
};

export const liveInferRows: LiveTopologyRows = {
  ...liveRows,
  ec2: liveRows.ec2.map((r) => ({
    ...r,
    security_groups: sgOf(String(r.instance_id)).map((GroupId) => ({ GroupId })),
    iam_instance_profile_arn: String(r.instance_id).startsWith('i-0app') ? PROFILE : null,
  })),
  rds: (liveRows.rds || []).map((r) => ({
    ...r,
    vpc_security_groups: [{ VpcSecurityGroupId: SG.data, Status: 'active' }],
  })),
  elasticache: (liveRows.elasticache || []).map((r) => ({ ...r, security_groups: [{ SecurityGroupId: SG.data }] })),
  lambdaVpc: (liveRows.lambdaVpc || []).map((r) => ({
    ...r,
    vpc_security_group_ids: [SG.app],
    role: ROLE_LAMBDA,
  })),
  vpcEndpoints: (liveRows.vpcEndpoints || []).map((r) => ({
    ...r,
    route_table_ids: r.vpc_endpoint_type === 'Gateway' ? ['rtb-0prva'] : [],
    subnet_ids: r.vpc_endpoint_type === 'Gateway' ? [] : ['subnet-0prv0c'],
  })),
  s3: (liveRows.s3 || []).map((r) =>
    r.name === 'prod-assets'
      ? {
          ...r,
          event_notification_configuration: {
            LambdaFunctionConfigurations: [
              { LambdaFunctionArn: `arn:aws:lambda:ap-northeast-2:${ACC}:function:fn-01`, Events: ['s3:ObjectCreated:*'] },
            ],
          },
        }
      : r
  ),
  cloudfront: (liveRows.cloudfront || []).map((r) =>
    r.id === 'E1AAAAAAAAAAAA'
      ? {
          ...r,
          origins: {
            Items: [
              { Id: 'alb', DomainName: 'prod-alb-1.ap-northeast-2.elb.amazonaws.com' },
              { Id: 'custom', DomainName: 'origin.partner.example.net' },
            ],
          },
        }
      : r
  ),
  route53: [
    { id: '/hostedzone/Z1', name: 'example.com.', private_zone: false },
    { id: '/hostedzone/Z2', name: 'internal.', private_zone: true },
  ],

  sgRules: [
    { group_id: SG.alb, is_egress: false, referenced_group_id: null, cidr_ipv4: '0.0.0.0/0', from_port: 443, to_port: 443, ip_protocol: 'tcp' },
    { group_id: SG.web, is_egress: false, referenced_group_id: SG.alb, cidr_ipv4: null, from_port: 80, to_port: 80, ip_protocol: 'tcp' },
    { group_id: SG.app, is_egress: false, referenced_group_id: SG.web, cidr_ipv4: null, from_port: 8080, to_port: 8080, ip_protocol: 'tcp' },
    { group_id: SG.data, is_egress: false, referenced_group_id: SG.app, cidr_ipv4: null, from_port: 3306, to_port: 3306, ip_protocol: 'tcp' },
    { group_id: SG.app, is_egress: false, referenced_group_id: null, cidr_ipv4: '10.0.0.0/24', from_port: 22, to_port: 22, ip_protocol: 'tcp' },
    { group_id: SG.app, is_egress: true, referenced_group_id: null, cidr_ipv4: '0.0.0.0/0', from_port: -1, to_port: -1, ip_protocol: '-1' },
  ],
  instanceProfiles: [{ account_id: ACC, arn: PROFILE, roles: [{ Arn: ROLE_APP, RoleName: 'prod-app-role' }] }],
  roles: [
    {
      arn: ROLE_APP,
      name: 'prod-app-role',
      inline_policies_std: [
        {
          PolicyName: 'app-data',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: ['s3:getobject'], Resource: ['arn:aws:s3:::prod-assets/*'] },
              { Effect: 'Deny', Action: ['s3:deleteobject'], Resource: ['arn:aws:s3:::prod-assets/*'] },
            ],
          },
        },
      ],
      attached_policy_arns: [MANAGED],
    },
    {
      arn: ROLE_LAMBDA,
      name: 'prod-fn-role',
      inline_policies_std: [
        {
          PolicyName: 'fn-tables',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: ['dynamodb:query'], Resource: [`arn:aws:dynamodb:ap-northeast-2:${ACC}:table/prod-sessions`] },
            ],
          },
        },
      ],
      attached_policy_arns: [],
    },
  ],
  policies: [
    {
      arn: MANAGED,
      // A managed policy is almost always a wildcard: a badge on the node, no line.
      policy_std: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:getobject'], Resource: ['*'] }] },
    },
  ],
  eventSourceMappings: [
    {
      arn: `arn:aws:dynamodb:ap-northeast-2:${ACC}:table/prod-sessions/stream/2026-01-01T00:00:00.000`,
      function_arn: `arn:aws:lambda:ap-northeast-2:${ACC}:function:fn-report`,
      state: 'Enabled',
    },
  ],
  route53Records: [
    { zone_id: '/hostedzone/Z1', name: 'cdn.example.com.', type: 'A', alias_target: { DNSName: 'd111.cloudfront.net.' }, records: null },
    { zone_id: '/hostedzone/Z1', name: 'www.example.com.', type: 'CNAME', alias_target: null, records: ['prod-alb-1.ap-northeast-2.elb.amazonaws.com'] },
    { zone_id: '/hostedzone/Z9', name: 'orphan.example.com.', type: 'A', alias_target: { DNSName: 'd111.cloudfront.net.' }, records: null },
  ],
};
