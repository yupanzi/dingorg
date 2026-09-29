# dingorg

把一个**钉钉企业内部应用**变成组织的身份基础设施。只做两件事：

1. **钉钉认证 → 标准 OIDC**：下游用任意标准 OIDC 客户端库接入，底层由钉钉扫码完成认证。
2. **组织架构快照 → REST 出口**：调用方出示**自己钉钉应用的 AppKey/AppSecret**，读到这个
   应用可见范围内的成员与部门（含 unionId、企业邮箱、职级、部门主管）。快照按 appKey 隔离，
   存在 Postgres 里。

外部依赖只有 Postgres。没有管理界面，也没有自己的 API 密钥。`GET /api/v1` 列出全部端点与鉴权方式。

## 架构

```
                  ┌──────────── dingorg（单进程）─────────────┐
  钉钉扫码 ──────► │  /oidc/*        OIDC Provider            │ ──► 下游应用
                  │  /oidc/interaction  钉钉登录交互          │     (authentik…)
                  │  /api/v1/*      组织快照（按 appKey 隔离）│ ◄── 内部系统
                  └──────────────────┬───────────────────────┘     （出示自己的
                          ▲          │                              AppKey/Secret）
  cron orgsync ───────────┘          │
  （每天 POST /api/v1/sync，       Postgres
    出示自有 AppKey/Secret）          ▲
  cron oidcpurge ────────────────────┘  （清理 OIDC 过期工件）
```

一个常驻进程 + 三个跑完即退的任务（migrate、oidcpurge、orgsync），共用一个镜像。

快照只有一种刷新方式 —— `POST /api/v1/sync`，常驻进程自己不刷新：

- **自有应用**（`DINGTALK_APP_KEY`）的快照是 **OIDC 准入的唯一依据**，由每日 cron orgsync
  （默认 UTC 04:00）拿自有凭证调它。离职生效、新人可登录的窗口因此**最长约 24 小时**。
  ⚠️ **空库时谁都登录不进来**：K8s 部署时 hook 会跑一次，本地要手动 `pnpm orgsync`。
- **别的应用**的快照不按时间过期：第一次读时当场拉取，之后原样返回，要更新就自己调 `POST /api/v1/sync`。

## 快速开始

```bash
# 1. 准备一个空的 PostgreSQL database，填好 .env（缺失或不合法时启动会列出全部问题）
cp .env.example .env
pnpm install

# 2. 生成一个下游 OIDC client，输出的那行 JSON 填进 .env 的 OIDC_CLIENTS_JSON
pnpm -s oidc:new-client --name local --redirect-uri http://localhost:9000/callback

# 3. 建表、起服务
pnpm db:migrate
pnpm dev          # http://localhost:3080

# 4. 拉一次自有应用的快照（不拉的话谁都登录不进来）
pnpm orgsync
```

验证：

```bash
curl -s localhost:3080/healthz
curl -s localhost:3080/api/v1 | jq
curl -s localhost:3080/oidc/.well-known/openid-configuration | jq
curl -s -u "<AppKey>:<AppSecret>" localhost:3080/api/v1/sync | jq
```

## 钉钉开放平台配置清单

在钉钉开发者后台创建**企业内部应用**，然后：

| 项 | 位置 | 漏了会怎样 |
| --- | --- | --- |
| AppKey / AppSecret | 应用凭证 | 填进 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` |
| **服务器出口 IP 白名单** | 开发配置 | ⚠️ 组织拉取报 `60020`，但 `gettoken` 正常 —— 极易误判成凭证问题 |
| **`Contact.User.Read`** 权限点 | 权限管理 | ⚠️ 扫码后返回 `AccessTokenPermissionDenied` |
| 通讯录**个人信息**读权限 | 权限管理 | ⚠️ unionId 与企业邮箱**静默缺失**：所有人都没有 email，缺 unionId 的人登录不了（它是 `sub`）|
| 回调域名 | 登录与分享 | 填 `OIDC_ISSUER` 的 origin（本地 `http://localhost:3080`），改 issuer 或端口时同步改 |

## 下游如何接入（OIDC）

每个下游一个 client，由部署方**在本机**生成（在 Pod 里跑 secret 会进日志），没有注册端点：

```bash
pnpm -s oidc:new-client --name authentik-prod \
  --redirect-uri https://<authentik>/source/oauth/callback/<slug>/
# stdout：[{"name":"authentik-prod","id":"<uuid>","secret":"<43 位>","redirectUris":[...]}]
```

多个下游就是 `OIDC_CLIENTS_JSON` 数组里的多个对象，改完 Secret 要 bump `secretVersion`。下游填：

| 项 | 值 |
| --- | --- |
| discovery | `https://<域名>/oidc/.well-known/openid-configuration` |
| client_id / client_secret | 生成的 `id` / `secret` |
| scope | `openid profile email` |
| 流程 | authorization code，**强制 PKCE** |
| token 端点认证 | `client_secret_basic` 或 `client_secret_post` |

- 回调地址**只有精确匹配**，必须 https（loopback 例外）、不能带 `#`，只对登记它的 client 有效。
  填错是进程启动失败，并指出哪个 client 的哪一条。
- client 凭证与钉钉无关：`id` 必须是 UUID，`secret` 不得等于 `DINGTALK_APP_SECRET`。手写的
  secret 只能含 `A-Z a-z 0-9 - _ . ~`（标准 base64 的 `+ / =` 不行：Basic 认证会做 form 解码）。
- ⚠️ **每个下游都能登录全组织的人**：准入只看「在不在自有应用的通讯录里」。谁能用哪个下游由
  下游自己管（authentik 的 Policy）；直连本服务又不做授权的下游，全组织都能登录。
- 不签发 refresh token。

### claim 契约

id_token 与 userinfo 都给出这些，**集合是固定的**：

| claim | 来源 |
| --- | --- |
| `sub` | 钉钉 unionId（跨应用永久标识，**下游应当以它记用户**）|
| `name` | 钉钉显示名 |
| `preferred_username` | 即 `userName`：企业邮箱的 local part，没有时取显示名括号前的部分 |
| `email` / `email_verified` | 企业邮箱（小写），`email_verified` 恒为 true。**没有企业邮箱的人两个都不出现** |
| `picture` | 钉钉头像，没有时不出现 |

没有 `roles`、部门与职级 —— 要按职级授权就从 `/api/v1/org/users` 拿，或交给下游判定。

### 撤销访问的时效

把人从钉钉通讯录移除后，自有快照下一次刷新（**最长约 24 小时**）后新的登录被拒；但**未过期的
access_token（1 小时）仍然可用**，下游自己的会话更在本系统之外。要立即切断：

1. 手动触发一次刷新：`kubectl create job --from=cronjob/dingorg-orgsync <任务名> -n <ns>`，
   或 `curl -X POST -u "$APPKEY:$APPSECRET" https://<域名>/api/v1/sync`；
2. 再去各个下游分别登出。

## 组织数据 API

凭证是**你自己钉钉应用的 AppKey/AppSecret**（HTTP Basic），钉钉肯为它发 token 就通过，没有
白名单；读到的是这个应用在钉钉后台**可见范围内**的通讯录。你的应用同样要配出口 IP 白名单与
通讯录权限点（见上面的清单），「个人信息」权限点不开则 `email` 与 `dingtalk.unionid` 为空。

| 端点 | 响应 |
| --- | --- |
| `GET /api/v1/org/users` | `{ users, total, fetchedAt }` |
| `GET /api/v1/org/departments` | `{ departments, total, fetchedAt }`，部门是 `{ id, parentId, name, ancestorIds }`，根部门 id 为 1、名字是企业名 |
| `GET /api/v1/sync` | `{ appKey, state, fetchedAt, attemptedAt, error, userCount, deptCount }`，`state` 为 `never` / `failed` / `ok` |
| `POST /api/v1/sync` | 同上，外加 `refreshed`。**同步地拉完再返回** |

```bash
curl -s -u "$APPKEY:$APPSECRET" https://<域名>/api/v1/org/users | jq
```

- 第一次调用当场拉取（几百人要几秒到几十秒），之后原样返回；`fetchedAt` 是数据时刻。
- 距上一次拉取尝试（成功或失败）结束不到 1 分钟时不外呼：有快照就原样返回（`refreshed: false`），
  从没拉成功过则回 `503`。
- 快照里只有当前可见的人，离职者直接消失。刷新失败时旧快照原样保留。
- 错误体统一是 `{ "error": { "code", "message" } }`：
  - `401 unauthorized`：凭证不对，**一律不说原因**。同一 appKey 校验失败后 10 秒内不再替它
    向钉钉校验；已验证过的 secret 在 token 到期后续期不受影响。
  - `502 dingtalk_error`：拉取时钉钉报错，带 `dingtalk: { errcode, code, status }`（最常见是
    `60020`：你的应用没把本服务的出口 IP 加进白名单）。
  - `503 snapshot_unavailable`：从没拉成功过、上一次又刚失败；`message` 带原因，`Retry-After` 给出秒数。
  - `504 dingtalk_timeout`：请求钉钉超时。

成员对象里，系统字段平铺在顶层，钉钉原始字段收在 `dingtalk` 里（保持钉钉的字段名）：

```jsonc
{
  "userName": "alice",              // 企业邮箱 local part，没有则取显示名；快照内唯一
  "displayName": "Alice(爱丽丝)",
  "email": "alice@example.com",     // 只取企业邮箱，没有就是 null
  "depts": [{ "id": 12, "name": "技术中心", "isLeader": true }],
  "titles": ["技术中心总监", "技术中心-架构组组长"],  // 一人多职，已拆分
  "ranks": ["总监", "组长"],                          // 按内置职级词表从 titles 提取
  "jobLevel": "总监",                                 // 取自自定义字段「职务」，单值
  "dingtalk": {
    "userid": "0123456789",         // 可直接调钉钉接口（如给此人发消息）
    "unionid": "abc...",            // 永久标识，也是 OIDC 的 sub
    "title": "技术中心总监;技术中心-架构组组长",
    "extension": { "职务": "总监", "座位编号": "A1-0101" },
    "avatar": "https://...",
    "orgEmail": "Alice@Example.com" // 企业邮箱原文。⚠️ 覆盖率约五成，别拿它做关联键
  }
}
```

- **关联键**：`userName` 可读，但会随企业邮箱或显示名变化；永不变的是 `dingtalk.unionid`。
  两人得出同一个 `userName`（同名且都没有企业邮箱）时只保留原持有者，另一人不在列表里、也登录不了。
- `ranks` 的职级词表与 `jobLevel` 的「职务」字段按本组织定，别的企业多半拿到 `[]` 与 `null`。
- ⚠️ **`dingtalk.extension` 原样透传**：钉钉后台新加的自定义字段（可能是手机号）下次刷新后就会出现在响应里。

## 审计

认证（成功与被拒）与组织 API 的每一次调用（**含鉴权失败**，记来件声称的 appKey）都落在
`dingorg_audit_log`。扫码回调在拿到身份之前被拒的也记，`actor_id` 为空。secret 与钉钉授权码
不进审计。没有查询界面，用 SQL：

```sql
select at, action, status, actor_type, actor_id, ip, details
from dingorg_audit_log order by id desc limit 50;

-- 与日志串联。reqId 进程内自增、跨副本跨重启会重复，配合时间与日志里的 hostname 缩小范围
select * from dingorg_audit_log
where request_id = '<reqId>' and at > now() - interval '1 hour';
```

## 日志

所有进程往 stdout 写一行一个 JSON（pino），`level` 是字符串、`time` 是 ISO UTC：

```json
{"level":"warn","time":"2026-09-29T04:00:01.234Z","pid":1,"hostname":"dingorg-server-7c9f-abcde",
 "reqId":"req-3f","msg":"钉钉调用失败",
 "err":{"type":"DingtalkError","message":"…","errcode":60020,"status":200,"stack":"…"}}
```

- 级别由 `LOG_LEVEL` 控制（默认 `info`），chart 里所有 Pod 共用 `values.env.LOG_LEVEL`。
- 请求里的日志带 `reqId`，即审计的 `request_id`；`hostname` 是 Pod 名。
- 错误在 `err` 里，带 stack 与 cause 链；钉钉的错误另带 `errcode` / `code` / `status`。
- **不进日志**：请求 URL 的 query string、SQL 参数、旧版钉钉接口 URL 里的 access_token。
- healthz 探针的请求不记，探测失败时记一行 warn。
- 本地可接 pino-pretty：`pnpm dev | pnpm dlx pino-pretty --customLevels 'trace:10,debug:20,info:30,warn:40,error:50,fatal:60'`

## 部署（K8s / Helm）

```bash
# 1. 先建 Secret（chart 不自建，且必须先于 chart 存在）
kubectl create namespace dingorg-prod
kubectl create secret generic dingorg-app -n dingorg-prod \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=DINGTALK_APP_KEY='...' \
  --from-literal=DINGTALK_APP_SECRET='...' \
  --from-literal=OIDC_CLIENTS_JSON="$CLIENTS"   # pnpm -s oidc:new-client 的输出

# 2. 填 values 后部署。--wait：部署后的快照刷新要打到新版本的 Pod
cp charts/dingorg/values.example.yaml values.prod.yaml
helm upgrade --install dingorg ./charts/dingorg -n dingorg-prod -f values.prod.yaml \
  --wait --timeout 15m
```

产出：Deployment + Service + Ingress + 两个 CronJob（`oidcpurge`、`orgsync`）+ migrate Job
（`pre-install,pre-upgrade` hook）+ 部署后的 orgsync Job（`post-install,post-upgrade` hook）。
需要 Kubernetes ≥ 1.26（Job 用了 `podFailurePolicy`）。

- 必填的 values：`image.repository`、`image.tag`、`ingress.host`（`OIDC_ISSUER` 从它派生）。
- **每次 install / upgrade 后自动刷新一次自有快照**，首次部署不用手动触发。它失败（最常见是出口
  IP 还没进白名单）会让这次 release 标成失败；修好后重跑：
  `kubectl create job --from=cronjob/dingorg-orgsync <任务名> -n <ns>`。关掉：`syncOnDeploy: false`。
- ⚠️ **改了 Secret 之后必须 bump `values.secretVersion`**，否则常驻进程手里还是旧值。
- **`orgsync` 失败要配告警**：它挂了的症状是静默的 —— 离职的人一直能登录。它经集群内 Service
  调 `POST /api/v1/sync`，失败隔 2 分钟重试、共 3 次。schedule 在 `cronjobs.orgsync.schedule` 改。
  它报 `401` 不一定是 secret 错了：钉钉 token 端点故障、被限流也是 401（REST 面对谁都不说原因），
  真实原因在服务端日志的「应用凭证校验失败」里。
- `POST /api/v1/sync` 大组织可能要几十秒，Ingress 的 `proxy-read-timeout`（nginx 默认 60 秒）要留够。
- **本服务的出口 IP 要进每个调用方钉钉应用的白名单**，换出口等于同时打断所有调用方。

## 常用命令

```bash
pnpm dev              # 起服务（tsx watch）
pnpm build            # tsup 打包到 dist/
pnpm typecheck
pnpm check[:write]    # biome
pnpm test             # vitest；集成测试需要 DATABASE_URL，缺了会静默跳过
pnpm db:generate      # 改完 schema 生成迁移
pnpm db:migrate       # 本地迁移（drizzle-kit）
pnpm migrate          # 本地试跑镜像里的迁移入口
pnpm orgsync          # 刷新自有应用快照（即每日 cron 的入口）
pnpm -s oidc:new-client --name <名字> --redirect-uri <回调>   # 生成下游 client（只在本机跑）
pnpm db:studio
```

## License

MIT
