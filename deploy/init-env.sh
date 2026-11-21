#!/usr/bin/env bash
# 服务器上第一次部署时运行一次：从 .env.example 生成 .env，数据库密码、登录密钥、加密密钥、管理员初始密码全部随机生成。
# 用法：deploy/init-env.sh crm.example.com
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "后台的域名（例如 crm.example.com，要先解析到这台服务器）：" DOMAIN
fi
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "域名格式不对：$DOMAIN" >&2
  exit 1
fi
if [ -f .env ]; then
  echo ".env 已经存在，不覆盖。要重新生成，先把它改名备份（注意：ACCOUNT_SECRET_KEY 换了就解不开已保存的账号密码）" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }

PG_PASS="$(openssl rand -hex 16)"
JWT="$(openssl rand -hex 32)"
KEY="$(openssl rand -hex 32)"
ADMIN_PASS="Crm-$(openssl rand -hex 5)"

sed \
  -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$PG_PASS#" \
  -e "s#crm_local_password#$PG_PASS#g" \
  -e "s#^JWT_ACCESS_SECRET=.*#JWT_ACCESS_SECRET=$JWT#" \
  -e "s#^ACCOUNT_SECRET_KEY=.*#ACCOUNT_SECRET_KEY=$KEY#" \
  -e "s#^SEED_ADMIN_PASSWORD=.*#SEED_ADMIN_PASSWORD=$ADMIN_PASS#" \
  -e "s#^APP_PUBLIC_URL=.*#APP_PUBLIC_URL=https://$DOMAIN#" \
  -e "s#^API_DOCS=.*#API_DOCS=off#" \
  .env.example > .env
cat >> .env <<EOT

# ───── 上云（deploy/init-env.sh 生成） ─────
# docker compose 自动带上上云的覆盖配置（HTTPS、自动备份、关闭对外端口）
COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml
DOMAIN=$DOMAIN
# 每天几点自动备份（北京时间），保留几天
BACKUP_HOUR=4
BACKUP_KEEP_DAYS=14
EOT
chmod 600 .env

cat <<EOT
已生成 .env。下面两项请马上抄到安全的地方（密码管理器 / 纸上），只显示这一次：

  管理员初始密码：admin / $ADMIN_PASS   （第一次登录会要求改掉）
  ACCOUNT_SECRET_KEY：$KEY
                      （加密 Claude 账号密码用的密钥。服务器坏了要靠它和备份一起恢复，丢了就再也解不开）

下一步：docker compose up -d --build
EOT
