export const queries = {
  // EC2 -> VPC, Subnet, SGs
  ec2Relations: `
    SELECT
      i.account_id,
      i.instance_id,
      i.instance_type,
      i.instance_state,
      i.vpc_id,
      i.subnet_id,
      i.private_ip_address,
      i.public_ip_address,
      i.security_groups,
      i.iam_instance_profile_arn,
      tags ->> 'Name' AS name,
      tags ->> 'aws:eks:cluster-name' AS eks_cluster
    FROM aws_ec2_instance i
    ORDER BY i.vpc_id, i.subnet_id
  `,

  // VPC -> Subnets
  vpcSubnets: `
    SELECT
      v.account_id,
      v.vpc_id,
      v.cidr_block AS vpc_cidr,
      v.tags ->> 'Name' AS vpc_name,
      s.subnet_id,
      s.cidr_block AS subnet_cidr,
      s.availability_zone,
      s.map_public_ip_on_launch,
      s.tags ->> 'Name' AS subnet_name
    FROM aws_vpc v
    LEFT JOIN aws_vpc_subnet s ON v.vpc_id = s.vpc_id
    ORDER BY v.vpc_id, s.availability_zone
  `,

  // ELB -> VPC, SGs
  elbRelations: `
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_application_load_balancer
    UNION ALL
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_network_load_balancer
  `,

  // NAT GW -> VPC, Subnet
  natRelations: `
    SELECT account_id, nat_gateway_id, vpc_id, subnet_id, state,
      tags ->> 'Name' AS name
    FROM aws_vpc_nat_gateway
  `,

  // IGW -> VPC
  igwRelations: `
    SELECT
      account_id,
      internet_gateway_id,
      jsonb_array_elements(attachments) ->> 'VpcId' AS vpc_id,
      tags ->> 'Name' AS name
    FROM aws_vpc_internet_gateway
  `,

  // TGW -> Attachments
  tgwRelations: `
    SELECT
      account_id,
      transit_gateway_attachment_id,
      transit_gateway_id,
      resource_id,
      resource_type,
      state,
      tags ->> 'Name' AS name
    FROM aws_ec2_transit_gateway_vpc_attachment
  `,

  // RDS -> VPC, Subnet Group
  rdsRelations: `
    SELECT
      account_id,
      db_instance_identifier,
      engine,
      class AS db_instance_class,
      vpc_id,
      availability_zone,
      endpoint_address,
      vpc_security_groups
    FROM aws_rds_db_instance
  `,

  // Route tables -> subnet associations, routes (public/private tiering)
  routeTables: `
    SELECT
      account_id,
      route_table_id,
      vpc_id,
      associations,
      routes
    FROM aws_vpc_route_table
  `,

  // Target groups -> ALB target resolution
  targetGroups: `
    SELECT
      account_id,
      target_group_arn,
      target_group_name,
      vpc_id,
      load_balancer_arns,
      target_health_descriptions
    FROM aws_ec2_target_group
  `,

  // ElastiCache clusters -> AZ placement (subnet group carries the VPC)
  elasticache: `
    SELECT
      c.cache_cluster_id,
      c.engine,
      c.preferred_availability_zone AS availability_zone,
      c.security_groups,
      g.vpc_id
    FROM aws_elasticache_cluster c
    JOIN aws_elasticache_subnet_group g
      ON c.cache_subnet_group_name = g.cache_subnet_group_name
  `,

  // MSK clusters -> client subnets
  msk: `
    SELECT
      cluster_name,
      state,
      provisioned -> 'BrokerNodeGroupInfo' -> 'ClientSubnets' AS client_subnets,
      provisioned -> 'BrokerNodeGroupInfo' -> 'SecurityGroups' AS security_groups
    FROM aws_msk_cluster
  `,

  // OpenSearch domains (VPC domains carry subnet ids)
  opensearch: `
    SELECT
      domain_name,
      engine_version,
      vpc_options -> 'SubnetIds' AS subnet_ids,
      vpc_options -> 'SecurityGroupIds' AS security_groups
    FROM aws_opensearch_domain
  `,

  // VPC-attached Lambda functions
  lambdaVpc: `
    SELECT
      name,
      runtime,
      vpc_id,
      vpc_subnet_ids,
      vpc_security_group_ids,
      role
    FROM aws_lambda_function
    WHERE vpc_id IS NOT NULL AND vpc_id != ''
  `,

  // VPC endpoints -> VPC boundary placement
  vpcEndpoints: `
    SELECT
      vpc_endpoint_id,
      vpc_id,
      service_name,
      vpc_endpoint_type,
      route_table_ids,
      subnet_ids
    FROM aws_vpc_endpoint
  `,

  // Account-global resources for the external tray (default-off layers)
  s3Buckets: `
    SELECT name, region, event_notification_configuration FROM aws_s3_bucket
  `,
  dynamodbTables: `
    SELECT name FROM aws_dynamodb_table
  `,
  cloudfrontDists: `
    SELECT id, domain_name, aliases, origins FROM aws_cloudfront_distribution
  `,
  route53Zones: `
    SELECT id, name, private_zone FROM aws_route53_zone
  `,

  // ---- configuration inference (ADR-014) ----
  // Read-only Describe/List/Get, same as everything else here. No Flow Logs,
  // no X-Ray, no CloudWatch: an inferred edge is a permitted path, not traffic.
  // 설정 추론용. 전부 읽기 전용 조회이고 로그·트레이스는 쓰지 않는다.

  // Ingress rules only; egress never opens a path into a resource
  sgRules: `
    SELECT
      account_id,
      group_id,
      security_group_rule_id,
      is_egress,
      referenced_group_id,
      cidr_ipv4::text AS cidr_ipv4,
      from_port,
      to_port,
      ip_protocol
    FROM aws_vpc_security_group_rule
    WHERE is_egress = false
  `,

  // Instance profile -> role ARN, the hop between an instance and its policies
  instanceProfiles: `
    SELECT account_id, arn, roles FROM aws_iam_instance_profile
  `,

  // Event source (DynamoDB stream, MSK cluster) -> Lambda
  eventSourceMappings: `
    SELECT account_id, arn, function_arn, state
    FROM aws_lambda_event_source_mapping
  `,

  // Alias / value records only; the adapter keeps the ones that resolve to an
  // ALB dns name or a CloudFront domain and counts the rest
  route53Records: `
    SELECT account_id, zone_id, name, type, alias_target, records
    FROM aws_route53_record
    WHERE type IN ('A', 'AAAA', 'CNAME')
  `,

  // EKS nodes -> instances
  eksNodes: `
    SELECT name, namespace, pod_ip, node_name, phase
    FROM kubernetes_pod
    WHERE phase = 'Running'
    ORDER BY node_name, namespace
    LIMIT 200
  `,

  // K8s Services / K8s 서비스
  k8sServices: `
    SELECT
      name, namespace, type, cluster_ip,
      selector::text AS selector
    FROM kubernetes_service
    ORDER BY namespace, name
  `,

  // K8s Ingress / K8s 인그레스
  k8sIngress: `
    SELECT
      name, namespace,
      ingress_class_name,
      rules::text AS rules,
      status_load_balancer::text AS load_balancer
    FROM kubernetes_ingress
    ORDER BY namespace, name
  `,
};

// IAM is fetched in a second pass, narrowed to the roles that resources actually
// use: reading every role in an account is one API call per role. `arn` is a key
// column on both tables, so Steampipe pushes the IN list down to AWS instead of
// listing everything and filtering afterwards.
// IAM은 리소스가 실제로 쓰는 롤로 좁혀 2차 조회한다. 계정의 롤 전체를 읽지 않는다.
const MAX_IAM_ARNS = 200;

// ARNs come from AWS, but this string is concatenated into SQL, so anything with
// a quote or a newline in it is dropped rather than escaped.
// ARN은 SQL에 이어 붙으므로 따옴표·개행이 있으면 escape하지 않고 버린다.
const arnList = (arns: readonly string[]): string =>
  Array.from(new Set(arns))
    .filter((a) => typeof a === 'string' && /^arn:[A-Za-z0-9:/_+=,.@-]+$/.test(a))
    .slice(0, MAX_IAM_ARNS)
    .map((a) => `'${a}'`)
    .join(', ');

export const iamRolesQuery = (roleArns: readonly string[]): string | null => {
  const list = arnList(roleArns);
  if (!list) return null;
  return `
    SELECT arn, name, inline_policies_std, attached_policy_arns
    FROM aws_iam_role
    WHERE arn IN (${list})
  `;
};

export const iamPoliciesQuery = (policyArns: readonly string[]): string | null => {
  const list = arnList(policyArns);
  if (!list) return null;
  return `
    SELECT arn, policy_std
    FROM aws_iam_policy
    WHERE arn IN (${list})
  `;
};
