#!/usr/bin/env bash
# 升级到最新版本（本机和服务器都能用）：备份 → 拉最新代码 → 重新构建并启动 → 等后端就绪。
# 数据库结构在后端启动时自动升级；升级出问题可以用 backups/before-upgrade-时间/ 里的备份恢复。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "代码目录里有改动，先处理掉再升级（git status 查看）" >&2
  exit 1
fi
scripts/backup.sh "backups/before-upgrade-$(TZ=CST-8 date +%Y%m%d-%H%M%S)"
echo "拉取最新代码…"
git pull --ff-only
echo "重新构建并启动…"
docker compose up -d --build
scripts/wait-healthy.sh
git log -1 --format='已升级到：%h %s（%ci）'
