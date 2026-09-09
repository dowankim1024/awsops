#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 0: Deploy infrastructure (run from your laptop)                       #
#   EC2 + IAM role + SG in an existing private subnet. No ALB / no Cognito.    #
#                                                                              #
#   Usage:                                                                     #
#     VPC_ID=vpc-xxxx SUBNET_ID=subnet-xxxx bash scripts/00-deploy-infra.sh    #
#   Optional env: INSTANCE_TYPE (t4g.large), VOLUME_SIZE_GB (60), AWS_REGION   #
#                                                                              #
#   Re-running the script applies stack changes in place (cdk deploy).         #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/../infra-cdk" && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo 'ap-northeast-2')}}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.large}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-60}"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops - Step 0: Deploy EC2 (CDK)${NC}"
echo -e "${CYAN}=================================================================${NC}"

# -- [1/4] Pre-flight ----------------------------------------------------------
echo -e "${CYAN}[1/4] Pre-flight checks...${NC}"
for cmd in aws node npm; do
    command -v "$cmd" &>/dev/null || { echo -e "  ${RED}$cmd not found${NC}"; exit 1; }
done
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
    || { echo -e "  ${RED}AWS credentials not configured${NC}"; exit 1; }
[ -n "$VPC_ID" ] && [ -n "$SUBNET_ID" ] \
    || { echo -e "  ${RED}VPC_ID and SUBNET_ID are required${NC}"; echo "  e.g. VPC_ID=vpc-xxxx SUBNET_ID=subnet-xxxx bash scripts/00-deploy-infra.sh"; exit 1; }

SUBNET_VPC=$(aws ec2 describe-subnets --subnet-ids "$SUBNET_ID" --region "$REGION" \
    --query 'Subnets[0].VpcId' --output text 2>/dev/null || echo "")
[ "$SUBNET_VPC" = "$VPC_ID" ] || { echo -e "  ${RED}$SUBNET_ID is not in $VPC_ID (found: ${SUBNET_VPC:-none})${NC}"; exit 1; }

echo "  Account:   $ACCOUNT_ID"
echo "  Region:    $REGION"
echo "  VPC:       $VPC_ID"
echo "  Subnet:    $SUBNET_ID  (must be private with NAT egress for SSM + package installs)"
echo "  Instance:  $INSTANCE_TYPE / gp3 ${VOLUME_SIZE_GB}GB"

# -- [2/4] CDK deps ------------------------------------------------------------
echo ""
echo -e "${CYAN}[2/4] Installing CDK dependencies...${NC}"
cd "$CDK_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
echo "  cdk $(npx cdk --version)"

# -- [3/4] Bootstrap (idempotent) ----------------------------------------------
echo ""
echo -e "${CYAN}[3/4] Bootstrapping CDK (skips if already done)...${NC}"
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" &>/dev/null; then
    npx cdk bootstrap "aws://$ACCOUNT_ID/$REGION"
else
    echo "  CDKToolkit already present"
fi

# -- [4/4] Deploy --------------------------------------------------------------
echo ""
echo -e "${CYAN}[4/4] Deploying AwsopsStack...${NC}"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" CDK_DEFAULT_REGION="$REGION"
npx cdk deploy AwsopsStack --require-approval never \
    -c vpcId="$VPC_ID" -c subnetId="$SUBNET_ID" \
    -c instanceType="$INSTANCE_TYPE" -c volumeSizeGb="$VOLUME_SIZE_GB"

INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name AwsopsStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" --output text 2>/dev/null || echo "<INSTANCE_ID>")

echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Deployed. Next steps${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo "  1. Enable Bedrock model access once in the console (Anthropic Claude)."
echo "  2. Wait ~3 min for user-data, then open a shell:"
echo "       aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "  3. On the instance:"
echo "       git clone <this repo> ~/awsops && cd ~/awsops && bash scripts/install-all.sh"
echo "  4. From your laptop, forward the dashboard port:"
echo "       aws ssm start-session --target $INSTANCE_ID --region $REGION \\"
echo "         --document-name AWS-StartPortForwardingSession \\"
echo "         --parameters portNumber=3000,localPortNumber=3000"
echo "       open http://localhost:3000"
echo ""
