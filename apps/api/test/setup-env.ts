import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestDatabase } from './test-db';

// 每个测试文件加载前，把 DATABASE_URL 指向测试库
useTestDatabase();
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-secret-at-least-32-characters-long';
process.env.ACCOUNT_SECRET_KEY ??= 'ab'.repeat(32);
// 附件写到临时目录，不弄脏仓库
process.env.UPLOAD_DIR ??= join(tmpdir(), 'crm-e2e-uploads');
