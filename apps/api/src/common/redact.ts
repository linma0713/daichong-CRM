const SENSITIVE = /pass(word)?|secret|token|credential|verification/i;

/** 写日志前把密码、令牌等字段替换掉，嵌套对象和数组也会处理 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
