#!/bin/sh
# 容器启动：先把数据库结构迁移到最新，再补齐初始数据（可重复执行），最后启动服务
set -e
node node_modules/prisma/build/index.js migrate deploy
node dist/prisma/seed.js
exec node dist/src/main.js
