# AWSops 인프라 CDK / AWSops Infrastructure CDK

EC2 한 대 + IAM 롤 + 보안 그룹. ALB, ACM, Route 53, Cognito는 없다.
인스턴스는 기존 VPC의 프라이빗 서브넷에 두고 SSM 포트 포워딩으로만 접속한다 (`docs/decisions/011-ssm-only-deployment.md`).

One EC2 instance + IAM role + security group. No ALB, ACM, Route 53, or Cognito.
The instance lives in an existing private subnet and is reached only via SSM port forwarding.

## 리소스 / Resources

| 리소스 | 값 |
|---|---|
| EC2 | `t4g.large` (arm64, 8GB), Amazon Linux 2023, gp3 60GB 암호화 |
| IAM 롤 | `AmazonSSMManagedInstanceCore` + `ReadOnlyAccess` + Bedrock `InvokeModel*`/`Converse*` + S3 리포트 버킷 + (선택) 교차 계정 AssumeRole |
| 보안 그룹 | 인바운드 없음, 아웃바운드 전체 (NAT 경유) |

## 배포 / Deploy

```bash
cd infra-cdk && npm install
npx cdk bootstrap                     # 계정 최초 1회 / first time per account
npx cdk deploy -c vpcId=vpc-xxxx -c subnetId=subnet-xxxx
# 옵션 / options: -c instanceType=t4g.large -c volumeSizeGb=60 -c crossAccountRoleName=AWSopsReadOnlyRole
```

또는 `bash scripts/00-deploy-infra.sh` (환경변수 `VPC_ID`, `SUBNET_ID`).

## 접속 / Access

```bash
# 셸 / shell
aws ssm start-session --target <INSTANCE_ID>
# 대시보드 / dashboard → http://localhost:3000
aws ssm start-session --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=3000,localPortNumber=3000
```

서브넷에서 SSM 엔드포인트(NAT 또는 VPC 엔드포인트)에 닿아야 한다. Bedrock 모델 접근은 콘솔에서 계정당 1회 활성화한다.

## 멀티 어카운트 (선택) / Multi-account (optional)

대상 계정에 `cfn-target-account-role.yaml`을 배포하면 `sts:AssumeRole`로 조회할 수 있다. 기본 운용은 단일 계정이다.

## 정리 / Cleanup

```bash
npx cdk destroy
```
