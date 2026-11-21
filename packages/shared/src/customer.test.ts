import { describe, expect, it } from 'vitest';
import { lostReasonLabel, missingVariables, renderScript } from './customer';

describe('renderScript', () => {
  it('fills known variables and keeps missing ones', () => {
    const text = '{客户称呼}您好，您的 {套餐} 将在 {到期日} 到期，还剩 {剩余天数} 天。';
    const out = renderScript(text, { 客户称呼: '王先生', 套餐: 'Max 月付', 剩余天数: 0 });
    expect(out).toBe('王先生您好，您的 Max 月付 将在 {到期日} 到期，还剩 0 天。');
    expect(missingVariables(out)).toEqual(['到期日']);
  });
  it('leaves unknown braces alone', () => {
    expect(renderScript('价格 {见附件} {客服}', { 客服: '小王' })).toBe('价格 {见附件} 小王');
    expect(missingVariables('价格 {见附件}')).toEqual([]);
  });
  it('labels lost reasons', () => {
    expect(lostReasonLabel('price')).toBe('嫌贵');
    expect(lostReasonLabel(null)).toBe('未记录');
  });
});
