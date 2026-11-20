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
