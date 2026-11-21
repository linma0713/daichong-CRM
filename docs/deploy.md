# 部署到云服务器

这份文档讲怎么把代充 CRM 从自己电脑搬到一台云服务器上，让员工在任何地方用手机、电脑打开，客户能打开收款链接。
全程用的还是本地那套 Docker 镜像，多加了三样东西：自动 HTTPS 证书、每天自动备份、关闭不该对外的端口。

```
员工 / 客户的浏览器
      │  https://crm.你的域名.com
      ▼
   Caddy（自动申请、续期 HTTPS 证书）
      ▼
   nginx（后台页面，/api 转给后端）
      ▼
   后端（NestJS）──── PostgreSQL 数据库
                         ▲
   backup（每天 4 点备份数据库和附件到 backups/）
```

## 一、准备

| 要准备的        | 说明                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 云服务器        | 2 核 4 GB 内存、40 GB 以上硬盘就够用（几十个员工）。系统选 **Ubuntu 22.04 或 24.04**。                                                      |
| 服务器所在地    | 中国大陆的服务器用域名开网站，要先做 **ICP 备案**（一般 1～3 周），没备案 80 / 443 端口会被拦。香港和海外的服务器不用备案，开通当天就能用。 |
| 域名            | 买一个域名，加一条 **A 记录**：`crm.你的域名.com` → 服务器的公网 IP。生效后再往下做（`ping crm.你的域名.com` 能看到服务器 IP）。            |
| 安全组 / 防火墙 | 只放行 **22**（SSH）、**80**、**443**。数据库端口不要放行。                                                                                 |

> 买服务器、买域名要花钱，由你来决定选哪家。选好后把服务器 IP 和域名告诉负责部署的人（或 Claude），下面的步骤都可以照着做。

## 二、第一次部署

以下命令都在服务器上执行（用 SSH 登录，`ssh root@服务器IP`）。

**1. 安装 Docker**

```bash
curl -fsSL https://get.docker.com | sh      # 香港 / 海外服务器
docker compose version                       # 能看到版本号就行
```

大陆服务器访问 get.docker.com 可能很慢，按云厂商文档里「安装 Docker」的步骤装，并配置镜像加速。

**2. 下载代码**

```bash
git clone https://github.com/linma0713/daichong-CRM.git /opt/daichong-crm
cd /opt/daichong-crm
```

**3. 生成配置**（只做一次）

```bash
deploy/init-env.sh crm.你的域名.com
```

脚本会生成 `.env`，里面的数据库密码、登录密钥、加密密钥、管理员初始密码都是随机的。
屏幕上会显示**管理员初始密码**和 **ACCOUNT_SECRET_KEY**，只显示这一次，马上抄到安全的地方：

- 管理员初始密码：第一次登录用，登录后会要求改掉。
- ACCOUNT_SECRET_KEY：Claude 账号密码、卡号、两步验证密钥都用它加密。服务器坏了要靠它和备份一起恢复，**丢了就再也解不开**。

`.env` 里还多了一行 `COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml`。有了它，之后所有 `docker compose` 命令都会自动带上上云配置，不用每次写两个文件。

**4. 启动**

```bash
docker compose up -d --build
```

第一次要构建镜像，几分钟。构建完 Caddy 会自动申请证书（几十秒）。用 `docker compose ps` 看，所有服务都是 `running` / `healthy` 就好了。

**5. 登录并完成上线检查**

1. 打开 `https://crm.你的域名.com`，用 `admin` 和初始密码登录，按提示改密码。
2. 右上角头像 →「账号安全」→ 开启两步验证。
3. 「系统管理 → 角色与权限」：给「管理员」和「财务」打开「必须开启两步验证」。
4. 「系统管理 → 上线检查」：除了「提示」以外应该**全部是绿色**。哪项不是绿的，页面上写着怎么改。
5. 「系统管理 → 业务设置」：按实际情况填汇率、提醒节奏、转介绍奖励金额等；在线收款保持「不开启」（见第六节）。
6. 「系统管理 → 员工」：给员工开账号。

## 三、全新开始，还是把本机数据搬上去？

**建议全新开始**：本机上的数据如果只是试用、验收时录的演示数据，直接在服务器上重新开始最干净。上面做完就可以用了。

**要把本机数据搬上去**时这样做：

```bash
# ① 在自己电脑的项目目录里：备份（得到 db-时间.dump 和 uploads-时间.tar.gz）
scripts/backup.sh

# ② 把这两个文件传到服务器
scp backups/db-*.dump backups/uploads-*.tar.gz root@服务器IP:/opt/daichong-crm/backups/

# ③ 在服务器上：恢复（会覆盖服务器上现在的数据，恢复前自动备份一份）
cd /opt/daichong-crm
scripts/restore.sh backups/db-时间.dump backups/uploads-时间.tar.gz
```

恢复完**马上做「更换加密密钥」**（第五节）：本机数据是用本机的 ACCOUNT_SECRET_KEY 加密的，服务器上是新生成的密钥，不换的话账号密码看不了、开了两步验证的人登录不了。
`OLD_ACCOUNT_SECRET_KEY` 填本机 `.env` 里的 `ACCOUNT_SECRET_KEY`。

搬上去之后，员工账号和密码都是本机上的那一套。

## 四、日常运维

| 要做的事       | 命令（在 `/opt/daichong-crm` 里执行）                               |
| -------------- | ------------------------------------------------------------------- |
| 看各服务状态   | `docker compose ps`                                                 |
| 看后端日志     | `docker compose logs -f --tail 100 api`                             |
| 看备份日志     | `docker compose logs --tail 50 backup`                              |
| 手动备份一次   | `scripts/backup.sh`                                                 |
| 升级到最新版本 | `scripts/upgrade.sh`（自动先备份，再拉代码、重新构建、等后端就绪）  |
| 从备份恢复     | `scripts/restore.sh backups/db-xxx.dump backups/uploads-xxx.tar.gz` |
| 重启全部       | `docker compose restart`                                            |
| 服务器重启后   | 不用管，容器会自己起来                                              |

**备份**

- 每天凌晨 4 点（北京时间）自动备份数据库和附件到 `/opt/daichong-crm/backups/`，保留 14 天（`.env` 里的 `BACKUP_HOUR`、`BACKUP_KEEP_DAYS` 可以改）。
- 备份和服务器在同一块硬盘上，服务器整个坏了就一起没了。**每周把最新的一份下载到自己电脑或网盘**：
  `scp root@服务器IP:/opt/daichong-crm/backups/db-最新.dump root@服务器IP:/opt/daichong-crm/backups/uploads-最新.tar.gz .`
  云厂商的「自动快照」也建议打开。
- 「上线检查」里能看到最近一次备份的时间；超过一天没有新备份会标红。
- 每过几个月做一次恢复演练：在另一台机器（或自己电脑）上用 `scripts/restore.sh` 恢复，确认备份是好的。

**忘记管理员密码 / 手机丢了登不上两步验证**

有别的管理员时，请另一位管理员在「员工」里重置。只有一个管理员时，在服务器上执行：

```bash
docker compose exec api node dist/src/cli/reset-password.js admin              # 只重置密码
docker compose exec api node dist/src/cli/reset-password.js admin --clear-2fa  # 同时清掉两步验证
```

会显示一个临时密码，登录后要求改掉；这个账号之前登录的设备全部退出。操作日志里会记一条「在服务器上重置密码」。

## 五、更换加密密钥（ACCOUNT_SECRET_KEY）

用在两种情况：从本机搬数据上来（见第三节），或者怀疑密钥泄露。**不能直接改 `.env` 里的值**，要先把数据用新密钥重新加密：

```bash
scripts/backup.sh                                   # ① 先备份
openssl rand -hex 32                                # ② 生成新密钥（搬数据的情况不用这步，服务器上已经是新的）
nano .env                                           # ③ ACCOUNT_SECRET_KEY 改成新密钥，另加一行 OLD_ACCOUNT_SECRET_KEY=旧密钥
docker compose stop api                             # ④ 停后端，换密钥的这一两分钟里不让员工存新数据
docker compose run --rm api node dist/src/cli/rotate-secret-key.js           # ⑤ 先检查，不改数据
docker compose run --rm api node dist/src/cli/rotate-secret-key.js --apply   # ⑥ 确认没问题再执行
nano .env                                           # ⑦ 删掉 OLD_ACCOUNT_SECRET_KEY 那一行
docker compose up -d                                # ⑧ 启动
```

第⑤步会列出每类数据（Claude 账号密码、付款资源卡号、企业微信机器人地址、员工两步验证密钥）各有几条要重新加密。有记录新旧密钥都解不开时，工具不会改任何数据（多半是旧密钥填错了）。重复执行是安全的。
换完记得把新密钥抄到安全的地方，替换掉之前抄的旧密钥。

## 六、在线收款

现在只有**模拟通道**，用来测试整个流程：拿到链接的人点一下就算付了款，系统会自动派开通任务。**正式环境不要打开模拟通道**（上线检查会标红）。

要接真实的收款（支付宝、微信支付等），需要你先开通对应的商户号，拿到商户号、密钥和证书。决定用哪家之后告诉开发，接好后在「业务设置 → 在线收款」里选它。
支付平台要填的回调地址是 `https://crm.你的域名.com/api/pay/notify/通道名`。

## 七、安全建议

- 云服务器安全组只开 22、80、443；SSH 最好改成密钥登录，关掉密码登录。
- `.env` 里全是密码和密钥，不要发给别人、不要传到网上。
- 管理员、财务必须开两步验证；员工离职当天在「员工」里停用账号。
- 时不时看一眼「操作日志」，尤其是登录失败、查看账号密码、退款这些红色的操作。

## 八、常见问题

**打开域名显示连接不安全，或者 Caddy 日志里证书申请失败**
`docker compose logs caddy` 查看。常见原因：域名还没解析到这台服务器；安全组没放行 80 / 443；大陆服务器还没备案。改好后 `docker compose restart caddy`。

**上传附件失败**
单个文件最大 10 MB。服务器硬盘满了也会失败：`df -h` 看一下，`backups/` 里太旧的手动备份可以删掉。

**员工说登录被限制**
同一个 IP 每分钟最多登录 10 次，输错密码 5 次会锁 15 分钟，管理员可以在「员工」里解锁。

**升级后打不开**
`docker compose logs --tail 200 api` 看报错。要退回去：`git log` 找到上一个版本，`git checkout 版本号`，再用 `backups/before-upgrade-时间/` 里的备份 `scripts/restore.sh` 恢复。

## 附：本机和服务器的区别

|                    | 本机（docker-compose.yml）     | 服务器（再加 deploy/docker-compose.prod.yml） |
| ------------------ | ------------------------------ | --------------------------------------------- |
| 访问地址           | http://localhost:8080          | https://crm.你的域名.com（自动证书）          |
| 数据库端口         | 只对本机开放 5432              | 不开放                                        |
| 自动备份           | 没有，手动 `scripts/backup.sh` | 每天 4 点，保留 14 天                         |
| 接口文档 /api/docs | 打开                           | 关闭                                          |
| 日志               | 不限大小                       | 每个服务最多 50 MB                            |
| 密钥               | 示例值（只能本机试用）         | `deploy/init-env.sh` 随机生成                 |
