import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { useTestDatabase } from './test-db';

/** 所有接口测试开始前执行一次：把数据库结构迁移到最新 */
export default function globalSetup(): void {
  const url = useTestDatabase();
  execFileSync(
    process.execPath,
    [join(__dirname, '../node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' },
  );
}
