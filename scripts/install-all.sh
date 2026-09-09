#!/bin/bash
set -e
################################################################################
#                                                                              #
#   AWSops Dashboard - Full Installation                                       #
#   EC2 + Steampipe + Next.js + Powerpipe                                      #
#                                                                              #
#   Usage:                                                                     #
#     bash scripts/install-all.sh                                              #
#                                                                              #
#   Runs: Step 1 -> Step 2 -> Step 3 -> Step 11 (verify)                       #
#   Optional: Step 13 (Steampipe systemd unit)                                 #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$WORK_DIR"

# -- Step overview -------------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops Dashboard - Full Installation${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  Region:     $REGION"
echo "  Account:    $ACCOUNT_ID"
echo "  Work Dir:   $WORK_DIR"
echo ""
echo "  Steps to run:"
echo "    [1/4] Steampipe + Plugins + Powerpipe     (01-install-base.sh)"
echo "    [2/4] Next.js + Steampipe Service          (02-setup-nextjs.sh)"
echo "    [3/4] Production Build + Deploy            (03-build-deploy.sh)"
echo "    [4/4] Verification                         (11-verify.sh)"
echo ""
echo "  선택 단계 / Optional:"
echo "    Step 13: Steampipe systemd 유닛     (13-setup-steampipe-systemd.sh)"
echo ""
echo "  운영 스크립트 / Operations:"
echo "    bash scripts/09-start-all.sh       # 서비스 시작 / Start services"
echo "    bash scripts/10-stop-all.sh        # 서비스 중지 / Stop services"
echo "    bash scripts/11-verify.sh          # 검증 (46항목) / Health check"
echo ""

# -- Detect environment --------------------------------------------------------
IS_EC2=false
if curl -s --max-time 2 http://169.254.169.254/latest/meta-data/instance-id &>/dev/null; then
    IS_EC2=true
fi

if [ "$IS_EC2" = true ]; then
    echo -e "${GREEN}[ENV] Running on EC2 instance. Proceeding with Steps 1-3 + verify.${NC}"
    echo ""
    read -p "Continue? (y/n) " -n 1 -r
    echo ""
    [[ $REPLY =~ ^[Yy]$ ]] || exit 0

    echo ""
    echo -e "${CYAN}[1/4] Installing Steampipe + Powerpipe...${NC}"
    echo "--------------------------------------------------------------"
    bash "$SCRIPT_DIR/01-install-base.sh"

    echo ""
    echo -e "${CYAN}[2/4] Setting up Next.js + Steampipe Service...${NC}"
    echo "--------------------------------------------------------------"
    bash "$SCRIPT_DIR/02-setup-nextjs.sh"

    echo ""
    echo -e "${CYAN}[3/4] Building and deploying production...${NC}"
    echo "--------------------------------------------------------------"
    bash "$SCRIPT_DIR/03-build-deploy.sh"

    echo ""
    echo -e "${CYAN}[4/4] Running verification...${NC}"
    echo "--------------------------------------------------------------"
    bash "$SCRIPT_DIR/11-verify.sh"
else
    echo -e "${YELLOW}[ENV] Not running on EC2. Deploy infrastructure first:${NC}"
    echo ""
    echo "  # Step 0: Deploy EC2 (from local machine)"
    echo "  export VSCODE_PASSWORD='YourPassword'"
    echo "  export VPC_ID=vpc-xxxx SUBNET_ID=subnet-xxxx   # private subnet with NAT egress"
    echo "  bash scripts/00-deploy-infra.sh"
    echo ""
    echo "  # Then SSM into the instance and run:"
    echo "  aws ssm start-session --target <INSTANCE_ID>"
    echo "  cd /home/ec2-user/awsops && bash scripts/install-all.sh"
    exit 0
fi

# -- Final summary -------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Installation Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  Dashboard:  http://localhost:3000 (via SSM port forwarding from your laptop)"
echo ""
echo "  Services running on this EC2 instance:"
echo "    - Steampipe (embedded PostgreSQL, port 9193)"
echo "    - Next.js   (production server, port 3000)"
echo "    - Powerpipe (CIS benchmark CLI)"
echo ""

echo "  다음 단계 / Next steps:"
echo "    bash scripts/13-setup-steampipe-systemd.sh       # Steampipe systemd (Restart=always)"
echo "    bash scripts/09-start-all.sh                     # 서비스 시작 + SSM 포트 포워딩 안내"
echo ""
