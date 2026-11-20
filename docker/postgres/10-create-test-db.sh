#!/bin/sh
# 首次创建数据库时，顺便建一个接口测试专用库（pnpm test:e2e 会清空它）
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DB}_test OWNER "$POSTGRES_USER";
SQL
