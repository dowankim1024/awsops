import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * AWSops single-instance stack: EC2 + IAM role + security group.
 * AWSops 단일 인스턴스 스택: EC2 + IAM 롤 + 보안 그룹.
 *
 * No ALB, ACM, Route 53, or Cognito. The instance sits in an existing private subnet with
 * no inbound rule and is reached only through SSM port forwarding
 * (docs/decisions/011-ssm-only-deployment.md).
 *
 *   cdk deploy -c vpcId=vpc-xxxx -c subnetId=subnet-xxxx [-c instanceType=t4g.large]
 */
export class AwsopsStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // Context / 컨텍스트
    // -------------------------------------------------------
    const vpcId = this.node.tryGetContext('vpcId') as string | undefined;
    const subnetId = this.node.tryGetContext('subnetId') as string | undefined;
    if (!vpcId || !subnetId) {
      throw new Error('vpcId and subnetId context are required: cdk deploy -c vpcId=vpc-... -c subnetId=subnet-...');
    }
    // t4g.large (8GB): Steampipe's embedded PostgreSQL plus a Next.js build do not fit in 4GB.
    const instanceType = (this.node.tryGetContext('instanceType') as string) || 't4g.large';
    const volumeSizeGb = Number(this.node.tryGetContext('volumeSizeGb') || 60);
    // Read-only role name in target accounts (multi-account code path, optional)
    const crossAccountRoleName = (this.node.tryGetContext('crossAccountRoleName') as string) || 'AWSopsReadOnlyRole';

    const vpc = ec2.Vpc.fromLookup(this, 'VPC', { vpcId });
    const subnet = ec2.Subnet.fromSubnetId(this, 'Subnet', subnetId);

    // -------------------------------------------------------
    // Security group: no inbound at all / 인바운드 없음
    // -------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc,
      securityGroupName: 'awsops-ec2-sg',
      description: 'AWSops EC2 - no inbound, SSM port forwarding only',
      allowAllOutbound: true,
    });

    // -------------------------------------------------------
    // IAM role: SSM + read-only + Bedrock / IAM 롤
    // -------------------------------------------------------
    const role = new iam.Role(this, 'EC2Role', {
      roleName: 'awsops-ec2-role',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        // Steampipe needs read access to every service it queries
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
      description: 'AWSops EC2 role - SSM, ReadOnlyAccess for Steampipe, Bedrock invoke',
    });

    // Bedrock: topology chat (ConverseStream) and AI diagnosis (InvokeModel). Enable model access
    // once in the console before first use.
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/global.*',
        'arn:aws:bedrock:*:*:inference-profile/apac.*',
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
      ],
    }));

    // AI diagnosis report upload (config.reportBucket)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`arn:aws:s3:::awsops-deploy-${this.account}/reports/*`],
    }));

    // Multi-account (optional): assume the read-only role deployed by cfn-target-account-role.yaml
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::*:role/${crossAccountRoleName}`],
    }));

    // -------------------------------------------------------
    // User data: base toolchain only; app install is scripts/01~03
    // 유저 데이터: 기본 툴체인만. 앱 설치는 scripts/01~03
    // -------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'exec > >(tee /var/log/user-data.log) 2>&1',
      'dnf update -y --allowerasing',
      'dnf install -y --allowerasing git curl jq tar gzip unzip python3 python3-pip gcc gcc-c++ make',
      '',
      '# Node.js 20',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'dnf install -y nodejs',
      '',
      '# AWS CLI v2 (arm64)',
      'curl -s "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip',
      'cd /tmp && unzip -q awscliv2.zip && ./aws/install --update && rm -rf aws awscliv2.zip',
      '',
      '# Steampipe binary as root; plugins as ec2-user (scripts/01-install-base.sh re-checks)',
      'curl -fsSL https://steampipe.io/install/steampipe.sh | sh',
      'sudo -u ec2-user steampipe plugin install aws || true',
      '',
      'echo "AWSops base setup completed at $(date)"',
    );

    this.instance = new ec2.Instance(this, 'AWSopsServer', {
      instanceName: 'awsops-server',
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(volumeSizeGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
    });
    cdk.Tags.of(this.instance).add('Name', 'awsops-server');

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instance.instanceId, description: 'EC2 instance ID' });
    new cdk.CfnOutput(this, 'SSMShell', {
      value: `aws ssm start-session --target ${this.instance.instanceId} --region ${this.region}`,
      description: 'Interactive shell via SSM',
    });
    new cdk.CfnOutput(this, 'SSMPortForward', {
      value: `aws ssm start-session --target ${this.instance.instanceId} --region ${this.region} --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000`,
      description: 'Dashboard at http://localhost:3000 after running this',
    });
  }
}
