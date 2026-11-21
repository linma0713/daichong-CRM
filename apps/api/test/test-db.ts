/**
 * 接口测试使用独立的测试库（TEST_DATABASE_URL），测试开始前会清空里面的数据。
 * 为了防止误删正式数据，库名里必须带 test。
 */
export function useTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('没有配置 TEST_DATABASE_URL，无法运行接口测试');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`接口测试会清空数据库，库名必须包含 test（当前：${dbName}）`);
  }
  process.env.DATABASE_URL = url;
  return url;
}

/**
 * 反复查询直到满足条件（最多 2 秒）。操作日志是在响应发出之后才写的，
 * 紧接着查日志可能还没写完，用这个等一下。
 */
export async function eventually<T>(
  query: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await query();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
