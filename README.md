# rili-tongbu · 日历同步平台

跨终端日历数据备份与同步平台：华为、iOS、Windows 及其他终端的日历数据，通过统一的同步平台保持实时一致。任意终端新增 / 修改 / 删除日历事件后，其他绑定的终端立即拉取到相同变更。

- 当前版本：**v0.0.1**（版本规则见下文）
- 技术栈：Cloudflare Workers（API + 静态页面）+ D1（关系数据）+ R2（备份快照）
- 部署方式：GitHub 推送后自动部署到 Cloudflare

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

## 首次部署

```bash
npm install -g wrangler
wrangler login

# 1. 创建 D1 数据库，把输出的 database_id 填入 wrangler.toml
wrangler d1 create rili-tongbu

# 2. 创建 R2 存储桶
wrangler r2 bucket create rili-tongbu

# 3. 初始化 D1 表结构
wrangler d1 migrations apply rili-tongbu --remote

# 4. 设置管理员令牌（控制台登录用）
wrangler secret put ADMIN_TOKEN

# 5. 部署
wrangler deploy
```

### 自动部署（GitHub → Cloudflare）

仓库已含 `.github/workflows/deploy.yml`，在 GitHub 仓库设置中配置两个 Secrets 即可：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（权限：Workers Scripts Edit + D1 Edit + Workers KV/R2 Edit） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID（控制台右侧栏可见） |

配置后每次 push 到 `main` 分支即自动部署；也可以在 Cloudflare 控制台使用「Workers Builds」连接本仓库作为替代方案。

## 终端接入

### 1. 绑定终端（获取设备 Token）

在管理控制台「已绑定终端」中添加设备，或调用 API：

```bash
curl -X POST https://<你的域名>/api/devices \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的华为手机","platform":"huawei"}'
# 返回 { "id": "...", "token": "<设备Token>" }  ← Token 仅此一次返回
```

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
| GET | `/api/calendar.ics?token=` | 查询参数 | ICS 订阅输出 |
| POST | `/api/devices` | ADMIN | 绑定终端（返回设备 Token） |
| GET | `/api/devices` | ADMIN | 终端列表 |
| DELETE | `/api/devices/:id` | ADMIN | 解绑终端 |
| GET | `/api/calendars` | 设备 / ADMIN | 日历列表 |
| POST | `/api/calendars` | 设备 / ADMIN | 新建 / 更新日历 |
| GET | `/api/events` | 设备 / ADMIN | 全量事件 |
| POST | `/api/sync` | 设备 | 增量同步（推 + 拉） |
| POST | `/api/backup` | ADMIN | 立即备份到 R2 |
| GET | `/api/backups` | ADMIN | 备份列表 |
| GET | `/api/backup/:key` | ADMIN | 下载备份 |
| POST | `/api/restore` | ADMIN | 从备份恢复 |

## 目录结构

```
rili-tongbu/
├── src/worker.js            # Worker：API + 路由
├── public/index.html        # 管理控制台（单页）
├── migrations/0001_init.sql # D1 表结构
├── wrangler.toml            # Cloudflare 配置（D1 / R2 / 版本号）
├── VERSION                  # 当前版本号
└── .github/workflows/deploy.yml  # GitHub 自动部署
```
