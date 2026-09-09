# AWSops 대시보드 - 설치 가이드 / AWSops Dashboard - Installation Guide

## 아키텍처 개요 / Architecture Overview

```
Laptop → SSM port forwarding :3000 → EC2 (private subnet, no inbound)
                                        ├─ Next.js :3000
                                        ├─ Steampipe :9193 (AWS plugin)
                                        ├─ Powerpipe (CIS, optional)
                                        └─ Bedrock (direct: topology chat, AI diagnosis)
```

## 대시보드 페이지 (30개) / Dashboard Pages (30 pages)

| 카테고리 / Category | 페이지 / Page | 경로 / Path | 기능 / Features |
|----------|------|------|----------|
| **Overview** | Dashboard | `/` | 20개 StatsCards, 차트, 경고 (20 StatsCards, Charts, Warnings) |
| **Compute** | EC2 | `/ec2` | 인스턴스 + 상세 패널 (Instances + detail panel) |
| | Lambda | `/lambda` | 함수, 런타임, 메모리/타임아웃 (Functions, runtimes, memory/timeout) |
| | ECS | `/ecs` | 클러스터, 서비스, 태스크 (Clusters, services, tasks) |
| | ECR | `/ecr` | 리포지토리, 이미지, 스캔 (Repositories, images, scan) |
| | EKS Overview | `/k8s` | 클러스터, 노드, Pod 요약 (Clusters, nodes, pod summary) |
| | EKS Pods/Nodes/Deploy/Svc | `/k8s/*` | Pod, 노드, Deployment, Service 목록 (4 sub-pages) |
| | EKS Explorer | `/k8s/explorer` | K9s 스타일 터미널 UI (K9s-style terminal UI) |
| **Network & CDN** | VPC / Network | `/vpc` | VPC, Subnet, SG, TGW, ELB, NAT, IGW + 리소스 맵 (Resource Map) |
| | CloudFront | `/cloudfront-cdn` | 배포, Origins, Aliases (Distributions) |
| | WAF | `/waf` | Web ACL, 규칙, IP Sets (Rules, IP Sets) |
| | Topology | `/topology` | 인프라 맵 + K8s 맵 (React Flow) |
| **Storage & DB** | EBS | `/ebs` | 볼륨, 스냅샷, 암호화, EC2 어태치먼트 매핑 (Volumes, Snapshots, encryption, attachment mapping) |
| | S3 | `/s3` | 버킷 TreeMap, 검색, IAM 분석 (TreeMap, search, IAM) |
| | RDS | `/rds` | 인스턴스, SG 체이닝, 메트릭 (SG chaining, metrics) |
| | DynamoDB | `/dynamodb` | 테이블 (Tables) |
| | ElastiCache | `/elasticache` | 클러스터, SG, 메트릭 (Clusters, SG, metrics) |
| | OpenSearch | `/opensearch` | 도메인, 암호화, VPC, 클러스터 구성 (Domains, encryption, VPC, cluster config) |
| | MSK | `/msk` | Kafka 클러스터, 브로커 노드, CPU/메모리/네트워크 메트릭 (Clusters, broker nodes, metrics) |
| **Monitoring** | Monitoring | `/monitoring` | CPU, 메모리, 네트워크, Disk I/O (날짜 범위) |
| | CloudWatch | `/cloudwatch` | 알람 (Alarms) |
| | CloudTrail | `/cloudtrail` | 트레일, 이벤트 (Trails, events) |
| | Cost | `/cost` | 비용 분석, MSP 자동 감지, 스냅샷 폴백 (Cost analysis, MSP auto-detect, snapshot fallback) |
| | Resource Inventory | `/inventory` | 리소스 수량 추이, 비용 영향 추정 (Resource count trends, cost impact estimation) |
| **Security** | IAM | `/iam` | 사용자, 역할, 트러스트 정책 (Users, roles, trust policies) |
| | Security | `/security` | Public S3, Open SG, Unencrypted EBS, CVE |
| | CIS Compliance | `/compliance` | CIS v1.5~v4.0 벤치마크 (431 controls) |

## 사전 요구 사항 / Prerequisites

- 관리자 권한의 AWS 계정 (AWS Account with admin access)
- EC2 인스턴스 (Amazon Linux 2023 arm64, t4g.large+) — `scripts/00-deploy-infra.sh`가 생성 (created by the CDK script)
- Node.js 20+, AWS CLI v2 (user-data가 설치 / installed by user-data)
- Bedrock 모델 접근 활성화 (콘솔, 계정당 1회) (Bedrock model access enabled once in the console)
- AWS 자격 증명 설정 완료 (AWS credentials configured)

---

## 설치 단계 / Installation Steps

### 빠른 설치 (일괄 실행) / Quick Install (All-in-One)

```bash
# 다운로드 후 실행 (Download and run)
bash scripts/install-all.sh   # 01 → 02 → 03 → 11
```

### 또는 아래의 단계별 가이드를 따르세요. / Or follow the step-by-step guide below.
