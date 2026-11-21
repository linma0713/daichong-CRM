/** 客户分层、流失原因、话术库：前后端共用的枚举和文案 */

/**
 * 客户所处阶段（系统按付款和订阅自动算，每小时刷新一次，付款 / 开通 / 退款后立即刷新）：
 * - LEAD 潜在：还没付过款
 * - NEW 新客：第一次付款在 30 天内
 * - ACTIVE 活跃：有服务中的订阅
 * - DORMANT 沉睡：没有服务中的订阅，服务结束不久（召回的黄金期）
 * - CHURNED 流失：服务结束很久了
 */
export type CustomerStage = 'LEAD' | 'NEW' | 'ACTIVE' | 'DORMANT' | 'CHURNED';
export const CUSTOMER_STAGES: CustomerStage[] = ['LEAD', 'NEW', 'ACTIVE', 'DORMANT', 'CHURNED'];
export const CUSTOMER_STAGE_LABELS: Record<CustomerStage, string> = {
  LEAD: '潜在',
  NEW: '新客',
  ACTIVE: '活跃',
  DORMANT: '沉睡',
  CHURNED: '流失',
};
export const CUSTOMER_STAGE_HINTS: Record<CustomerStage, string> = {
  LEAD: '建了档还没付过款',
  NEW: '第一次付款在 30 天内',
  ACTIVE: '有服务中的订阅',
  DORMANT: '服务已结束、还在召回期内',
  CHURNED: '服务结束超过召回期',
};
/** 新客的判定天数 */
export const NEW_CUSTOMER_DAYS = 30;

/** 跟进记录的类型 */
export const FOLLOW_UP_KINDS = [
  { value: 'note', label: '跟进', color: 'blue' },
  { value: 'renewal_reminder', label: '续费提醒', color: 'purple' },
  { value: 'recall', label: '召回', color: 'orange' },
  { value: 'lost_reason', label: '流失原因', color: 'red' },
] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]['value'];
export const FOLLOW_UP_KIND_VALUES = FOLLOW_UP_KINDS.map((k) => k.value) as FollowUpKind[];
/** 员工手动记录时能选的类型（流失原因走单独的入口） */
export const MANUAL_FOLLOW_UP_KINDS: FollowUpKind[] = ['note', 'renewal_reminder', 'recall'];

export const LOST_REASONS = [
  { value: 'price', label: '嫌贵' },
  { value: 'no_need', label: '暂时不用了' },
  { value: 'competitor', label: '换了别家' },
  { value: 'official', label: '自己去官方买了' },
  { value: 'bad_experience', label: '体验不好（封号、限额等）' },
  { value: 'unreachable', label: '联系不上' },
  { value: 'other', label: '其他' },
] as const;
export type LostReason = (typeof LOST_REASONS)[number]['value'];
export const LOST_REASON_VALUES = LOST_REASONS.map((r) => r.value) as LostReason[];
export function lostReasonLabel(value: string | null | undefined): string {
  return LOST_REASONS.find((r) => r.value === value)?.label ?? '未记录';
}

export const SCRIPT_CATEGORIES = [
  { value: 'renewal', label: '续费提醒' },
  { value: 'recall', label: '召回' },
  { value: 'delivery', label: '开通交付' },
  { value: 'quote', label: '报价' },
  { value: 'aftersales', label: '售后' },
  { value: 'other', label: '其他' },
] as const;
export type ScriptCategory = (typeof SCRIPT_CATEGORIES)[number]['value'];
export const SCRIPT_CATEGORY_VALUES = SCRIPT_CATEGORIES.map((c) => c.value) as ScriptCategory[];
export const SCRIPT_CATEGORY_LABELS = Object.fromEntries(
  SCRIPT_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<ScriptCategory, string>;

/** 话术里能用的变量，复制时自动换成这个客户的信息 */
export const SCRIPT_VARIABLES = [
  { key: '客户称呼', example: '王先生' },
  { key: '套餐', example: 'Max 月付（代充）' },
  { key: '到期日', example: '2026-12-01' },
  { key: '剩余天数', example: '3' },
  { key: '账号', example: 'wang@example.com' },
  { key: '续费价', example: '¥1,000.00' },
  { key: '客服', example: '小王' },
] as const;
export type ScriptVariable = (typeof SCRIPT_VARIABLES)[number]['key'];
export type ScriptVars = Partial<Record<ScriptVariable, string | number | null | undefined>>;

/**
 * 把话术里的 {变量} 换成实际值。没有值的变量原样保留（例如「{到期日}」），
 * 复制出去前客服一眼就能看到哪里要手动补。
 */
export function renderScript(content: string, vars: ScriptVars): string {
  return content.replace(/\{([^{}]{1,10})\}/g, (whole, key: string) => {
    const v = vars[key as ScriptVariable];
    return v === null || v === undefined || v === '' ? whole : String(v);
  });
}

/** 话术里还有哪些变量没填上 */
export function missingVariables(rendered: string): string[] {
  const known = new Set<string>(SCRIPT_VARIABLES.map((v) => v.key));
  return [...new Set([...rendered.matchAll(/\{([^{}]{1,10})\}/g)].map((m) => m[1]))].filter((k) =>
    known.has(k),
  );
}
