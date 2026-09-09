# AWSops Dashboard - Architecture

## 1. Deployment / 배포 형태

```
Laptop ── aws ssm start-session (port forward 3000) ──► EC2 awsops-server
                                                         private subnet, SG inbound: none
                                                         ├─ Next.js :3000   (production build)
                                                         ├─ Steampipe :9193 (embedded PostgreSQL, aws plugin)
                                                         └─ Powerpipe       (CIS benchmark, optional)
                                                         instance role: ReadOnlyAccess + SSM + Bedrock Invoke/Converse
```

| Item | Value |
|---|---|
| Instance | t4g.large (arm64, 8GB), Amazon Linux 2023, gp3 60GB encrypted |
| Network | existing VPC private subnet, NAT egress only, no inbound rule |
| Access | SSM Session Manager (shell) and SSM port forwarding (dashboard) |
| Auth | none. `AWSOPS_SINGLE_USER=true` bypasses `adminEmails` gating |
| IaC | `infra-cdk/lib/awsops-stack.ts` — EC2 + IAM role + SG, `-c vpcId -c subnetId` |

Why no ALB/Cognito: single user, private access, zero standing cost beyond the instance. See `docs/decisions/011-ssm-only-deployment.md`.

## 2. Data Flow (Dashboard)

```
Browser ──► Next.js  POST /api/steampipe  {queries}
                │  batchQuery(): pg Pool (max 10), 5 sequential, 30s stmt timeout, 40s hard timeout
                │  node-cache 5 min (key prefixed by accountId)
                ▼
            Steampipe :9193 ──► AWS APIs (read-only)
```

`cache-warmer.ts` pre-warms the dashboard queries every 4 minutes so the first page after boot is fast.

## 3. 3D Topology Flow

```
Steampipe rows (relationships.ts, 18 queries) ─┐
Fixture JSON (upload / bundled)                ┼─► adapter ─► TopologyGraph ─► applyFilter ─► layout3d ─► R3F Scene
Generator (seeded PRNG, presets)               ┘                                 ▲
                                                                                  │  Partial<TopologyFilter>
                                              FilterPanel ─── URL params ─── ChatPanel ◄── /api/topology3d-chat
                                                                                              Bedrock ConverseStream
                                                                                              tools: set_filter, answer
```

- The renderer consumes `TopologyGraph` only; it never sees Steampipe.
- `applyFilter` is pure. Removing a node removes its edges; empty subnets go unless `includeEmptySubnets`.
- Chat prompt = filter schema + current filter + graph summary (VPCs, AZs, counts per kind). The server validates the patch with `mergeFilter` before returning it.
- Rendering: one `InstancedMesh` per node kind, one `LineSegments` for all edges, label cap with distance culling, `frameloop="demand"`.

## 4. AI (direct Bedrock)

| Route | Purpose | Model |
|---|---|---|
| `POST /api/topology-chat` | FossFLOW view edits (legacy Topology View) | `global.anthropic.claude-opus-4-8` |
| `POST /api/topology3d-chat` | 3D filter patches (Phase 4) | `config.topology3d.chatModelId` |
| `POST /api/report` | 15-section diagnosis, DOCX/PDF | `global.anthropic.claude-opus-4-8` |

Enable Anthropic model access once in the Bedrock console. The instance role allows `bedrock:InvokeModel*` and `bedrock:Converse*` on `global.*`/`apac.*` inference profiles.

## 5. CIS Compliance Flow

```
/compliance ──► /api/benchmark ──► powerpipe benchmark run (powerpipe/) ──► Steampipe ──► AWS
```

## 6. Installation

```
Step 0:  00-deploy-infra.sh             CDK: EC2 + role + SG (run locally, VPC_ID/SUBNET_ID env)
Step 1:  01-install-base.sh             Steampipe + plugins + Powerpipe
Step 2:  02-setup-nextjs.sh             npm install, Steampipe service, data/config.json
Step 3:  03-build-deploy.sh             next build + start
Step 9:  09-start-all.sh                start services, print SSM port-forward command
Step 10: 10-stop-all.sh                 stop services
Step 11: 11-verify.sh                   health check
Step 13: 13-setup-steampipe-systemd.sh  steampipe.service (Restart=always)
install-all.sh = 1 → 2 → 3 → 11
```

## 7. Port Map

| Port | Service | Exposure |
|---|---|---|
| 3000 | Next.js | localhost on EC2; laptop via SSM port forwarding |
| 9193 | Steampipe PostgreSQL | localhost only |

## 8. AWS Services Used

| Service | Purpose |
|---|---|
| EC2, EBS | host |
| IAM | instance role (ReadOnlyAccess, SSM, Bedrock, S3 reports, optional cross-account AssumeRole) |
| SSM Session Manager | shell + port forwarding |
| Bedrock | topology chat, AI diagnosis |
| S3 | diagnosis report storage (optional, `config.reportBucket`) |
| CloudFormation (CDK) | AwsopsStack |
| Everything Steampipe reads | read-only via the aws plugin |
