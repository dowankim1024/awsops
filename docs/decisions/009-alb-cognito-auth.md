# ADR-009: ALB Cognito Auth Instead of CloudFront + Lambda@Edge / CloudFront 대신 ALB Cognito 인증

## Status: Superseded by ADR-011 / 상태: ADR-011로 대체됨

> Kept for history. This fork runs without an ALB or Cognito at all (SSM port forwarding only).
> 이력 보존용. 이 포크는 ALB와 Cognito를 쓰지 않는다 (SSM 포트 포워딩 전용).

## Context / 컨텍스트

The original architecture put CloudFront in front of the ALB and handled authentication with a
Lambda@Edge function (Python 3.12, us-east-1) that validated Cognito JWTs on the viewer request.

기존 아키텍처는 ALB 앞에 CloudFront를 두고, viewer request에서 Cognito JWT를 검증하는
Lambda@Edge(Python 3.12, us-east-1)로 인증을 처리했다.

When deploying to the original org account, `cdk deploy` failed:

```
User: arn:aws:sts::<ACCOUNT_ID>:assumed-role/cdk-hnb659fds-cfn-exec-role-.../AWSCloudFormation
is not authorized to perform: cloudfront:CreateDistribution
with an explicit deny in a service control policy
```

The organization's SCP denies CloudFront distribution creation. SCPs are evaluated
above account-level IAM, so this cannot be worked around with permissions — even AdministratorAccess
is blocked. CloudFront is off the table in this account.

조직 SCP가 CloudFront 배포 생성을 명시적으로 거부한다. SCP는 계정 IAM보다 상위에서 평가되므로
AdministratorAccess로도 우회 불가하다.

## Decision / 결정

Remove CloudFront entirely. Terminate TLS at the ALB and use the ALB's built-in
`authenticate-cognito` listener action instead of Lambda@Edge.

CloudFront를 제거하고 ALB에서 TLS를 종료한다. Lambda@Edge 대신 ALB 내장
`authenticate-cognito` 리스너 액션으로 인증한다.

```
Route 53 (awsops.example.com)
  └─ ALB :443  (ACM cert, ap-northeast-2 — regional, not us-east-1)
       ├─ authenticate-cognito  ← auth happens here
       ├─ default        → Dashboard  (EC2 :3000)
       ├─ /vscode*       → nginx      (EC2 :8889 → code-server :8888)
       └─ /awsops*       → 301 redirect to / (legacy path)
```

### Consequences / 결과

| Area | Before | After |
|---|---|---|
| TLS cert | ACM in **us-east-1** (CloudFront requirement) | ACM in **ap-northeast-2** (same region as ALB) |
| Auth mechanism | Lambda@Edge validates JWT | ALB `authenticate-cognito` action |
| User identity in app | `awsops_token` cookie | `x-amzn-oidc-data` header (`src/lib/auth-utils.ts` reads both) |
| Cognito callback | `/awsops/_callback` (custom) | `/oauth2/idpresponse` (**fixed** — ALB requires this path) |
| CDN caching | CloudFront edge cache | none (internal tool, no benefit lost) |
| Setup step 8 | `08-setup-cloudfront-auth.sh` | deprecated no-op; auth attached in step 5 |

### Trade-offs / 트레이드오프

- **Auth session is owned by the ALB.** Logging out means expiring the ALB's
  `AWSELBAuthSessionCookie-*` cookies *and* ending the Cognito session — clearing the app cookie
  alone does nothing. See `src/app/api/auth/route.ts`.
- **A custom domain is now mandatory.** The ALB needs an HTTPS listener with a real certificate,
  so `-c customDomain=...` is required (the stack throws without it). Previously the CloudFront
  default domain was usable.
- **`authenticate-cognito` is not managed by CDK here.** Step 5 attaches it via CLI after deploy,
  so a `cdk deploy` that rewrites the 443 listener drops it and it must be re-attached. See the
  deployment runbook.

## Alternatives Considered / 검토한 대안

1. **Request an SCP exception for CloudFront** — rejected for this PoC: turnaround time is
   uncertain and the org appears to block CloudFront deliberately (central CDN governance).
2. **Keep Lambda@Edge, drop CloudFront** — not possible; Lambda@Edge only runs on CloudFront.
3. **Self-hosted auth proxy (oauth2-proxy) on EC2** — more moving parts than the ALB's native
   action, with no benefit for this use case.
