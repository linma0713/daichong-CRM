#!/usr/bin/env bash
# 从备份恢复数据库和附件。会覆盖现在的数据！恢复前自动把现在的数据备份到 backups/before-restore-时间/。
# 用法：scripts/restore.sh backups/db-xxx.dump [backups/uploads-xxx.tar.gz]
# 用途：搬家（本机 → 云服务器）、误操作后回到某一天。旧版本的备份也能恢复，后端启动时会自动升级数据库结构。
set -euo pipefail
cd "$(dirname "$0")/.."

DB_FILE="${1:-}"
UP_FILE="${2:-}"
if [ -z "$DB_FILE" ] || [ ! -f "$DB_FILE" ]; then
  echo "用法：scripts/restore.sh <db-xxx.dump> [uploads-xxx.tar.gz]" >&2
  exit 1
fi
if [ -n "$UP_FILE" ] && [ ! -f "$UP_FILE" ]; then
  echo "找不到附件备份 $UP_FILE" >&2
  exit 1
fi
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true; }
PGUSER="$(env_get POSTGRES_USER)"; PGUSER="${PGUSER:-crm}"
PGDB="$(env_get POSTGRES_DB)"; PGDB="${PGDB:-crm}"

echo "将用 $DB_FILE 覆盖现在的数据库${UP_FILE:+，用 $UP_FILE 覆盖现在的附件}。"
if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  read -rp "确认恢复请输入 yes：" answer
  [ "$answer" = "yes" ] || { echo "已取消"; exit 1; }
fi

docker compose up -d postgres
scripts/backup.sh "backups/before-restore-$(TZ=CST-8 date +%Y%m%d-%H%M%S)"

echo "停止后端…"
docker compose stop api
echo "恢复数据库…"
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$PGDB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$PGDB\" OWNER \"$PGUSER\";"
docker compose exec -T postgres pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --no-privileges < "$DB_FILE"

if [ -n "$UP_FILE" ]; then
  echo "恢复附件…"
  docker compose run --rm --no-deps -T --entrypoint sh api \
    -c 'find /app/uploads -mindepth 1 -delete && tar xzf - -C /app' < "$UP_FILE"
fi

echo "启动后端（会自动把数据库升级到当前版本）…"
docker compose up -d api
scripts/wait-healthy.sh
echo "恢复完成。"
