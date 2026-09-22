# Campus Wall 部署配置

这些文件记录 Alibaba Cloud Linux 3 上的单机部署方式，供维护和重建环境使用。GitHub Actions 配置和首次启用步骤见 [自动部署指南](AUTO-DEPLOY.md)；完成服务器初始化、Secrets 和开关配置前，只运行检查，不自动更新服务器。

| 文件 | 用途 |
| --- | --- |
| `campus-wall-backend.service` | 以 `campuswall` 用户运行后端，异常退出后重启 |
| `campus-wall.nginx.conf` | SSH 私人预览，仅监听 `127.0.0.1:80` |
| `campus-wall.acme.nginx.conf` | 首次签发证书时开放 HTTP 验证路径，其余请求返回 503 |
| `campus-wall.https.nginx.conf` | `campus-wall.me` 正式 HTTPS 站点，转发 API 和 Socket.IO |
| `campus-wall-cert-renew.service` / `.timer` | 每天两次检查该域名的证书续期 |
| `campus-wall-nginx-reload.sh` | 证书更新成功后检查并重载 Nginx |

## 环境约定

- 后端：`/opt/campus-wall/backend`，环境配置为该目录下的 `.env`，归属 `campuswall`，权限 `600`。
- Node.js：`/opt/nodejs/node-v22.23.2-linux-x64/bin/node`。升级运行环境时同步修改服务配置中的路径。
- PostgreSQL 16：本机数据库，服务名 `postgresql-16`。
- 前端：`/var/www/campus-wall`。构建前设置 `VITE_API_BASE_URL=/`，前端及 Socket.IO 使用同一站点地址。
- ACME 验证目录：`/var/www/letsencrypt`。
- 证书：`/etc/letsencrypt/live/campus-wall.me/`，由 Certbot 生成。

三个 Nginx 配置是部署阶段之间的替代配置，每次只将一个安装为 `/etc/nginx/nginx.conf`，不要一起加载。生产环境使用 HTTPS 配置，且必须先取得证书。

替换配置前备份服务器当前文件，执行 `nginx -t` 检查后再加载。从 `127.0.0.1:80` 改为公网 `80` 时使用 `systemctl restart nginx`，避免重载时旧监听占用端口。正常配置更新可以使用 `systemctl reload nginx`。

续期脚本安装到 `/etc/letsencrypt/renewal-hooks/deploy/campus-wall-nginx.sh`，权限 `755`；服务和定时器安装到 `/etc/systemd/system/`。启用定时器后执行 `certbot renew --cert-name campus-wall.me --dry-run` 验证续期。

## 更新后端

在后端目录、以运行账号执行：

```sh
npm ci --include=dev
npx prisma generate
npx prisma migrate deploy
```

保留开发依赖是因为当前运行方式需要 `tsx`，迁移需要 Prisma CLI。随后由有权限的账号重启 `campus-wall-backend` 并检查 `/api/health`。涉及数据库迁移时先备份数据库；回退代码不能自动撤销迁移。

`.env`、私钥、数据库数据及生成的 `.tar.gz` 上传包不提交到仓库。学校数据位于被忽略的 `data/`，首次部署新数据库时需另行准备；普通更新不需要重复初始化数据库。
