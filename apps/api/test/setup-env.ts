import { useTestDatabase } from './test-db';

// 每个测试文件加载前，把 DATABASE_URL 指向测试库
useTestDatabase();
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-secret-at-least-32-characters-long';
