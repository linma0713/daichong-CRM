// 给两种产物目录标记模块类型，让 Node 和打包工具都能正确识别
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{ "type": "commonjs" }\n');
writeFileSync(new URL('../dist/esm/package.json', import.meta.url), '{ "type": "module" }\n');
