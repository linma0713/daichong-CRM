import type { AuthUser } from './auth-user';

export interface ScopeFields {
  /** 业务表里「负责人」字段名，默认 ownerId */
  ownerField?: string;
  /** 业务表里「所属小组」字段名，默认 teamId */
  teamField?: string;
}

/**
 * 按员工的数据范围生成查询条件，业务模块（客户、订单等）查询时直接合并进 where。
 * - SELF：只看自己负责的
 * - TEAM：看本小组的；没有分组时退回到只看自己
 * - ALL：不限制
 */
export function scopeWhere(
  user: Pick<AuthUser, 'id' | 'teamId' | 'dataScope'>,
  fields: ScopeFields = {},
): Record<string, string> {
  const ownerField = fields.ownerField ?? 'ownerId';
  const teamField = fields.teamField ?? 'teamId';
  switch (user.dataScope) {
    case 'ALL':
      return {};
    case 'TEAM':
      return user.teamId ? { [teamField]: user.teamId } : { [ownerField]: user.id };
    case 'SELF':
    default:
      return { [ownerField]: user.id };
  }
}
