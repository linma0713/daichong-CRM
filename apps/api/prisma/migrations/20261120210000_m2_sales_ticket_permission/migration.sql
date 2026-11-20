-- M2 给内置「客服」角色新增了「登记售后工单」权限（ticket:create）。
-- 内置角色只在第一次初始化时创建，从 M1 升级上来的库不会自动带上新权限，这里补一次。
-- 只动内置客服角色，且已有该权限时不重复添加；之后管理员在后台改动的权限不受影响。
UPDATE "Role"
SET "permissions" = array_append("permissions", 'ticket:create'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'sales'
  AND "builtIn" = true
  AND NOT ('ticket:create' = ANY ("permissions"));
