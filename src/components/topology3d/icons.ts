// AWS service icons per NodeKind, reused from the FossFLOW view's embedded
// isometric icon pack (data URIs, no network). No three.js import, so HTML
// panels (Legend, FilterPanel) use the same map the 3D textures are built from.
// 종류별 AWS 아이콘. FossFLOW 뷰에 내장된 아이소메트릭 아이콘(data URI)을 재사용한다. three 미사용.
import { fossflowIcons } from '@/lib/fossflow/icons';
import { type NodeKind } from '@/lib/topology/types';

const KIND_ICON_ID: Record<NodeKind, string> = {
  ec2: 'aws-ec2',
  alb: 'aws-elastic-load-balancing',
  nlb: 'aws-elastic-load-balancing',
  nat: 'router',
  igw: 'cloud',
  tgw: 'aws-transit-gateway',
  endpoint: 'cube',
  lambda: 'aws-lambda',
  rds: 'aws-rds',
  elasticache: 'aws-elasticache',
  msk: 'aws-managed-streaming-for-apache-kafka',
  opensearch: 'aws-opensearch-service',
  eks: 'aws-elastic-kubernetes-service',
  s3: 'aws-simple-storage-service',
  dynamodb: 'aws-dynamodb',
  cloudfront: 'aws-cloudfront',
  route53: 'aws-route-53',
};

const byId = new Map(fossflowIcons.map((i) => [i.id, i.url]));

export const KIND_ICON_URL: Record<NodeKind, string> = Object.fromEntries(
  (Object.keys(KIND_ICON_ID) as NodeKind[]).map((k) => [k, byId.get(KIND_ICON_ID[k]) ?? ''])
) as Record<NodeKind, string>;

// Display names for the legend. / 범례용 표시 이름.
export const KIND_LABELS: Record<NodeKind, string> = {
  ec2: 'EC2',
  alb: 'ALB',
  nlb: 'NLB',
  nat: 'NAT Gateway',
  igw: 'Internet Gateway',
  tgw: 'Transit Gateway',
  endpoint: 'VPC Endpoint',
  lambda: 'Lambda',
  rds: 'RDS',
  elasticache: 'ElastiCache',
  msk: 'MSK',
  opensearch: 'OpenSearch',
  eks: 'EKS',
  s3: 'S3',
  dynamodb: 'DynamoDB',
  cloudfront: 'CloudFront',
  route53: 'Route 53',
};
