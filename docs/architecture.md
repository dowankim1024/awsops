# Architecture

## System Overview
AWSops Dashboard is an AWS operations dashboard (Steampipe + Next.js 14) extended with a 3D infrastructure topology view.
Data comes from Steampipe's embedded PostgreSQL; AI features call Amazon Bedrock directly (topology chat, AI diagnosis).
The fork runs against a single account and is reached only through SSM port forwarding.

## Components

### Frontend (`src/app/`, `src/components/`)
- **Framework**: Next.js 14 App Router, no `basePath` (served at `/`)
- **Styling**: Tailwind CSS dark navy theme
- **Charts / graphs**: Recharts, React Flow (legacy topology), React Three Fiber v8 (3D topology, `ssr: false`)
- **Pages**: 38 resource pages (EC2, EBS, S3, VPC, IAM, Lambda, RDS, ECS, MSK, OpenSearch, Inventory, Datasources, AI Diagnosis, Topology …)
- i18n ko/en/zh, multi-account selector (single account in this deployment)

### Data Layer (`src/lib/`)
- **Steampipe**: embedded PostgreSQL on 9193, AWS plugin. Managed by `steampipe.service` (Restart=always)
- **Connection**: pg Pool (max 10, 30s statement timeout, 40s client-side hard timeout, batches of 5)
- **Cache**: node-cache, 5-minute TTL, accountId-prefixed keys; `cache-warmer.ts` pre-warms dashboard queries every 4 min
- **Queries**: `src/lib/queries/` (`relationships.ts` feeds both topology views)
- **Config**: `data/config.json` via `app-config.ts` (`singleUser`, `topology3d`, `accounts[]`, `costEnabled`)

### 3D Topology (`src/lib/topology/`, `src/components/topology3d/`)
- `types.ts` — `TopologyGraph` contract (vpcs, subnets, nodes, edges). The renderer consumes this only
- `adapters/` — live (Steampipe rows), fixture (JSON), generator (seeded PRNG presets up to 1,000 EC2)
- `filter.ts` — pure `applyFilter` / `mergeFilter` / URL (de)serialization shared by checkboxes, URL, and chat
- `layout3d.ts` — pure layout: VPC floor → AZ lanes (X) → tier (Z) → subnet platforms → node grids; clustering above a threshold
- Renderer: per-kind `InstancedMesh`, one `LineSegments` for edges, capped labels, `frameloop="demand"`

### AI (direct Bedrock)
- `POST /api/topology-chat` — legacy FossFLOW view edits
- `POST /api/topology3d-chat` — filter patches via `ConverseStream` + `toolConfig` (`set_filter`, `answer`); prompt = schema + current filter + graph summary
- `POST /api/report` — 15-section diagnosis, DOCX/MD/PDF export, optional scheduling

### Access
- No auth layer. `auth-utils` yields `anonymous`; `AWSOPS_SINGLE_USER=true` bypasses `adminEmails` gating
- SSM Session Manager for shell and port forwarding (ADR-011)

## Data Flow
1. Page load → client fetch `POST /api/steampipe` with named queries
2. pg Pool → Steampipe → AWS APIs; results cached 5 min
3. Topology: rows → adapter → `TopologyGraph` → `applyFilter` → `layout3d` → scene
4. Chat: message → `/api/topology3d-chat` → Bedrock tool call → validated filter patch → same `applyFilter` path

## Infrastructure
- EC2 t4g.large (arm64) in an existing private subnet, no inbound rule, NAT egress
- Instance role: `ReadOnlyAccess`, `AmazonSSMManagedInstanceCore`, Bedrock invoke/converse, S3 report bucket
- CDK: `infra-cdk/lib/awsops-stack.ts` (EC2 + role + SG), context `vpcId`, `subnetId`, `instanceType`

## Deployment

| Step | Script | Description |
|---|---|---|
| 0 | `00-deploy-infra.sh` | CDK deploy (local; `VPC_ID`, `SUBNET_ID`) |
| 1 | `01-install-base.sh` | Steampipe + Powerpipe |
| 2 | `02-setup-nextjs.sh` | npm install, Steampipe service, config |
| 3 | `03-build-deploy.sh` | Production build + start |
| 9 / 10 | `09-start-all.sh` / `10-stop-all.sh` | Start / stop (systemctl-aware, prints SSM port-forward command) |
| 11 | `11-verify.sh` | Health check |
| 13 | `13-setup-steampipe-systemd.sh` | Steampipe systemd unit |

See `scripts/ARCHITECTURE.md` for diagrams and `docs/decisions/` for ADRs (009 superseded by 011).
