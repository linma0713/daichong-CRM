#!/usr/bin/env bash
# 等后端启动好（最多 5 分钟）
set -euo pipefail
cd "$(dirname "$0")/.."
for _ in $(seq 1 60); do
  if docker compose exec -T api node -e \
    "fetch('http://localhost:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo "后端已就绪"
    exit 0
  fi
  sleep 5
done
echo "后端 5 分钟内没有启动成功，请看日志：docker compose logs --tail 100 api" >&2
exit 1
