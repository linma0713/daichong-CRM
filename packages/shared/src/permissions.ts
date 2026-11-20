/**
 * 权限码目录。后端用它做接口校验，管理后台用它渲染权限勾选框和菜单。
 * available=false 的分组是后续阶段才上线的模块，先占位，方便提前规划角色。
 */
export interface PermissionDef {
  code: string;
  name: string;
}

export interface PermissionGroup {
  key: string;
  name: string;
  /** 当前版本是否已经有对应功能 */
  available: boolean;
  permissions: PermissionDef[];
}

/** 超级权限：拥有全部权限 */
export const ALL_PERMISSIONS = '*';

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'system',
    name: '系统管理',
    available: true,
    permissions: [
      { code: 'system:user:read', name: '查看员工' },
      { code: 'system:user:write', name: '新增 / 编辑员工' },
      { code: 'system:role:read', name: '查看角色' },
      { code: 'system:role:write', name: '管理角色与权限' },
      { code: 'system:team:write', name: '管理小组' },
      { code: 'system:audit:read', name: '查看操作日志' },
    ],
  },
  {
    key: 'customer',
    name: '客户',
    available: true,
    permissions: [
      { code: 'customer:read', name: '查看客户' },
      { code: 'customer:write', name: '新增 / 编辑客户' },
    ],
  },
  {
    key: 'product',
    name: '商品与定价',
    available: true,
    permissions: [{ code: 'product:write', name: '管理套餐、商品与售价' }],
  },
  {
    key: 'order',
    name: '订单与收款',
    available: true,
    permissions: [
      { code: 'order:read', name: '查看订单' },
      { code: 'order:write', name: '录入 / 修改订单' },
      { code: 'payment:confirm', name: '确认收款' },
    ],
  },
  {
    key: 'fulfillment',
    name: '履约与账号',
    available: true,
    permissions: [
      { code: 'fulfillment:handle', name: '处理开通 / 发号 / 续费任务' },
      { code: 'subscription:read', name: '查看全部账号与订阅（不受数据范围限制）' },
      { code: 'account:secret:view', name: '查看账号敏感信息（会记录日志）' },
    ],
  },
  {
    key: 'inventory',
    name: '库存与成本',
    available: false,
    permissions: [
      { code: 'inventory:read', name: '查看付款资源与成品号库存' },
      { code: 'inventory:write', name: '入库 / 调整库存' },
    ],
  },
  {
    key: 'aftersales',
    name: '售后',
    available: false,
    permissions: [
      { code: 'ticket:handle', name: '处理售后工单' },
      { code: 'refund:approve', name: '审批退款' },
    ],
  },
  {
    key: 'finance',
    name: '财务与代理佣金',
    available: false,
    permissions: [
      { code: 'finance:read', name: '查看财务报表' },
      { code: 'agent:write', name: '管理代理' },
      { code: 'commission:settle', name: '佣金对账与打款' },
    ],
  },
  {
    key: 'settings',
    name: '业务设置',
    available: true,
    permissions: [{ code: 'settings:write', name: '修改汇率、提醒节奏、任务时限等业务设置' }],
  },
];

export const ALL_PERMISSION_CODES: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.code),
);

export function isKnownPermission(code: string): boolean {
  return code === ALL_PERMISSIONS || ALL_PERMISSION_CODES.includes(code);
}

export function hasPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(ALL_PERMISSIONS) || granted.includes(required);
}
