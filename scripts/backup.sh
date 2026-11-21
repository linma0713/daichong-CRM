#!/usr/bin/env bash
# 手动备份数据库和附件（本机和服务器都能用，要在 docker compose 跑着的时候执行）。
# 用法：scripts/backup.sh [输出目录，默认 backups]
# 得到两个文件：db-时间.dump（数据库）和 uploads-时间.tar.gz（附件），恢复用 scripts/restore.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-backups}"
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true; }
PGUSER="$(env_get POSTGRES_USER)"; PGUSER="${PGUSER:-crm}"
PGDB="$(env_get POSTGRES_DB)"; PGDB="${PGDB:-crm}"
# 文件名用北京时间，和服务器上自动备份的一致
TS="$(TZ=CST-8 date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"
echo "备份数据库 → $OUT/db-$TS.dump"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$OUT/db-$TS.dump.part"
mv "$OUT/db-$TS.dump.part" "$OUT/db-$TS.dump"

echo "备份附件 → $OUT/uploads-$TS.tar.gz"
# 用一个临时的后端容器读附件卷，后端停着也能备份
docker compose run --rm --no-deps -T --entrypoint tar api czf - -C /app uploads \
  > "$OUT/uploads-$TS.tar.gz.part"
mv "$OUT/uploads-$TS.tar.gz.part" "$OUT/uploads-$TS.tar.gz"

ls -lh "$OUT/db-$TS.dump" "$OUT/uploads-$TS.tar.gz"
echo "备份完成。请把这两个文件另外拷一份到别的地方（网盘、另一台电脑）。"
