# rili-tongbu · 日历同步平台

跨终端日历数据备份与同步平台：华为、iOS、Windows 及其他终端的日历数据，通过统一的同步平台保持实时一致。任意终端新增 / 修改 / 删除日历事件后，其他绑定的终端立即拉取到相同变更。

- 当前版本：**v0.0.3**（版本规则见下文）
- 技术栈：Cloudflare Workers（API + 静态页面）+ D1（关系数据）+ R2（备份快照）
- 部署方式：Cloudflare 控制台绑定 GitHub 仓库，push 后自动部署

## 架构

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 华为终端  │   │ iOS 终端  │   │ Windows  │   │ 其他终端  │
└────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘
     │  POST /api/sync（推送变更 + 拉取增量，设备 Token 鉴权）
     └───────────────┴───────┬──────┴───────────────┘
                             ▼
                 ┌───────────────────────┐
                 │  Cloudflare Worker    │
                 │  ├─ REST API          │
                 │  ├─ 管理控制台（页面）  │
                 │  └─ ICS 订阅输出       │
                 └───────┬───────┬───────┘
                         ▼       ▼
                   ┌─────────┐ ┌────────┐
                   │ D1 数据库│ │ R2 存储 │
                   │ 设备/事件│ │ 备份快照│
                   │ 变更日志 │ │        │
                   └─────────┘ └────────┘
```

核心机制：

1. **增量同步**：每次变更写入 `change_log`（单调递增 `log_id` 作为游标）。终端携带游标调用 `/api/sync`，服务端返回其他终端在该游标之后的所有变更，冲突按 last-write-wins（`updated_at` 新者获胜）合并。
2. **ICS 订阅**：平台输出标准 iCalendar 订阅地址，iOS / Windows 日历应用可直接「添加订阅的日历」，华为日历可通过订阅 / 导入 .ics 接入。
3. **备份**：管理端一键把全量事件快照写入 R2，可随时下载或一键恢复。

## 版本规则

- 首创版本 v0.0.1，此后每次修改仅在**末位 +1**：v0.0.1 → v0.0.2 → v0.0.3 …
- 修改版本时需同步更新：`VERSION`、`wrangler.toml` 的 `[vars] VERSION`。

## 部署

### 方式一：控制台绑定 GitHub 仓库（推荐，当前采用）

1. Cloudflare 控制台 → **Workers 和 Pages** → **创建** → 选择「Workers」→「连接到 Git」，绑定 `zwjdujin/rili-tongbu` 仓库（main 分支）。
2. 构建配置使用仓库根目录的 `wrangler.toml`，Worker / D1 / R2 均可自定义名称：
   - **D1 / R2 名称**：Worker 代码只依赖绑定名 `DB` 和 `BUCKET`，与资源名称无关。想换其他 D1 / R2 资源，改 `wrangler.toml` 中的 `database_name` / `database_id` / `bucket_name`，或直接在 Worker 的「设置 → 绑定」中修改（控制台会自动同步回仓库配置）。
   - **管理员账号**：部署变量 `ADMIN_USER`（默认 `admin`），在 `wrangler.toml` 或 Worker 设置 → 变量中修改。
   - **管理员密码**：Secret `ADMIN_PASSWORD`，在 Worker 的「设置 → 变量和机密」中添加（Secret 不会被仓库配置覆盖）。
3. **首次部署会自动创建表结构**：无需手动执行 SQL，Worker 启动时会自动创建 `devices`、`events`、`sessions` 三个表。
4. 之后每次 push 到 `main` 自动重新部署。

### 方式二：命令行

```bash
npm install -g wrangler
wrangler login
wrangler secret put ADMIN_PASSWORD   # 设置管理员密码
wrangler deploy
```

### 备用：GitHub Actions

`.github/workflows/deploy.yml` 已保留，但默认只允许手动触发（workflow_dispatch），避免与控制台自动部署重复。需要启用时在仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，并把触发条件改回 `push`。

## 终端接入

### 1. 绑定终端（获取设备 Token）

在管理控制台「已绑定终端」中添加设备，或调用 API：

```bash
curl -X POST https://<你的域名>/api/devices \
  -H "Authorization: Bearer <管理员会话Token或ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的华为手机","platform":"huawei"}'
# 返回 { "id": "...", "token": "<设备Token>" }  ← Token 仅此一次返回
```

管理员会话 Token 通过 `POST /api/login`（账号 + 密码）获取；`ADMIN_TOKEN` 是兼容旧版的固定 API 令牌，可选配置。

### 2. 增量同步

```bash
curl -X POST https://<你的域名>/api/sync \
  -H "Authorization: Bearer <设备Token>" \
  -H "Content-Type: application/json" \
  -d '{
    "since": 0,
    "changes": [
      { "op": "upsert", "calendar_id": "default",
        "event": { "id": "evt-001", "title": "团队周会",
                   "start_at": 1767168000000, "end_at": 1767171600000,
                   "location": "会议室A", "updated_at": 1767100000000 } }
    ]
  }'
# 返回 { "applied": [...], "changes": [其他终端的变更...], "cursor": 12 }
```

- 终端本地保存返回的 `cursor`，下次同步带上，即可只拉取增量。
- 推送的事件需带客户端生成的唯一 `id` 与本地修改时间 `updated_at`。

### 3. ICS 订阅（iOS / Windows / 华为）

在日历应用中「添加订阅的日历」，地址：

```
https://<你的域名>/api/calendar.ics?token=<设备Token或ADMIN_TOKEN>
```

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 无 | 健康检查与版本号 |
| POST | `/api/login` | 无 | 管理员登录（账号+密码），签发 7 天会话 |
| GET | `/api/calendar.ics?token=` | 查询参数 | ICS 订阅输出 |
| POST | `/api/devices` | 会话 / ADMIN_TOKEN | 绑定终端（返回设备 Token） |
| GET | `/api/devices` | 会话 / ADMIN_TOKEN | 终端列表 |
| DELETE | `/api/devices/:id` | 会话 / ADMIN_TOKEN | 解绑终端 |
| GET | `/api/calendars` | 设备 / 会话 | 日历列表 |
| POST | `/api/calendars` | 设备 / 会话 | 新建 / 更新日历 |
| GET | `/api/events` | 设备 / 会话 | 全量事件 |
| POST | `/api/sync` | 设备 | 增量同步（推 + 拉） |
| POST | `/api/backup` | 会话 / ADMIN_TOKEN | 立即备份到 R2 |
| GET | `/api/backups` | 会话 / ADMIN_TOKEN | 备份列表 |
| GET | `/api/backup/:key` | 会话 / ADMIN_TOKEN | 下载备份 |
| POST | `/api/restore` | 会话 / ADMIN_TOKEN | 从备份恢复 |

## 目录结构

```
rili-tongbu/
├── src/worker.js            # Worker：API + 路由
├── public/index.html        # 管理控制台（单页）
├── migrations/0001_init.sql # D1 表结构
├── migrations/0002_sessions.sql # 管理员登录会话
├── wrangler.toml            # Cloudflare 配置（D1 / R2 / 版本号 / ADMIN_USER）
├── VERSION                  # 当前版本号
└── .github/workflows/deploy.yml  # 手动备用部署
```
