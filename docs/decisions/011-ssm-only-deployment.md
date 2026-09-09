# ADR-011: SSM-Only Deployment (No ALB, No Cognito) / SSM 전용 배포

## Status: Accepted (2026-09-09) / 상태: 승인됨

## Context / 컨텍스트

The upstream deployment fronted the EC2 with an ALB (HTTPS via ACM, Route 53 alias) and authenticated users with
the ALB's `authenticate-cognito` action (ADR-009). That made sense for a team-facing internal tool.

This fork is a single-user portfolio project against one AWS account (PLick, ap-northeast-2). An ALB, a custom
domain, a certificate, and a Cognito user pool add standing cost and setup steps but protect nothing that a
private subnet does not already protect.

업스트림은 ALB(ACM, Route 53) 뒤에 EC2를 두고 ALB의 `authenticate-cognito`로 인증했다(ADR-009).
이 포크는 계정 하나에 사용자 한 명인 포트폴리오 프로젝트라 ALB, 도메인, 인증서, Cognito가 비용과 절차만 늘린다.

## Decision / 결정

- The EC2 lives in an existing private subnet with **no inbound security-group rule**.
- Access is **SSM Session Manager only**: a shell via `start-session`, the dashboard via
  `AWS-StartPortForwardingSession` on port 3000.
- No application-level authentication. `auth-utils` falls back to `anonymous`; `AWSOPS_SINGLE_USER=true`
  (or `config.singleUser`) makes `isSingleUser()` bypass `adminEmails` gating in `/api/steampipe` and `/api/datasources`.
- The CDK stack is reduced to EC2 + IAM role + security group. VPC and subnet are injected with
  `-c vpcId -c subnetId`. The instance role carries `ReadOnlyAccess`, `AmazonSSMManagedInstanceCore`, and
  inline `bedrock:InvokeModel*` / `bedrock:Converse*`.
- The instance is stopped when not in use.

```
Laptop ── aws ssm start-session (port forward 3000) ──► EC2 (private subnet, SG inbound: none)
                                                         Next.js :3000 · Steampipe :9193
```

## Consequences / 결과

| Area | Effect |
|---|---|
| Security boundary | IAM permission to call `ssm:StartSession` on the instance. No network path otherwise |
| Cost | instance + EBS only; nothing when stopped |
| Setup | `scripts/00-deploy-infra.sh` is non-interactive (VPC_ID, SUBNET_ID env). Bedrock model access is a one-time console step |
| Removed | ALB, ACM, Route 53, Cognito, `05-setup-cognito.sh`, ALB session logout logic is dormant (`/api/auth` stays but is unused) |
| Trade-off | Cannot share a URL with someone without AWS credentials for the account. Acceptable for a portfolio; screenshots and fixtures cover demos |

## Alternatives Considered / 검토한 대안

1. **Keep ALB + Cognito** — rejected: monthly ALB cost and domain/cert maintenance for one user.
2. **Public EC2 with an IP allowlist** — rejected: still exposes port 3000 to the internet and needs a public subnet.
3. **Tailscale / WireGuard** — rejected: extra daemon to maintain; SSM is already required for shell access.
