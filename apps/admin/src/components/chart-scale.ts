/** 从 0 起的整齐刻度：步长取 1 / 2 / 5 × 10ⁿ；integer 时步长至少为 1（用于计数） */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  let step = max / count;
  const mag = 10 ** Math.floor(Math.log10(step));
  const norm = step / mag;
  step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** 金额刻度（分 → 元）：一万以下写全，以上写「x 万」 */
export function formatYuanTick(cents: number): string {
  const y = cents / 100;
  if (Math.abs(y) >= 10_000) return `${Number((y / 10_000).toFixed(1))}万`;
  return `¥${y.toLocaleString('zh-CN')}`;
}
