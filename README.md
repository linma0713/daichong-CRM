# 代充 CRM

代充业务的**内部管理后台**。只给公司员工使用，客户和代理不登录系统，所有操作由员工完成。

当前进度：**M0 底座**，包括员工账号、角色权限、小组、操作日志和一键本地启动。业务模块按下面的路线逐步上线。

| 阶段            | 内容                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| M0 底座（当前） | 员工登录与改密、角色权限（功能权限 + 数据范围）、小组、操作日志、Docker 一键启动、CI                   |
| M1 主链路       | 客户、商品与套餐（Pro / Max / Ultra，月付 / 季付 / 年付）、订单与收款、开通 / 发号任务、订阅与到期提醒 |
| M2 经营闭环     | 付款资源与成品号库存、单笔毛利、售后与质保（付费附加服务）、数据看板                                   |
| M3 代理         | 员工代录单、两级佣金（比例后台可改，订单保存下单时的比例）、冻结期与月度对账                           |
| M4 多端与上云   | 员工手机端（小程序 / App，复用同一套接口）、云端部署与备份                                             |

## 技术栈

| 部分                     | 选型                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- |
| 仓库                     | pnpm monorepo（Node 22）                                                            |
| 后端 `apps/api`          | NestJS 11 模块化单体 + Prisma 6 + PostgreSQL 16                                     |
| 管理后台 `apps/admin`    | React 19 + Ant Design 5 + Vite 7 + TanStack Query                                   |
| 共享包 `packages/shared` | 权限码、内置角色、错误码，前后端共用                                                |
| 接口                     | OpenAPI 自动生成；前端用 `openapi-typescript` 生成类型，以后小程序 / App 复用同一份 |
| 部署                     | Docker Compose（本地）→ 同样的镜像上云                                              |

## 快速开始

### 方式一：Docker 一键启动（推荐先用这个看效果）

需要先安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。

```bash
cp .env.example .env          # Windows PowerShell：copy .env.example .env
docker compose up -d --build
```

第一次构建大约需要几分钟。完成后打开 <http://localhost:8080>：

- 默认管理员：`admin` / `Admin@123456`（在 `.env` 里可改）
- 第一次登录会要求修改密码
- 接口文档：<http://localhost:8080/api/docs>

常用操作：

```bash
docker compose logs -f api    # 看后端日志
docker compose down           # 停止（数据保留）
docker compose down -v        # 停止并清空数据库（慎用）
```

如果本机已经有 PostgreSQL 占用了 5432 端口，把 `.env` 里的 `POSTGRES_PORT` 改成 `5433` 再启动。

### 方式二：本地开发

需要 Node 22（建议用 [nvm](https://github.com/nvm-sh/nvm) 或 [fnm](https://github.com/Schniz/fnm)）和一个 PostgreSQL。最省事的是只用 Docker 起数据库：

```bash
corepack enable                   # 启用 pnpm
cp .env.example .env
docker compose up -d postgres     # 只启动数据库（也可以用自己装的 PostgreSQL，改 .env 里的连接串即可）

pnpm install
pnpm db:deploy                    # 建表
pnpm db:seed                      # 创建内置角色和管理员账号
pnpm dev                          # 同时启动后端和管理后台
```

- 管理后台：<http://localhost:5173>（开发服务器会把 `/api` 转给后端）
- 后端接口文档：<http://localhost:3000/api/docs>

## 常用命令

| 命令              | 作用                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`        | 启动后端（3000）和管理后台（5173），代码改动自动刷新                                   |
| `pnpm build`      | 构建全部                                                                               |
| `pnpm typecheck`  | 类型检查                                                                               |
| `pnpm test`       | 单元测试                                                                               |
| `pnpm test:e2e`   | 接口测试，使用 `TEST_DATABASE_URL` 指向的测试库（**会清空该库**，库名必须包含 `test`） |
| `pnpm format`     | 统一代码格式                                                                           |
| `pnpm db:migrate` | 改了 `apps/api/prisma/schema.prisma` 之后生成并执行迁移                                |
| `pnpm db:deploy`  | 执行已有的迁移（部署时用）                                                             |
| `pnpm db:seed`    | 补齐内置角色和首个管理员（可重复执行）                                                 |
| `pnpm api:gen`    | 后端接口有改动后，重新生成 `openapi.json` 和前端类型                                   |

用 Docker 起的数据库第一次初始化时会自动建好测试库 `crm_test`。自己装的 PostgreSQL 需要手动建一个：`createdb crm_test`。

## 目录结构

```
apps/
  api/                 后端
    prisma/            数据库结构、迁移、初始化数据
    src/auth/          登录、令牌、权限守卫
    src/users/         员工
    src/roles/         角色与权限
    src/teams/         小组
    src/audit/         操作日志（所有写操作自动记录，密码等字段脱敏）
    test/              接口测试
  admin/               管理后台
    src/api/           接口客户端（自动带令牌、过期自动刷新）和生成的类型
    src/auth/          登录状态、路由守卫、菜单权限
    src/pages/         页面
packages/
  shared/              前后端共用的权限码和角色定义
docker/                数据库初始化脚本
```

## 权限是怎么设计的

- **功能权限**：每个接口要求一个权限码（例如 `system:user:write`），角色就是一组权限码。权限码目录在 `packages/shared/src/permissions.ts`，后续模块的权限已经列好，可以提前分配。
- **数据范围**：每个角色还有一个数据范围，分为「仅本人负责的数据」「本小组的数据」「全部数据」，决定能看到哪些客户和订单（M1 起生效）。
- 一个员工可以有多个角色，权限取并集、数据范围取最大的。小团队可以让一个人同时担任客服和充值员。
- 内置角色：管理员、客服、充值员、售后、财务。「管理员」固定拥有全部权限，系统会阻止停用、删除或降权最后一个管理员。
- 登录令牌 2 小时有效，过期后自动续期，7 天不用需要重新登录。退出登录、改密码、停用员工都会让对应的登录立即失效。

## 上云前检查

- [ ] `.env` 里的 `JWT_ACCESS_SECRET` 换成随机字符串（`openssl rand -hex 32`）
- [ ] `POSTGRES_PASSWORD` 换成强密码，并同步修改连接串
- [ ] 首次登录后立即修改管理员密码
- [ ] 配置 HTTPS（云厂商负载均衡或在 nginx 前加一层）
- [ ] 开启数据库自动备份
