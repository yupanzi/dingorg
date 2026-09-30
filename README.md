# dingorg

把一个**钉钉企业内部应用**变成组织的身份基础设施。只做两件事：

1. **钉钉认证 → 标准 OIDC**：下游用任意标准 OIDC 客户端库接入，底层由钉钉扫码完成认证。
2. **钉钉组织架构 → 同步镜像 → REST 出口**：调用方出示本服务配发的 **API key**，读到自有钉钉应用
   可见范围内的成员与部门（含 unionId、企业邮箱、职级、部门主管）。钉钉凭证只在本服务手里，调用方
   碰不到；同步来的组织数据存在 Postgres 的镜像表里。

外部依赖只有 Postgres。没有管理界面；凭证只有两种静态配置：登录用的 OIDC client 与 REST 用的
API key，同放在 `AUTH_JSON` 一个数组里、按 `type` 区分，两者互不相干。
`GET /api/v1` 列出全部端点与鉴权方式。

## 架构

```
                  ┌──────────── dingorg（单进程）─────────────┐
  钉钉扫码 ──────► │  /oidc/*        OIDC Provider            │ ──► 下游应用
                  │  /oidc/interaction  钉钉登录交互          │     (authentik…)
                  │  /api/v1/*      组织数据（自有应用）      │ ◄── 内部系统
                  └──────────────────┬───────────────────────┘     （出示
                                     │                              API key）
                                  Postgres
                                     ▲
  cron orgsync ──────────────────────┤  （每天同步一次钉钉，与 POST /api/v1/sync 同一份实现）
  cron oidcpurge ────────────────────┘  （清理 OIDC 过期工件）
```

一个常驻进程 + 三个跑完即退的任务（migrate、oidcpurge、orgsync），共用一个镜像。

组织同步只有一份 —— 自有应用（`DINGTALK_APP_KEY`）的：一行同步状态加部门、成员、成员-部门三张
镜像表，每轮在一个事务里整体换新。它既是 REST 出口的数据，也是 **OIDC 准入的唯一依据**（当前成员才
能登录）。同步只有一份实现，两个入口，常驻进程自己不定时同步：

- 每日 cron orgsync（默认 UTC 04:00）直接调同步，不经 HTTP、不需要凭证。离职生效、新人可登录
  的窗口因此**最长约 24 小时**。
- `POST /api/v1/sync`：持 API key 的调用方手动触发。
- **多副本安全**：同一时刻只有一个副本（或任务）在拉钉钉，靠同步状态行上的租约；撞上的一方不外呼，
  直接用现有数据。重复同步是幂等的：钉钉没变，结果就不变。
- 这一轮里不在了的成员（离职、移出可见范围）**标记离开、整行保留**，不再能登录、也不出现在 API 里。
- ⚠️ **空库时谁都登录不进来**：K8s 部署时 hook 会跑一次，本地要手动 `pnpm orgsync`。
- 读的时候不按时间过期：从没同步成功过才当场同步一次，之后原样返回。

## 快速开始

```bash
# 1. 准备一个空的 PostgreSQL database，填好 .env（缺失或不合法时启动会列出全部问题）
cp .env.example .env
pnpm install

# 2. 生成一个下游 OIDC client，输出的那行 JSON 填进 .env 的 AUTH_JSON
pnpm -s auth:oidc --name local --redirect-uri http://localhost:9000/callback

# 3. 建表、起服务
pnpm db:migrate
pnpm dev          # http://localhost:3080

# 4. 同步一次自有应用的组织数据（不同步的话谁都登录不进来；直连库与钉钉，不依赖服务在跑）
pnpm orgsync
```

验证：

```bash
curl -s localhost:3080/healthz
curl -s localhost:3080/api/v1 | jq
curl -s localhost:3080/oidc/.well-known/openid-configuration | jq
curl -s -H "Authorization: Bearer $API_KEY" localhost:3080/api/v1/sync | jq   # 配了 API key 的话
```

## 钉钉开放平台配置清单

在钉钉开发者后台创建**企业内部应用**，然后：

| 项 | 位置 | 漏了会怎样 |
| --- | --- | --- |
| AppKey / AppSecret | 应用凭证 | 填进 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` |
| **本服务的出口 IP 白名单** | 开发配置 | ⚠️ 组织拉取报 `60020`，但 `gettoken` 正常 —— 极易误判成凭证问题 |
| **`Contact.User.Read`** 权限点 | 权限管理 | ⚠️ 扫码后返回 `AccessTokenPermissionDenied` |
| 通讯录**个人信息**读权限 | 权限管理 | ⚠️ unionId 与企业邮箱**静默缺失**：所有人都没有 email，缺 unionId 的人登录不了（它是 `sub`）|
| 回调域名 | 登录与分享 | 填 `PUBLIC_ORIGIN`（本地 `http://localhost:3080`），改它时同步改 |

## 下游如何接入（OIDC）

每个下游一个 client，由部署方**在本机**生成（在 Pod 里跑 secret 会进日志），没有注册端点。
client 只管登录，不能调 REST 面（那是 API key 的事，见「组织数据 API」）：

```bash
pnpm -s auth:oidc --name authentik-prod \
  --redirect-uri https://<authentik>/source/oauth/callback/<slug>/
# stdout：[{"type":"oidc","name":"authentik-prod","id":"<uuid>","secret":"<43 位>","redirectUris":[...]}]

# 预览环境等动态地址：再加 --redirect-uri-regex（整串匹配的正则，可多个），精确地址仍至少一条
pnpm -s auth:oidc --name preview --redirect-uri https://pr-1.preview.example.com/callback \
  --redirect-uri-regex 'https://pr-\d+\.preview\.example\.com/callback'
```

多个下游就是 `AUTH_JSON` 数组里的多个 oidc 项（`name` 在整个数组里唯一，不分 type），改完 Secret
要 bump `secretVersion`。下游填：

| 项 | 值 |
| --- | --- |
| discovery | `https://<域名>/oidc/.well-known/openid-configuration` |
| client_id / client_secret | 生成的 `id` / `secret` |
| scope | `openid profile email` |
| 流程 | authorization code，**强制 PKCE** |
| token 端点认证 | `client_secret_basic` 或 `client_secret_post` |

- 回调地址：`redirectUris` 精确匹配；可选的 `redirectUriRegexes` 是**整串匹配**的正则，命中的
  地址仍须 https（loopback 例外）、不带 `#`、不超过 500 字符。两种都只对登记它的 client 有效。
  填错是进程启动失败，并指出哪个 client 的哪一条。
- ⚠️ **正则写宽了就是开放重定向**，授权码会交到别人手里：`.` 要转义（JSON 里写 `\\.`），别用
  `.*` 跨过 host。能列举的地址就用 `redirectUris`。
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

把人从钉钉通讯录移除后，下一次同步（**最长约 24 小时**）把他标记为离开，之后新的登录被拒；但
**未过期的 access_token（1 小时）仍然可用**，下游自己的会话更在本系统之外。要立即切断：

1. 手动触发一次同步：`kubectl create job --from=cronjob/dingorg-orgsync <任务名> -n <ns>`，
   或 `curl -X POST -H "Authorization: Bearer $API_KEY" https://<域名>/api/v1/sync`（任一 API key）；
2. 再去各个下游分别登出。

## 组织数据 API

凭证是部署方配发的 **API key**（`Authorization: Bearer dok_…`），与 OIDC client 凭证、钉钉凭证
都无关，也不接受它们。每个调用方一把，由部署方**在本机**生成：

```bash
pnpm -s auth:apikey --name hr-system
# stdout：[{"type":"apikey","name":"hr-system","key":"dok_<8 位 hex>_<43 位随机>"}] → 并进 AUTH_JSON，key 交给调用方
```

两个生成命令都可以带 `--merge`：从 stdin 读现有的 `AUTH_JSON`，输出接上新项的完整数组，并按启动时
同一份规则整体校验（重名等在生成时就报）。给已部署的实例加一项：

```bash
kubectl get secret dingorg-app -n <ns> -o jsonpath='{.data.AUTH_JSON}' | base64 -d \
  | pnpm -s auth:apikey --name bi --merge     # stdout 是新的完整 AUTH_JSON，替换 Secret 后 bump secretVersion
```

- `AUTH_JSON` 里没有 apikey 项就是不开 REST 面（全部 401），登录与每日同步不受影响。
- 配置里**是 key 明文**，丢了能从 Secret 里取回。⚠️ 也就是说能读这个 Secret 的人都能读全组织
  通讯录（API key 不受钉钉 IP 白名单约束），Secret 的读权限要按此收紧。
- key 泄漏了只影响它自己：删掉 `AUTH_JSON` 里那一项（或换成新生成的）+ bump
  `secretVersion`，登录与别的调用方都不受影响。加调用方同理。
- ⚠️ **每把 key 读到的都是全组织通讯录**（自有应用在钉钉后台的可见范围），不按调用方划范围。
- 「个人信息」权限点没开时 `email` 与 `dingtalk.unionid` 为空（见上面的清单）。

| 端点 | 响应 |
| --- | --- |
| `GET /api/v1/org/users` | `{ users, total, fetchedAt }` |
| `GET /api/v1/org/departments` | `{ departments, total, fetchedAt }`，部门是 `{ id, parentId, name, ancestorIds }`，根部门 id 为 1、名字是企业名 |
| `GET /api/v1/sync` | `{ state, fetchedAt, attemptedAt, error, syncing, userCount, deptCount }`，`state` 为 `never` / `failed` / `ok`，`syncing` 表示有副本正在拉钉钉 |
| `POST /api/v1/sync` | 同上，外加 `refreshed`。**同步地拉完再返回**；别处正在同步时不等它，立即返回 `refreshed: false` |

```bash
curl -s -H "Authorization: Bearer $API_KEY" https://<域名>/api/v1/org/users | jq
```

- 第一次调用当场同步（几百人要几秒到几十秒），之后原样返回；`fetchedAt` 是数据时刻。
- 距上一次同步尝试（成功或失败）结束不到 1 分钟、或别处正在同步时不外呼：有数据就原样返回
  （`refreshed: false`），没有则回 `503`。
- 只列当前可见的人，离开的人不出现（库里留着离开记录，不经 API 暴露）。同步失败时已有数据原样保留。
- 错误体统一是 `{ "error": { "code", "message" } }`：
  - `401 unauthorized`：凭证不对，**一律不说原因**（没带、格式不对、未知 id、key 错都是它）。
  - `502 dingtalk_error`：拉取时钉钉报错（含本服务的钉钉 token 申请失败），带
    `dingtalk: { errcode, code, status }`（最常见是 `60020`：本服务的出口 IP 不在自有应用的白名单里）。
  - `503 not_synced`：自有应用还没有可用的数据，`message` 讲原因：上一次刚失败（带失败原因）或别处
    正在同步，这两种带 `Retry-After`；现有数据属于另一个钉钉应用（换过 `DINGTALK_APP_KEY`）时不带，
    要先显式同步一次（orgsync 或 `POST /api/v1/sync`）。
  - `504 dingtalk_timeout`：请求钉钉超时。

成员对象里，系统字段平铺在顶层，钉钉原始字段收在 `dingtalk` 里（保持钉钉的字段名）：

```jsonc
{
  "userName": "alice",              // 企业邮箱 local part，没有则取显示名；当前成员内唯一
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
- ⚠️ **`dingtalk.extension` 原样透传**：钉钉后台新加的自定义字段（可能是手机号）下次同步后就会出现在响应里。

## 审计

认证（成功与被拒）与组织 API 的每一次调用（**含鉴权失败**，记来件声称的 key id）都落在
`dingorg_audit_log`。REST 调用的 `actor_type` 是 `api_key`，`actor_name` 是 key 的 name；
每日 orgsync 的是 `system`。扫码回调在拿到身份之前被拒的也记，`actor_id` 为空。secret、key 与钉钉授权码不进审计。没有查询界面，用 SQL：

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
# 1. 先建 Secret（chart 不自建，且必须先于 chart 存在）。AUTH_JSON 用生成命令攒：先生成 client，
#    再用 --merge 接上 API key（没有 REST 调用方就只要第一行）
AUTH=$(pnpm -s auth:oidc --name authentik-prod --redirect-uri https://<authentik>/source/oauth/callback/<slug>/)
AUTH=$(echo "$AUTH" | pnpm -s auth:apikey --name hr-system --merge)
kubectl create namespace dingorg-prod
kubectl create secret generic dingorg-app -n dingorg-prod \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=DINGTALK_APP_KEY='...' \
  --from-literal=DINGTALK_APP_SECRET='...' \
  --from-literal=AUTH_JSON="$AUTH"

# 2. 切到要部署的版本（chart 的 appVersion 就是默认的镜像 tag），填 values 后部署
git checkout vX.Y.Z
cp charts/dingorg/values.example.yaml values.prod.yaml
helm upgrade --install dingorg ./charts/dingorg -n dingorg-prod -f values.prod.yaml \
  --wait --timeout 15m
```

产出：Deployment + Service + Ingress + 两个 CronJob（`oidcpurge`、`orgsync`）+ migrate Job
（`pre-install,pre-upgrade` hook）+ 部署后的 orgsync Job（`post-install,post-upgrade` hook）。
需要 Kubernetes ≥ 1.26（Job 用了 `podFailurePolicy`）。

- 必填的 values：`image.repository`、`ingress.host`（`PUBLIC_ORIGIN` 从它派生）。`image.tag` 留空
  即所用 chart 的 appVersion，要钉别的版本才填。
- **每次 install / upgrade 后自动同步一次组织数据**，首次部署不用手动触发。它失败（最常见是出口
  IP 还没进自有应用的白名单）会让这次 release 标成失败；修好后重跑：
  `kubectl create job --from=cronjob/dingorg-orgsync <任务名> -n <ns>`。关掉：`syncOnDeploy: false`。
- ⚠️ **改了 Secret 之后必须 bump `values.secretVersion`**，否则常驻进程手里还是旧值。
- **`orgsync` 失败要配告警**：它挂了的症状是静默的 —— 离职的人一直能登录。它直连库与钉钉
  （与 `POST /api/v1/sync` 同一份实现），失败隔 2 分钟重试、共 3 次，原因在它的日志里，也记进
  状态端点的 `error`。撞上别处正在同步（如部署 hook 与 cron 重叠）时等它结束，不算失败。schedule 在
  `cronjobs.orgsync.schedule` 改。
- ⚠️ **换了 `DINGTALK_APP_KEY` 要显式同步一次**：旧应用的数据不会被自动接管（读的时候回 503）。
  upgrade 的 hook 会做；`helm rollback` 没有 hook，回滚后手动
  `kubectl create job --from=cronjob/dingorg-orgsync <任务名> -n <ns>`。
- `POST /api/v1/sync` 大组织可能要几十秒，Ingress 的 `proxy-read-timeout`（nginx 默认 60 秒）要留够。
- **本服务的出口 IP 要进自有钉钉应用的白名单**，换出口等于同时打断登录与组织同步。

## 版本与发布

全自动，由 [semantic-release](https://semantic-release.gitbook.io/) 按提交信息决定：push 到 `master`、
CI 的 check 过了之后，自上次发版以来的提交里

| 提交 | 版本 |
|---|---|
| `feat:` | minor（`x.Y.0`） |
| `fix:` / `perf:` / `git revert` 生成的回滚 | patch（`x.y.Z`） |
| type 后加 `!`（`feat!:`）或脚注写 `BREAKING CHANGE:` | major（`X.0.0`） |
| `docs:` `refactor:` `test:` `build:` `ci:` `chore:` `style:` | 不发版 |

发版一次产出：`package.json` 与 `Chart.yaml` 的版本号、`CHANGELOG.md`、`vX.Y.Z` tag、GitHub Release、
镜像 `ghcr.io/yupanzi/dingorg:X.Y.Z` 与 `:latest`（写回的那次提交带 `[skip ci]`）。

提交信息由 commit-msg 钩子（commitlint）校验，格式 `<type>(<scope>): <主题>`；
`git config commit.template .gitmessage` 后 `git commit` 不带 `-m` 会弹出引导。
pre-commit 钩子跑 `pnpm check` 与 `pnpm typecheck`。两个钩子都在 `pnpm install` 时装好。

## 常用命令

```bash
pnpm dev              # 起服务（tsx watch）
pnpm build            # tsup 打包到 dist/
pnpm typecheck
pnpm check[:write]    # biome
pnpm test             # vitest；集成测试需要 DATABASE_URL，缺了会静默跳过；跑完本地组织数据被清空
pnpm db:generate      # 改完 schema 生成迁移
pnpm db:migrate       # 本地迁移（drizzle-kit）
pnpm migrate          # 本地试跑镜像里的迁移入口
pnpm orgsync          # 同步自有应用的组织数据（即每日 cron 的入口，直连库与钉钉）
pnpm -s auth:oidc --name <名字> --redirect-uri <回调> [--merge]   # 生成下游 client（只在本机跑）
pnpm -s auth:apikey --name <调用方> [--merge]                      # 生成 REST API key（只在本机跑）
pnpm db:studio
GITHUB_TOKEN=... pnpm release:dry   # 预演下一次发版（版本号与发版说明），不推送、不建镜像
```

## License

MIT
