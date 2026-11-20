import { ALL_PERMISSIONS } from './permissions';

/** 数据范围：决定员工能看到哪些客户、订单等业务数据 */
export type DataScope = 'SELF' | 'TEAM' | 'ALL';

export const DATA_SCOPES: DataScope[] = ['SELF', 'TEAM', 'ALL'];

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  SELF: '仅本人负责的数据',
  TEAM: '本小组的数据',
  ALL: '全部数据',
};

const SCOPE_RANK: Record<DataScope, number> = { SELF: 0, TEAM: 1, ALL: 2 };

/** 一个人有多个角色时，取范围最大的那个 */
export function widestDataScope(scopes: readonly DataScope[]): DataScope {
  return scopes.reduce<DataScope>((acc, s) => (SCOPE_RANK[s] > SCOPE_RANK[acc] ? s : acc), 'SELF');
}

/** 多个角色的权限取并集 */
export function mergePermissions(lists: readonly (readonly string[])[]): string[] {
  const set = new Set<string>();
  for (const list of lists) for (const p of list) set.add(p);
  if (set.has(ALL_PERMISSIONS)) return [ALL_PERMISSIONS];
  return [...set].sort();
}

export interface BuiltInRole {
  code: string;
  name: string;
  description: string;
  permissions: string[];
  dataScope: DataScope;
}

/** 系统内置角色，初始化数据库时创建；权限可以在后台再调整 */
export const BUILT_IN_ROLES: BuiltInRole[] = [
  {
    code: 'admin',
    name: '管理员',
    description: '老板 / 负责人，拥有全部权限',
    permissions: [ALL_PERMISSIONS],
    dataScope: 'ALL',
  },
  {
    code: 'sales',
    name: '客服',
    description: '跟进客户、报价、录单、确认收款、发续费提醒',
    permissions: [
      'customer:read',
      'customer:write',
      'order:read',
      'order:write',
      'payment:confirm',
      'ticket:create',
    ],
    dataScope: 'SELF',
  },
  {
    code: 'fulfillment',
    name: '充值员',
    description: '处理开通、发号和内部续费任务',
    permissions: [
      'fulfillment:handle',
      'subscription:read',
      'account:secret:view',
      'inventory:read',
    ],
    dataScope: 'ALL',
  },
  {
    code: 'aftersales',
    name: '售后',
    description: '处理售后工单，按质保规则包换或退款',
    permissions: ['ticket:handle', 'customer:read', 'order:read', 'subscription:read'],
    dataScope: 'ALL',
  },
  {
    code: 'finance',
    name: '财务',
    description: '对账、退款出账、代理佣金结算',
    permissions: [
      'finance:read',
      'order:read',
      'refund:approve',
      'commission:settle',
      'agent:write',
    ],
    dataScope: 'ALL',
  },
];
