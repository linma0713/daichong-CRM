/**
 * 导出 OpenAPI 文档到 apps/api/openapi.json，不需要数据库。
 * 管理后台据此生成带类型的接口代码：pnpm api:gen
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
process.env.JWT_ACCESS_SECRET ??= 'openapi-export-only-secret-0123456789abcdef';

async function main() {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module');
  const { buildOpenApi, configureApp } = await import('../src/bootstrap');
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.init();
  const doc = buildOpenApi(app);
  const out = join(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  await app.close();
  console.log(`已导出 ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
