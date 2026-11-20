// pnpm install 之后自动构建共享包，后端、前端和初始化脚本都依赖它的产物。
// Docker 构建时安装依赖那一步还没有拷贝源码，此时跳过，由 Dockerfile 单独构建。
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('packages/shared/src/index.ts')) {
  execSync('pnpm --filter @crm/shared build', { stdio: 'inherit' });
}
