#!/bin/sh
# 自动备份，在 backup 容器里运行（见 docker-compose.prod.yml）：
# 每天 BACKUP_HOUR 点（北京时间）把数据库和附件备份到 /backups（服务器上仓库根目录的 backups/），
# 保留 BACKUP_KEEP_DAYS 天。失败时写 /backups/last-error，后台「上线检查」会显示出来。
set -u
HOUR=${BACKUP_HOUR:-4}
KEEP=${BACKUP_KEEP_DAYS:-14}
DIR=/backups

log() { echo "$(date '+%F %T') $*"; }

fail() {
  { date '+%F %T'; echo "$1"; cat "$DIR/.err" 2>/dev/null; } > "$DIR/last-error"
  rm -f "$DIR"/*.part "$DIR/.err"
  log "备份失败：$1"
  return 1
}

backup() {
  ts=$(date +%Y%m%d-%H%M%S)
  pg_dump -Fc -f "$DIR/db-$ts.dump.part" 2> "$DIR/.err" || { fail '数据库备份失败'; return 1; }
  mv "$DIR/db-$ts.dump.part" "$DIR/db-$ts.dump"
  tar czf "$DIR/uploads-$ts.tar.gz.part" -C / uploads 2> "$DIR/.err" || { fail '附件备份失败'; return 1; }
  mv "$DIR/uploads-$ts.tar.gz.part" "$DIR/uploads-$ts.tar.gz"
  find "$DIR" -maxdepth 1 \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"$KEEP" -delete
  rm -f "$DIR/last-error" "$DIR/.err"
  log "备份完成：db-$ts.dump（$(du -h "$DIR/db-$ts.dump" | cut -f1)），uploads-$ts.tar.gz（$(du -h "$DIR/uploads-$ts.tar.gz" | cut -f1)）"
}

# docker compose stop 时马上退出，不用等 10 秒
trap 'exit 0' TERM INT

mkdir -p "$DIR"
# 刚启动时最近一天没有备份，先备一份
if [ -z "$(find "$DIR" -maxdepth 1 -name 'db-*.dump' -mtime -1 2>/dev/null)" ]; then
  backup || true
fi

while true; do
  h=$(date +%H | sed 's/^0//'); m=$(date +%M | sed 's/^0//'); s=$(date +%S | sed 's/^0//')
  now=$((h * 3600 + m * 60 + s))
  delay=$(((HOUR * 3600 - now + 86400) % 86400))
  [ "$delay" -lt 60 ] && delay=$((delay + 86400))
  log "下次备份在 $((delay / 3600)) 小时 $((delay % 3600 / 60)) 分钟后"
  sleep "$delay" &
  wait $!
  backup || true
done
