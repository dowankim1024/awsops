#!/bin/bash
set -e
################################################################################
#                                                                              #
#   AWSops Dashboard - Start All Services                                      #
#                                                                              #
#   Starts:                                                                    #
#     1. Steampipe service (embedded PostgreSQL, port 9193)                    #
#     2. Next.js production server (port 3000)                                 #
#                                                                              #
#   Shows:                                                                     #
#     - Service status check                                                   #
#     - Access via SSM port forwarding (no ALB / no auth)                      #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops Dashboard - Start All Services${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

# -- [1/2] Steampipe service ---------------------------------------------------
# Prefer the systemd unit when installed (scripts/13-setup-steampipe-systemd.sh)
# so processes stay under systemd supervision (Restart=always).
echo -e "${CYAN}[1/2] Starting Steampipe service (port 9193)...${NC}"
if [ -f /etc/systemd/system/steampipe.service ]; then
    sudo systemctl start steampipe.service
    echo -e "  ${GREEN}Started via systemd (steampipe.service)${NC}"
elif steampipe service status 2>&1 | grep -q "running"; then
    echo -e "  ${GREEN}Already running${NC}"
else
    steampipe service stop --force 2>/dev/null || true
    sleep 2
    # Pass the app's password so config.json and the DB stay in sync
    SP_PW=$(python3 -c "import json; print(json.load(open('$WORK_DIR/data/config.json')).get('steampipePassword',''))" 2>/dev/null || echo "")
    if [ -n "$SP_PW" ]; then
        steampipe service start --database-listen network --database-port 9193 --database-password "$SP_PW"
    else
        steampipe service start --database-listen network --database-port 9193
    fi
    echo -e "  ${GREEN}Started${NC}"
fi

# -- [2/2] Next.js server -----------------------------------------------------
# Prefer the systemd unit (awsops.service, Restart=always) over nohup — a nohup'd
# process dies silently and nothing restarts it (see known incident 2026-04-02).
echo ""
echo -e "${CYAN}[2/2] Starting Next.js production server (port 3000)...${NC}"

if [ -f /etc/systemd/system/awsops.service ]; then
    sudo systemctl restart awsops.service
    sleep 3
    echo -e "  ${GREEN}Started via systemd (awsops.service)${NC}"
else
    # Kill existing process on port 3000
    fuser -k 3000/tcp 2>/dev/null || true
    sleep 1

    cd "$WORK_DIR"
    nohup sh -c "PORT=3000 npm run start" > /tmp/awsops-server.log 2>&1 &
    sleep 3
    echo -e "  ${GREEN}Started (log: /tmp/awsops-server.log)${NC}"
fi

# -- Service status check ------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Service Status${NC}"
echo -e "${CYAN}=================================================================${NC}"

# Steampipe
if steampipe service status 2>&1 | grep -q "running"; then
    SP_PW=$(steampipe service status --show-password 2>&1 | grep Password | awk '{print $2}')
    echo -e "  ${GREEN}OK${NC}  Steampipe          port 9193  (pw: ${SP_PW:0:4}****)"
else
    echo -e "  ${RED}FAIL${NC}  Steampipe          NOT RUNNING"
fi

# Next.js
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/awsops 2>/dev/null)
if [ "$HTTP" = "200" ]; then
    echo -e "  ${GREEN}OK${NC}  Next.js            port 3000  (HTTP 200)"
else
    echo -e "  ${RED}FAIL${NC}  Next.js            NOT RUNNING (HTTP $HTTP)"
fi

# Steampipe API via Next.js
API=$(curl -s --max-time 5 -X POST http://localhost:3000/awsops/api/steampipe \
    -H "Content-Type: application/json" \
    -d '{"queries":{"t":"SELECT 1 as ok"}}' 2>/dev/null)
if echo "$API" | grep -q "ok"; then
    echo -e "  ${GREEN}OK${NC}  Steampipe API      working"
else
    echo -e "  ${RED}FAIL${NC}  Steampipe API      NOT responding"
fi

# -- Access ------------------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Access${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo "  Local (on EC2):  http://localhost:3000"
echo ""
echo "  From your laptop (SSM port forwarding, no inbound rule needed):"
INSTANCE_ID=$(curl -s --max-time 2 http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "<INSTANCE_ID>")
echo "    aws ssm start-session --target $INSTANCE_ID --region $REGION \\"
echo "      --document-name AWS-StartPortForwardingSession \\"
echo "      --parameters portNumber=3000,localPortNumber=3000"
echo "    open http://localhost:3000"
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo ""
