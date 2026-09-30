# AGENTS.md

规范与地图。系统是什么、怎么接入、怎么部署见 `README.md`；规则的理由在所指代码的注释里，
改之前先读那里。

## 边界

两件事：**钉钉认证 → 标准 OIDC**（node-oidc-provider），**组织架构快照 → REST 出口**
（调用方出示 API key，读自有应用那一份快照；钉钉凭证只在服务端）。
外部依赖只有 Postgres，下游是 authentik。以下刻意不存在，别加回来：

- 应用门户、应用角色、`roles` claim、「谁能用哪个应用」的授权、分组管理 —— 下游的活
- 下游 client 的注册端点 / 管理 API —— client 是静态配置
- REST 面认 OIDC client 或调用方的钉钉应用凭证 —— REST 只认 `AUTH_JSON` 里的 apikey 项
- 管理界面

**准入判据只有一条：在自有应用（`DINGTALK_APP_KEY`）的组织快照里。**

## 地图

```
src/
├── server.ts        常驻进程入口（自己不刷新任何快照）
├── app.ts           fastify 组装（集成测试调的就是它）
├── env.ts           环境变量（常驻服务 / DB 任务 / orgsync 三个子集）
├── deps.ts          db（单池）
├── log.ts           pino 根 logger · err 序列化与脱敏
├── resources.ts     advisory lock 键 · app_secrets 键 · 审计动作串
├── db/              连接池工厂 · schema/
├── domain/          纯逻辑、无 IO：oidc-client · api-key · config-json · org-api
│                    · org-snapshot · org-identity · org-title · sync · audit
├── oidc/            provider · adapter · account（准入）· keys · mount · new-client
├── interaction/     钉钉扫码交互（唯一调钉钉用户级 OAuth 的地方）
├── dingtalk/        client · access-token（自有应用）· fetch-org（只读钉钉）
├── sync/            snapshot（读 / 刷新 / findMember）
├── api/             REST 面：guard（鉴权 + 审计 + 错误翻译）· org · sync
├── auth/            API key：Bearer 解析 · 校验 · new-api-key
├── audit/           审计写入
├── routes/          healthz（不经 guard）
└── bin/             一次性入口：migrate · cron/oidcpurge · cron/orgsync
                     · auth（`auth:oidc` / `auth:apikey`，只在本机跑，不进镜像）
drizzle/             迁移
charts/dingorg/      Helm：Deployment + CronJob + migrate Job + 部署后的 orgsync hook
Dockerfile           一个镜像、多入口
```

保持**单包**：不引入 workspace、Next 或第二个进程。

## 不要无意改回的权衡

### 身份

- **`sub` = 钉钉 unionId，别换**：userid 离职重入职会变，换锚点 = 所有下游的用户数据错位。
- ⚠️ **准入只查自有 appKey 的快照**，`oidc/account.ts` 与 interaction 回调用同一条判据。
  `org_snapshots` 里可能留着别的 appKey 的行（换过 `DINGTALK_APP_KEY`），判松了是静默的；
  两处不一致是扫码死循环。
- **登录不自动建用户**，快照里查不到就回我们自己的 403 页。
- **unionId 缺失 = 登录不了**：钉钉「个人信息」权限点没开时它静默缺失。
- ⚠️ **email 只取 `org_email`**（它以 `email_verified: true` 发出去）：别加回钉钉的 `email`
  字段，也别按姓名拼域名。没有企业邮箱的人 `email` 与 `email_verified` 都不出现。
- **email 与 userName 的归一化只在 `domain/org-identity.ts`**；撞名规则是
  `domain/org-snapshot.ts` 的 `pickOwner`（原持有者优先）。
- **拉取用 `topapi/v2/user/list`，别退回 listsimple**（没有 unionid / org_email）。
- **钉钉用户级 OAuth 的非标准细节只在 interaction 层**，下游一律走标准 OIDC。

### 下游 client（`domain/oidc-client.ts`）

- ⚠️ **client 全部来自 env `AUTH_JSON` 的 oidc 项**，不落库，别加回注册端点。
  加 / 换下游 = 改 Secret + bump `secretVersion`。
- ⚠️ **client 只管登录，不能调 REST 面**：别给它加 REST 权限，理由见 `domain/api-key.ts` 文件头。
- ⚠️ **client 凭证与钉钉凭证无关**：`id` 强制 UUID，secret 不得等于 `DINGTALK_APP_SECRET`。
- ⚠️ **secret 只收 URL 不保留字符**：oidc-provider 对 Basic 凭证做 form 解码，原文发 `+` 的下游
  （如 authentik）会被当成空格，启动正常、那个下游全员登录失败。
- ⚠️ **每个下游都能登录全组织的人**：准入不分 client，谁能用哪个下游是下游自己的事。
- **`pnpm auth:oidc` / `pnpm auth:apikey`（`bin/auth.ts`）只在本机跑，别加进 tsup / 镜像**
  （secret、key 随 stdout 进日志）。`--merge` 要显式给，别改成探测 stdin（理由在文件头）。
- ⚠️ **回调地址 = `redirectUris` 精确匹配 + 可选的 `redirectUriRegexes` 正则**。正则包成
  `^(?:…)$` 整串匹配、命中的还要过 `redirectUriSchema`，这两层别删：正则写宽了就是开放重定向，
  它们是剩下的护栏。正则靠覆写 `Client.prototype.redirectUriAllowed` 接进上游，升级
  oidc-provider 时哨兵是 `app.integration.test.ts` 的正则用例。
- ⚠️ **`createOidcProvider` 末尾对每个 client 的 `Client.find` 别删**：静态 client 要到那时才过
  上游校验，删了配错就变成「启动正常、那个下游所有人登录失败」。所以 `env.ts` 的 zod 只管
  比上游更严的规则。
- **scope / grant / token 认证方式是常量**，不做成可配、不按 client 配。`CLIENT_SCOPE` 与
  `oidc/provider.ts` 的 `claims` 映射改一边要改另一边。
- **不签发 refresh token**：没有 `offline_access`，client 也不登记 `refresh_token` grant。

### OIDC Provider（`oidc/`）

- ⚠️ **加新的 `/oidc/*` 路由要在 `oidc/mount.ts` 的 `PASSTHROUGH_PREFIXES` 里加一条**，
  否则被吞成 404。
- **interaction 回调必须在 `/oidc/interaction/:uid` 之下**（cookie 的 path 作用域）。
- **`devInteractions` 必须关；`conformIdTokenClaims: false` 不能删。**
- **JWKS 与 cookie keys 落 `app_secrets`**，别改成每次启动随机。⚠️ 签 id_token 的是 RS256 那把。
- **`oidc_payloads` 的过期行只靠 `oidcpurge` cron 删**。别换成自带的 MemoryAdapter（LRU 会
  挤掉在途授权码）。
- **issuer = `PUBLIC_ORIGIN` + `/oidc`（`oidc/mount.ts` 的 `oidcIssuer`）**，env 只收规范形式的
  origin。`PUBLIC_ORIGIN` 必须与对外可达地址精确一致，别改成从 `X-Forwarded-Host` 推（下游逐字
  比对 `iss`）。`provider.proxy` 不可删。
- ⚠️ **`PUBLIC_ORIGIN` 只在非 production 时默认 `http://localhost:3080`**（`env.ts` 的
  `withDevDefaults`）。Dockerfile 的 `NODE_ENV=production` 别删：删了，镜像里缺它就不再启动失败，
  而是带着 localhost 的 issuer 跑起来、全员登录失败。
- **是否信任 `x-forwarded-*` 从 `PUBLIC_ORIGIN` 的协议推（`env.ts` 的 `trustsProxyHeaders`）**，
  别加回单独的开关：fastify 与 oidc-provider 两处必须读同一个值。
- **claim 集合固定**：`sub` / `name` / `preferred_username` / `email` / `email_verified` /
  `picture`。加一项等于改跨系统契约。
- **撤销访问不即时**：最长约 24 小时（每日 orgsync），未过期的 access_token（1 小时）照样能用。
  ⚠️ 删 `oidc_payloads` 里的会话不等于踢下线，下游会话在我们之外。

### REST 面（`api/`、`auth/`）

- **判据只有一条：`Bearer dok_<id>_<secret>` 与 `AUTH_JSON` 里同 id 的 apikey 项的 `key` 相符**。
  别加回「调用方出示钉钉凭证」：那条路要替陌生 appKey 外呼，就得再加限流与 secret 哈希校验，
  别的企业的通讯录也会进库。
- ⚠️ **API key 与 OIDC client 相互独立，别改成从 client secret 派生**（理由在 `domain/api-key.ts`）。
- **两者同放 `AUTH_JSON`、按 `type` 区分，只是存放在一处**（`domain/config-json.ts`）：消费方用
  `pickAuthEntries` 只取自己那种；两边 schema 都 strict，别加一项既能登录又能调 REST 的 type。
  `name` 不分 type 全局唯一。
- ⚠️ **`AUTH_JSON` 里是 key 明文**：能读那个 Secret 就能读全组织通讯录，且不受钉钉 IP 白名单
  约束。Secret 的读权限按此收紧。
- **校验不外呼、不限流**：key 含 256 位随机。比对在 `auth/api-key.ts`（按 id 取项，配置里的 key
  启动时哈希一次，`timingSafeEqual` 比哈希）。挂在请求上的调用方只有 id 与 name。
- ⚠️ **每把 key 读的都是同一份全组织快照**，不按调用方划范围。
- **鉴权失败一律 401、不说原因；鉴权之后的钉钉失败要讲原因**（502 / 503 / 504），翻译在
  `api/guard.ts` 作用域的 `setErrorHandler`，路由里不 try/catch。
- **guard 必须包在 `app.register` 作用域里**，否则跑遍 `/healthz` 与 `/oidc/*`。
- ⚠️ **别用 `decorateRequest` 预置 `auditPatch`**：共享同一个对象引用，并发时审计串号。
- **组织数据不分页**。改分页时第二排序键必须唯一（userName）。
- ⚠️ **判定别用 `email` / `dingtalk.orgEmail`**：覆盖率约五成、可为 null。身份走 `userName`，
  永不变的是 `unionid`。
- ⚠️ **`extension` 原样透传，字段集合由钉钉后台管理员定义**：要收口就在
  `domain/org-snapshot.ts` 的 `toUser` 加允许键白名单。
- **`GET /api/v1` 自描述端点：加端点要来补一行**，漏了没有检查会红。

### 组织快照（`sync/`）

- **一个 appKey 一行、整份替换，只写自有 appKey 那一行**。别加回锁、水位线、独立连接池。
- **并发刷新靠 `fetched_at` 条件写；失败不动 `data`**（清掉自有快照 = 全员登录失败）。
- **刷新只有一份实现 `refreshSnapshot`，两个入口**：`POST /api/v1/sync`（API key 调用方）与
  orgsync（直接调，不经 HTTP、不要凭证，审计 actor 是 `system`）。冷却、失败记录都在函数里，
  别在入口里另写；审计说法共用 `domain/sync.ts` 的 `SYNC_TRIGGER_SUMMARY`。常驻进程自己不定时刷新。
  ⚠️ 空库时谁都登录不进来：部署 hook（`syncOnDeploy`）会跑一次，本地是 `pnpm orgsync`。
- **钉钉 token 在 `doRefresh` 里、冷却判断之后、`try` 之内申请**：冷却期内不申请；token 失败
  （secret 错、钉钉故障）同样进 `error`、回 502，别挪回 guard（那会变成不说原因的 401）。
- **读路径不外呼**，从没成功过才当场拉一次。刷新有单飞 + 60 秒冷却，⚠️ 冷却从上一次**尝试**
  的**结束**时刻算。
- **申请 token、拉取、组装、写库哪步失败都记进 `error`**，只存 `describeFailure` 过的说法（会回给调用方）。
- ⚠️ **`fetchOrg` 任一部门失败就放弃整轮**，别加「跳过失败部门」：少一个部门 = 静默踢人。
- **orgsync 的重试间隔必须长于冷却；返回不等于成功**：冷却期内拿到的是现有快照，它挂着
  `error` 就算这一轮失败。它挂了是静默的，Job 失败要配告警。
- **别往 `buildApp` 里加启动即外呼的逻辑**：集成测试会拿假凭证去真打钉钉。

### 钉钉出口（`dingtalk/`）

- **企业 token 是自有应用的惰性 cache-aside**，`dingtalk/access-token.ts` 文件头列了四个
  不可省的细节。
- ⚠️ **`invalidateAccessToken` 唯一的生产调用方在 `sync/snapshot.ts`**，哨兵只有
  `snapshot.integration.test.ts` 一条。删模块时顺着被删代码的调用列表反查。
- **`DingtalkError` 的 `code` / `status` 是结构化字段**。判 token 失效别匹配 `AccessToken` 字样。
- **所有出口 30 秒超时。`healthz` 只探 DB、不探钉钉。**

### 职级（`domain/org-title.ts`）

- ⚠️ **真相源是 `title`，不是钉钉「角色」**（`role_list` 被当成审批权限桶）。
- **一人多职用「；」「;」「、」分隔**；`-` 与 `&` 不是分隔符。`extension.职务` 单值、会丢职，只作回退。
- ⭐ **`user/list` 的 `leader` 相对请求里的 `dept_id`**，落点是 `depts[].isLeader`。不要改成
  逐人调 `user/get`。
- **职级词表与「职务」字段名按本组织定**，换企业部署时两处一起过目。
- **部门归属一律走 `depts`**，`title` 里的部门路径只当文字看。

### 审计（`audit/`）

- **认证与组织 API 的每一次调用都记，含鉴权失败**，不设开关。扫码回调的每一种拒绝都走
  `interaction/routes.ts` 的 `deny`。
- **secret 与 API key 一个字节都不进审计**：只取 key 的 id，`path` 剥 query，请求头不记。
- **「看了一眼」与「拉走了」分开记**（`sync.status` / `sync.trigger`）。
- ⚠️ **来件能控制的值不能让写入失败**（写失败只剩一行日志）：API key 的 id 只收定长格式
  （`parseApiKeyId`），格式不对的记为空；`ip`（信任代理时来自 X-Forwarded-For）在 `recordAudit`
  截断；扫码回调的 summary 只写固定文案。
- **actor / target 是快照、不建外键**，写入时就必须拿对。
- ⚠️ **`actor_type` 是 PG 枚举，只加不删**：`api_key` 是 REST 调用方，`system` 是 orgsync。新代码先于
  迁移上线时，写不进的审计是静默丢失的（本地升级后先 `pnpm migrate`）。
- **`request_id` 是 fastify 的 reqId**，进程内自增、跨副本会重复。快照刷新的日志
  走请求的 logger 才带得上它。

### 日志（`log.ts`）

- **全进程一个 pino 根 logger**：请求里用 `req.log`，函数收 `Log` 类型。别再 `pino()` 第二个
  实例或用 `console.*`（例外只有 `bin/auth`：stdout 只能是 JSON）。
- ⚠️ **Error 只放 `err` 键**，也别先 `err.message` 再记（cause 链会丢）。
- ⚠️ **脱敏在 `err` 序列化器与错误构造处**（`DrizzleQueryError` 的 SQL 参数、`DingtalkError.endpoint`
  的 query）。新增带 URL 或参数字段的错误类型同理。
- **请求日志的 url 剥 query**，与审计 `path` 同一实现。
- **`LOG_LEVEL` 在 `log.ts` import 时就读**，`env.ts` 只管校验。测试默认 silent 写在
  `vitest.config.ts`，必须在 `loadEnvFile` 之前。
- **`oidc/provider.ts` 的 `server_error` 与 `error` 两个监听别删**：前者是上游自己不记的 500；
  后者接住逃出上游的异常，没人监听时 Koa 用 `console.error` 打 stack，绕过脱敏。
- **路由级 `logLevel` 会覆盖根级别**，只想「至少 X」时用 `log.ts` 的 `atLeast`（healthz 就是）。

## 部署

- **一个镜像、多入口**，command 必须显式给。占位 CMD 报错退出 64，别删也别换成能跑的默认值。
- **容器不设 `TZ`**，一律 UTC。
- **敏感值不进 helm values**，chart 引用预先存在的 Secret 且不自建。
- **每个一次性任务只注入它用得到的 Secret 键**（`_helpers.tpl` 的 `dingorg.secretEnv`），与
  `env.ts` 的 `taskEnvSchema` / `orgSyncEnvSchema` 对齐，别换回 `envFrom`。
- **CronJob 的 `backoffLimit` 每个显式给**：orgsync 0（进程内重试），oidcpurge 2。任务 Job 共用
  `_helpers.tpl` 的 `dingorg.taskJobSpec`，其中 `podFailurePolicy` 让驱逐等中断不计入（k8s ≥ 1.26）。
- **每次 install / upgrade 后 hook 跑一次 orgsync**：首次部署与升级后的快照都靠它（hook 用新镜像
  直接刷新，不依赖常驻 Pod 滚完）；它失败会让 release 标成失败。
- ⚠️ **改了 Secret 必须 bump `values.secretVersion`**。
- **`PUBLIC_ORIGIN` 由 chart 从 `ingress.host` 派生**。
- **端口固定 3080，不做成可配**：`env.ts` 的 `LISTEN_PORT`、Dockerfile、chart 的 `server.yaml`
  三处同一个数。
- **orgsync 拿库与钉钉凭证，不拿 `AUTH_JSON`**；`AUTH_JSON` 里可以没有 apikey 项（= 不开 REST 面）。
- **本服务的出口 IP 要进自有钉钉应用的白名单**，换出口等于同时打断登录与快照刷新。
- **deploy 不进 CI。写完 Dockerfile 一定 `docker run` 一次。**

## 写代码时

- **资源名不要硬编码**：lock 键、`app_secrets` 键、审计动作串从 `~/resources` import。
- **schema 改动**：改 `src/db/schema/*.ts` → `pnpm db:generate` → 逐行读生成的 SQL → 一并提交。
  不提供 `db:push`。
- ⚠️ **pgEnum 的类型名必须带 `dingorg_` 前缀**；`casing: "snake_case"` 在 `drizzle.config.ts`
  与 `db/index.ts` 两处一致。
- **domain 不依赖 IO 层**。⚠️ 给 `DeptUser` 加字段却忘了加进 `MemberFields` 不是类型错误。
- **新增环境变量**：`src/env.ts` + `.env.example`；非敏感的再加进 `values.yaml`，敏感的进 Secret。
- **相对 import 不写 `.js`；JSON / tsconfig 里只用行注释。**
- **`pnpm-workspace.yaml` 的 `allowBuilds: esbuild` 不能删。**

## 验证

```bash
pnpm check && pnpm typecheck
pnpm vitest run --reporter=verbose   # 逐个确认集成测试是 passed 而非 skipped
```

- **集成测试无 `DATABASE_URL` 时静默跳过**；`vitest.config.ts` 的 `loadEnvFile` 那一行不能删。
- **哨兵**：快照 `sync/snapshot.integration.test.ts` · token `dingtalk/access-token.integration.test.ts`
  · API key `auth/api-key.test.ts`、`domain/api-key.test.ts` · OIDC 契约与 REST 面
  `app.integration.test.ts` · 凭证配置 `domain/config-json.test.ts`、`domain/oidc-client.test.ts`、
  `env.test.ts`、`oidc/new-client.test.ts` · 脱敏 `log.test.ts`
  · 职级 `domain/org-title.test.ts`。
- **准入必跑 `oidc/account.integration.test.ts`**，「只出现在别的应用快照里的人拒绝」那条不能删。
- **手测**：
  - REST：无凭证 / 错 key / OIDC client 凭证 / 钉钉 AppKey:AppSecret 都 401 且不说原因；
    审计里 grep 不到 key，`actor_type` 是 `api_key`。
  - OIDC 全链路（真实钉钉凭证）：authorize → 扫码 → token → userinfo；没有企业邮箱的人没有
    `email` / `email_verified`；不在自有快照里的人看到 403 页。
  - 职级：清空某人职位 → 刷新 → 职级变空；部门改名 → 刷新 → 主管标记跟着新名字走。
  - 刷新：服务重启后日志里没有快照刷新；`pnpm orgsync` 成功且审计多一条 `sync.trigger`（actor
    `system`），60 秒内再跑也是 exit 0；`DATABASE_URL` 指向空端口 → 共 3 次尝试后 exit 1。
  - 日志：带 `?code=xxx` 访问扫码回调，日志里 grep 不到 `xxx`；healthz 不出现；
    `LOG_LEVEL=verbose` 启动是一行 fatal JSON、exit 1。
  - chart：`helm lint charts/dingorg -f charts/dingorg/values.example.yaml`；`helm template` 看两个
    CronJob 与部署 hook 各自只拿到 `secretKeys` 里的键，`--set env.LOG_LEVEL=debug` 时五类 Pod 都有它。

## 注释纪律

写 WHY 不写 WHAT，一条理由一两行。**不写历史与过程**：任务追溯、「曾经…后来删了」、实测经过与
日期、「将来…」。要防回退就写成规则：「别加回 X：理由」。同一条理由只写一处，别处引用。
中英按上下文混写。
