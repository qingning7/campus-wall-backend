# GitHub Actions 自动部署

两个仓库各自监听 `main`：前端通过 TypeScript 和 Vite 构建后发布；后端通过 Prisma 校验、TypeScript 检查、临时 PostgreSQL 16 数据库迁移及 API 测试后发布。PR 只检查，不发布。

**首次配置前自动发布关闭。** 两个仓库都需要设置仓库变量 `ENABLE_AUTO_DEPLOY=true` 才会连接服务器。工作流使用 GitHub 托管的 Ubuntu runner，服务器不运行 GitHub runner，也不需要访问 GitHub 拉取代码。

## 1. 确认线上状态

在阿里云远程终端执行，输出中不包含 `.env`：

```bash
sudo -i
systemctl show campus-wall-backend -p User -p Group -p WorkingDirectory -p ExecStart
nginx -t
grep -nE 'listen|server_name|root |ssl_certificate' /etc/nginx/nginx.conf
ls -ld /opt/campus-wall/backend /var/www/campus-wall
getenforce
curl -fsS --resolve campus-wall.me:443:127.0.0.1 https://campus-wall.me/api/health
```

本方案要求 HTTPS 已正常配置、后端账号为 `campuswall`、路径与上面一致。若只有 HTTP 可以访问，先完成证书部署。若 SELinux 为 `Enforcing`，先检查现有标签及策略，为新目录配置持久标签；不要关闭 SELinux，也不要直接执行下面的初始化脚本。

## 2. 生成单独的 SSH 密钥

在本机 **Windows CMD** 中执行：

```bat
ssh-keygen -t ed25519 -C campus-wall-github-actions -f "%USERPROFILE%\.ssh\campus-wall-actions"
```

出现口令提示时直接回车两次（无人值守部署使用无口令的专用密钥）。如果提示文件已存在，输入 `n`，不要覆盖已有密钥。

生成两个文件：`campus-wall-actions` 是私钥，只放进 GitHub Secrets；`campus-wall-actions.pub` 是公钥，需要上传服务器。不要把私钥发到聊天中或放进仓库。

服务器 SSH 主机公钥通过可信的阿里云远程终端获取：

```bash
awk '{print "123.57.42.162 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

保存这一整行，稍后作为 `DEPLOY_KNOWN_HOSTS`，无需关闭主机身份校验。

## 3. 服务器初始化（仅一次）

将后端仓库 `deployment` 中的以下三个文件，以及刚生成的 `.pub` 文件，通过已可用的文件上传方式放入 `/home/admin/campus-wall-actions-setup/`：

- `setup-actions.sh`
- `campus-wall-deploy.sh`
- `campus-wall-backup.sh`
- `campus-wall-actions.pub`

在阿里云远程终端、root 身份运行：

```bash
cd /home/admin/campus-wall-actions-setup
bash -n setup-actions.sh
bash -n campus-wall-deploy.sh
bash -n campus-wall-backup.sh
bash setup-actions.sh /home/admin/campus-wall-actions-setup/campus-wall-actions.pub
```

初始化会短暂重启后端；创建 `campusdeploy` 账号，只允许免密码执行固定的后端重启和数据库备份命令。原来的两个项目目录均保留，初始版本仍指向它们。

新的目录：

| 路径 | 用途 |
| --- | --- |
| `/opt/campus-wall/deploy/backend/current` | 后端当前版本的链接；systemd 使用此工作目录 |
| `/opt/campus-wall/deploy/backend/releases/` | 后端独立版本目录 |
| `/opt/campus-wall/deploy/shared/.env` | 首次发布后使用的生产环境变量，root:campuswall、640 |
| `/var/www/campus-wall-deploy/current` | 前端当前版本链接；Nginx 使用此根目录 |
| `/var/www/campus-wall-deploy/releases/` | 前端独立版本目录 |
| `/var/backups/campus-wall/` | 每次后端发布前的数据库备份，root 专用 |

初始化会保存 Nginx 配置备份，并创建 `/etc/systemd/system/campus-wall-backend.service.d/20-actions.conf`。如果中途失败，保留报错，不要反复运行初始化脚本。

初始化后的 `.env` 维护：首次初始化仅复制旧文件。第一次自动发布前，如果修改原目录的 `.env`，需要同步修改新的共享文件；自动发布成功后只维护共享文件，并重启后端。

在本机 Windows CMD 验证 SSH（首次提示主机身份时先与控制台公钥指纹核对）：

```bat
ssh -i "%USERPROFILE%\.ssh\campus-wall-actions" -o IdentitiesOnly=yes campusdeploy@123.57.42.162 "id; sudo -n -l"
```

如失败，先检查阿里云 22/TCP 入站规则和 SSH 账号配置。GitHub 托管 runner 的出口地址会变化；只允许你家 IP 的 SSH 规则无法让工作流连接。按实际网络要求选择访问规则，不开放数据库或后端 3001 端口。

## 4. 配置两个 GitHub 仓库

两个仓库分别执行相同的配置：

1. `Settings → Environments → New environment`，名称为 `production`。
2. 在环境的部署分支规则中只允许 `main`。如果希望每次完全自动更新，不设置 Required reviewers；需要人工把关时再开启。
3. 在 `production` 的 **Environment secrets** 添加以下内容：

| Secret 名称 | 内容 |
| --- | --- |
| `DEPLOY_HOST` | `123.57.42.162` |
| `DEPLOY_SSH_KEY` | 本机 `campus-wall-actions` 私钥文件的完整内容，包括首尾两行 |
| `DEPLOY_KNOWN_HOSTS` | 第 2 步从服务器读取的完整主机公钥行 |

复制私钥可在 PowerShell 执行，不在终端显示：

```powershell
Get-Content -Raw "$env:USERPROFILE\.ssh\campus-wall-actions" | Set-Clipboard
```

粘贴到 GitHub Secret 后清空剪贴板：`Set-Clipboard -Value ''`。不要截图私钥。

4. 最后到 `Settings → Secrets and variables → Actions → Variables`，创建 **Repository variable** `ENABLE_AUTO_DEPLOY`，值为 `true`。此变量不能只放在 Environment 中，因为部署任务开始前就会判断它。

GitHub 环境功能受仓库可见性和套餐限制；若无法创建 `production`，先确认套餐支持，再调整工作流。参考 [GitHub 部署环境文档](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。

## 5. 首次发布

工作流文件推送到 GitHub 后：

1. 后端仓库 `Actions → Backend checks and deployment → Run workflow → main`。
2. 等待 `check` 和 `deploy` 都成功，确认 `https://campus-wall.me/api/health` 返回 `ok: true`。
3. 前端仓库 `Actions → Frontend checks and deployment → Run workflow → main`。
4. 检查首页、登录、房间聊天和画板。后端重启会短暂断开 Socket.IO 连接。

之后正常提交并推送 `main` 就会自动部署。修改本机文件但未推送不会触发；每个仓库独立部署，跨仓库的接口调整应保持新旧版本兼容。工作流不自动覆盖 Nginx、systemd、证书或服务器安装的部署脚本；修改这些基础设施文件需要单独安装和检查。

## 发布失败及恢复

- 检查、安装依赖或备份失败：不切换到新版本。
- 切换后健康检查失败：尝试切回旧代码并重启后端，工作流仍标为失败。
- 数据库迁移失败：停止发布，保留数据库现状供排查。不要使用 `prisma migrate reset`。
- 代码回退**不会撤销数据库迁移**；迁移需要兼容旧版本。表或字段删除应拆成多次发布。自动迁移使用 [Prisma migrate deploy](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate)。
- 保留当前、上一个和至多三个其他代码版本；保留最新十份数据库备份。前端附带上一版静态资源以兼容旧页面，跨多次发布的旧标签页可能需要刷新。
- 服务器同盘备份不能防止整台服务器或磁盘损坏；按需另做异地备份。

暂停后续自动发布：将两个仓库的 `ENABLE_AUTO_DEPLOY` 改为 `false`。这不会停止已经开始的发布；让当前任务结束后再维护服务器。

查看服务器版本与状态：

```bash
readlink -f /opt/campus-wall/deploy/backend/current
readlink -f /var/www/campus-wall-deploy/current
systemctl status campus-wall-backend --no-pager
journalctl -u campus-wall-backend -n 80 --no-pager
df -h /
```

恢复到最初的手动部署版本时，先暂停自动发布并确保没有发布任务运行；确认数据库仍兼容旧代码，然后 root 执行：

```bash
ln -s /opt/campus-wall/backend /opt/campus-wall/deploy/backend/restore-original
mv -Tf /opt/campus-wall/deploy/backend/restore-original /opt/campus-wall/deploy/backend/current
systemctl restart campus-wall-backend
ln -s /var/www/campus-wall /var/www/campus-wall-deploy/restore-original
mv -Tf /var/www/campus-wall-deploy/restore-original /var/www/campus-wall-deploy/current
curl -fsS http://127.0.0.1:3001/api/health
```

数据库恢复会覆盖生产数据，必须先确认备份和停写方案，不能当作普通的自动回退步骤。
