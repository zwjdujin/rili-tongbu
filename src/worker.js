/**
 * rili-tongbu 日历同步平台
 * Cloudflare Worker：API + CalDAV + 静态资源（public/）
 * 绑定：D1 (env.DB) / R2 (env.BUCKET)
 */
import { handleCaldav } from './caldav.js';

const CALDAV_METHODS = ['PROPFIND', 'REPORT', 'PROPPATCH', 'MKCALENDAR', 'MOVE', 'COPY'];

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

/** 鉴权：返回 'admin' | device 对象 | null */
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return 'admin';
  // 管理员登录会话（/api/login 签发，7 天有效）
  const session = await env.DB.prepare(
    'SELECT token FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, now()).first();
  if (session) return 'admin';
  const device = await env.DB.prepare(
    'SELECT * FROM devices WHERE token = ?'
  ).bind(token).first();
  return device || null;
}

/** 自动初始化 D1 表结构（完整 schema，含旧结构自愈） */
async function initDatabase(env) {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all();
  const have = new Set(tables.results.map((t) => t.name));

  // 旧版/简化版表结构检测：列不匹配则重建（部署初期无数据，可安全重建）
  for (const [table, requiredCol] of [
    ['devices', 'last_seen'],
    ['events', 'start_at'],
  ]) {
    if (have.has(table)) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      const names = cols.results.map((c) => c.name);
      if (!names.includes(requiredCol)) {
        await env.DB.prepare(`DROP TABLE ${table}`).run();
        have.delete(table);
      }
    }
  }

  const stmts = [];
  if (!have.has('devices')) {
    stmts.push(env.DB.prepare(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    )`));
  }
  if (!have.has('calendars')) {
    stmts.push(env.DB.prepare(`CREATE TABLE calendars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      created_at INTEGER NOT NULL
    )`));
  }
  if (!have.has('events')) {
    stmts.push(env.DB.prepare(`CREATE TABLE events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      location TEXT DEFAULT '',
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      reminder_minutes INTEGER,
      recurrence TEXT,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT
    )`));
  }
  if (!have.has('change_log')) {
    stmts.push(env.DB.prepare(`CREATE TABLE change_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      event_id TEXT NOT NULL,
      op TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    )`));
  }
  if (!have.has('backups')) {
    stmts.push(env.DB.prepare(`CREATE TABLE backups (
      key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL
    )`));
  }
  if (!have.has('sessions')) {
    stmts.push(env.DB.prepare(`CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`));
  }
  stmts.push(env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(calendar_id)'));
  stmts.push(env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated_at)'));
  await env.DB.batch(stmts);
}

function isAdmin(auth) {
  return auth === 'admin';
}

/** 校验并规范化事件负载 */
function normalizeEvent(raw, calendarId) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id || typeof raw.id !== 'string') return null;
  if (!raw.title || typeof raw.title !== 'string') return null;
  const startAt = Number(raw.start_at ?? raw.startAt);
  const endAt = Number(raw.end_at ?? raw.endAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return null;
  return {
    id: raw.id,
    calendar_id: calendarId,
    title: raw.title.slice(0, 500),
    description: String(raw.description ?? ''),
    location: String(raw.location ?? ''),
    start_at: Math.round(startAt),
    end_at: Math.round(endAt),
    all_day: raw.all_day || raw.allDay ? 1 : 0,
    reminder_minutes: raw.reminder_minutes ?? raw.reminderMinutes ?? null,
    recurrence: raw.recurrence ?? null,
    updated_at: Math.round(Number(raw.updated_at ?? raw.updatedAt ?? now())),
    deleted: 0,
    updated_by: null,
  };
}

/** 应用一批变更（last-write-wins：updated_at 更新者获胜） */
async function applyChanges(env, deviceId, changes) {
  const results = [];
  for (const ch of changes || []) {
    const op = ch.op === 'delete' ? 'delete' : 'upsert';
    const ts = now();
    try {
      if (op === 'delete') {
        const eventId = ch.event_id || ch.eventId || ch.event?.id;
        if (!eventId) throw new Error('missing event_id');
        const existing = await env.DB.prepare(
          'SELECT updated_at FROM events WHERE id = ?'
        ).bind(eventId).first();
        if (existing && existing.updated_at > ts) {
          results.push({ event_id: eventId, ok: false, reason: 'conflict' });
          continue;
        }
        await env.DB.prepare(
          "UPDATE events SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?"
        ).bind(ts, deviceId, eventId).run();
        if (!existing) {
          await env.DB.prepare(
            "INSERT INTO events (id, calendar_id, title, start_at, end_at, updated_at, deleted, updated_by) VALUES (?, '', '(tombstone)', 0, 0, ?, 1, ?)"
          ).bind(eventId, ts, deviceId).run();
        }
        await env.DB.prepare(
          'INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)'
        ).bind(deviceId, eventId, 'delete', ts).run();
        results.push({ event_id: eventId, ok: true });
      } else {
        const calendarId = ch.calendar_id || ch.calendarId || 'default';
        const ev = normalizeEvent(ch.event, calendarId);
        if (!ev) throw new Error('invalid event');
        const existing = await env.DB.prepare(
          'SELECT updated_at FROM events WHERE id = ?'
        ).bind(ev.id).first();
        if (existing && existing.updated_at > ev.updated_at) {
          results.push({ event_id: ev.id, ok: false, reason: 'conflict' });
          continue;
        }
        ev.updated_by = deviceId;
        await env.DB.prepare(
          `INSERT INTO events (id, calendar_id, title, description, location, start_at, end_at, all_day, reminder_minutes, recurrence, updated_at, deleted, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             calendar_id = excluded.calendar_id,
             title = excluded.title,
             description = excluded.description,
             location = excluded.location,
             start_at = excluded.start_at,
             end_at = excluded.end_at,
             all_day = excluded.all_day,
             reminder_minutes = excluded.reminder_minutes,
             recurrence = excluded.recurrence,
             updated_at = excluded.updated_at,
             deleted = 0,
             updated_by = excluded.updated_by`
        ).bind(ev.id, ev.calendar_id, ev.title, ev.description, ev.location,
          ev.start_at, ev.end_at, ev.all_day, ev.reminder_minutes,
          ev.recurrence, ev.updated_at, ev.updated_by).run();
        await env.DB.prepare(
          'INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)'
        ).bind(deviceId, ev.id, 'upsert', ts).run();
        results.push({ event_id: ev.id, ok: true });
      }
    } catch (e) {
      results.push({ event_id: ch.event_id || ch.event?.id || null, ok: false, reason: String(e.message || e) });
    }
  }
  return results;
}

/** 拉取自游标以来、由其他设备产生的变更 */
async function pullChanges(env, since, excludeDeviceId) {
  const rows = await env.DB.prepare(
    `SELECT c.log_id, c.device_id, c.op, c.changed_at, e.*
     FROM change_log c LEFT JOIN events e ON e.id = c.event_id
     WHERE c.log_id > ? AND (c.device_id IS NULL OR c.device_id != ?)
     ORDER BY c.log_id ASC LIMIT 500`
  ).bind(Number(since) || 0, excludeDeviceId || '').all();
  const changes = rows.results.map((r) => ({
    log_id: r.log_id,
    device_id: r.device_id,
    op: r.op,
    changed_at: r.changed_at,
    event: r.deleted
      ? { id: r.id, deleted: true, updated_at: r.updated_at }
      : {
          id: r.id,
          calendar_id: r.calendar_id,
          title: r.title,
          description: r.description,
          location: r.location,
          start_at: r.start_at,
          end_at: r.end_at,
          all_day: !!r.all_day,
          reminder_minutes: r.reminder_minutes,
          recurrence: r.recurrence,
          updated_at: r.updated_at,
          deleted: false,
        },
  }));
  const head = await env.DB.prepare(
    'SELECT COALESCE(MAX(log_id), 0) AS max_id FROM change_log'
  ).first();
  return { changes, cursor: head.max_id };
}

/** 生成 ICS 订阅内容（iOS / Windows / 华为均可订阅或导入） */
async function icsFeed(env) {
  const rows = await env.DB.prepare(
    'SELECT * FROM events WHERE deleted = 0 ORDER BY start_at ASC'
  ).all();
  const calName = 'rili-tongbu';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//rili-tongbu//v0.0.1//CN',
    `X-WR-CALNAME:${calName}`,
    'CALSCALE:GREGORIAN',
  ];
  const fmt = (ms, allDay) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    if (allDay) return { value: date, params: ';VALUE=DATE' };
    return {
      value: `${date}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`,
      params: '',
    };
  };
  for (const e of rows.results) {
    const s = fmt(e.start_at, e.all_day);
    const en = fmt(e.end_at, e.all_day);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}`);
    lines.push(`DTSTAMP:${fmt(e.updated_at, false).value}`);
    lines.push(`DTSTART${s.params}:${s.value}`);
    lines.push(`DTEND${en.params}:${en.value}`);
    lines.push(`SUMMARY:${String(e.title).replace(/\r?\n/g, '\\n')}`);
    if (e.description) lines.push(`DESCRIPTION:${String(e.description).replace(/\r?\n/g, '\\n')}`);
    if (e.location) lines.push(`LOCATION:${String(e.location).replace(/\r?\n/g, '\\n')}`);
    if (e.recurrence) lines.push(`RRULE:${e.recurrence}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n'), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
}

/** 全量快照写入 R2 */
async function createBackup(env) {
  const ts = now();
  const rows = await env.DB.prepare(
    'SELECT * FROM events WHERE deleted = 0'
  ).all();
  const payload = {
    version: '0.0.1',
    created_at: ts,
    events: rows.results,
  };
  const body = JSON.stringify(payload, null, 2);
  const key = `backups/${new Date(ts).toISOString().replace(/[:.]/g, '-')}.json`;
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.DB.prepare(
    'INSERT INTO backups (key, created_at, event_count, size_bytes) VALUES (?, ?, ?, ?)'
  ).bind(key, ts, rows.results.length, body.length).run();
  return { key, event_count: rows.results.length, size_bytes: body.length };
}

/** 从 R2 快照恢复（整表替换） */
async function restoreBackup(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return { ok: false, error: 'backup not found' };
  const data = await obj.json();
  if (!Array.isArray(data.events)) return { ok: false, error: 'invalid snapshot' };
  const stmts = [
    env.DB.prepare('DELETE FROM events'),
    ...data.events.map((e) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO events (id, calendar_id, title, description, location, start_at, end_at, all_day, reminder_minutes, recurrence, updated_at, deleted, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(e.id, e.calendar_id || 'default', e.title, e.description || '',
        e.location || '', e.start_at, e.end_at, e.all_day ? 1 : 0,
        e.reminder_minutes ?? null, e.recurrence ?? null, e.updated_at,
        e.deleted ? 1 : 0, e.updated_by ?? null)
    ),
  ];
  await env.DB.batch(stmts);
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)'
  ).bind(null, '*', 'restore', ts).run();
  return { ok: true, restored: data.events.length };
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      // 返回具体错误信息，便于部署排障
      return json({ error: 'server error', detail: String(e.message || e) }, 500);
    }
  },
};

async function handleRequest(request, env) {
  // 初始化数据库表（幂等，每次请求前确保表存在）
  await initDatabase(env);

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 站点图标（无资源，返回空响应避免 500）
  if (path === '/favicon.ico') {
    return new Response(null, { status: 204 });
  }

  // CalDAV：iPhone / Windows / DAVx⁵ 原生双向同步
  if (path === '/.well-known/caldav' || path.startsWith('/caldav') || CALDAV_METHODS.includes(method)) {
    return handleCaldav(request, env);
  }

  // 健康检查 / 版本 / 数据库状态（用于远程排障）
  if (path === '/api/health') {
    let db = { ok: true, tables: [] };
    try {
      const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      db.tables = r.results.map((t) => t.name);
    } catch (e) {
      db = { ok: false, error: String(e.message || e) };
    }
    return json({
      ok: true,
      version: env.VERSION || '0.0.1',
      db,
      admin_password_configured: !!env.ADMIN_PASSWORD,
    });
  }

    // 管理员登录（账号 + 密码，签发 7 天会话）
    if (path === '/api/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD) {
        return json({ error: '未配置 ADMIN_PASSWORD，请先在 Worker 设置中添加该 Secret' }, 500);
      }
      const user = env.ADMIN_USER || 'admin';
      if (body.username !== user || body.password !== env.ADMIN_PASSWORD) {
        return json({ error: '账号或密码错误' }, 401);
      }
      const token = uuid();
      const expiresAt = now() + 7 * 24 * 3600 * 1000;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
        env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
          .bind(token, now(), expiresAt),
      ]);
      return json({ token, expires_at: expiresAt });
    }

    // ICS 订阅：用设备 token 或管理员 token 作为查询参数
    if (path === '/api/calendar.ics' && method === 'GET') {
      const token = url.searchParams.get('token') || '';
      let valid = false;
      if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) valid = true;
      else if (token) {
        valid = !!(await env.DB.prepare('SELECT id FROM devices WHERE token = ?').bind(token).first());
      }
      if (!valid) return json({ error: 'unauthorized' }, 401);
      return icsFeed(env);
    }

    // 其余 /api/* 需要鉴权
    if (path.startsWith('/api/')) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'unauthorized' }, 401);

      // ---- 设备管理（仅管理员）----
      if (path === '/api/devices' && method === 'POST') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const body = await request.json().catch(() => ({}));
        const id = uuid();
        const token = uuid();
        await env.DB.prepare(
          'INSERT INTO devices (id, name, platform, token, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, body.name || '未命名设备', body.platform || 'other', token, now()).run();
        return json({ id, token, name: body.name, platform: body.platform });
      }
      if (path === '/api/devices' && method === 'GET') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const rows = await env.DB.prepare('SELECT id, name, platform, created_at, last_seen FROM devices ORDER BY created_at DESC').all();
        return json({ devices: rows.results });
      }
      if (path.startsWith('/api/devices/') && method === 'DELETE') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const id = path.split('/')[3];
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // ---- 日历管理 ----
      if (path === '/api/calendars' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM calendars ORDER BY created_at ASC').all();
        return json({ calendars: rows.results });
      }
      if (path === '/api/calendars' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.name) return json({ error: 'name required' }, 400);
        const id = body.id || uuid();
        await env.DB.prepare(
          'INSERT INTO calendars (id, name, color, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color'
        ).bind(id, body.name, body.color || '#3b82f6', now()).run();
        return json({ id, name: body.name, color: body.color || '#3b82f6' });
      }

      if (path.startsWith('/api/calendars/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/')[3]);
        if (id === 'default') return json({ error: '默认日历不可删除' }, 400);
        const cal = await env.DB.prepare('SELECT id FROM calendars WHERE id = ?').bind(id).first();
        if (!cal) return json({ error: '日历不存在' }, 404);
        const ts = now();
        // 该日历下的未删除事件一并软删除，并记入变更日志供其他终端拉取
        const evs = await env.DB.prepare(
          'SELECT id FROM events WHERE calendar_id = ? AND deleted = 0'
        ).bind(id).all();
        const stmts = evs.results.map((e) =>
          env.DB.prepare(
            "UPDATE events SET deleted = 1, updated_at = ?, updated_by = 'admin' WHERE id = ?"
          ).bind(ts, e.id)
        );
        for (const e of evs.results) {
          stmts.push(env.DB.prepare(
            'INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)'
          ).bind('admin', e.id, 'delete', ts));
        }
        stmts.push(env.DB.prepare('DELETE FROM calendars WHERE id = ?').bind(id));
        await env.DB.batch(stmts);
        return json({ ok: true, deleted_events: evs.results.length });
      }

      // ---- 事件增删改查 ----
      if (path === '/api/events' && method === 'POST') {
        const event = JSON.parse(req.body);
        const ts = now();
        const id = uuid();
        await env.DB.prepare(`
          INSERT INTO events (id, calendar_id, title, start_at, end_at, all_day, location, description, reminder_minutes, recurrence, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, event.calendar_id, event.title, event.start_at, event.end_at, event.all_day ? 1 : 0, event.location || null, event.description || null, event.reminder_minutes || null, event.recurrence || null, ts).run();
        await env.DB.prepare('INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)').bind('admin', id, 'upsert', ts).run();
        return json({ ok: true, id });
      }
      if (path.startsWith('/api/events/') && method === 'GET') {
        const id = decodeURIComponent(path.split('/')[3]);
        const event = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND deleted = 0').bind(id).first();
        if (!event) return json({ error: 'not found' }, 404);
        return json({ event });
      }
      if (path.startsWith('/api/events/') && method === 'PUT') {
        const id = decodeURIComponent(path.split('/')[3]);
        const event = JSON.parse(req.body);
        const ts = now();
        await env.DB.prepare(`
          UPDATE events SET calendar_id = ?, title = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, description = ?, reminder_minutes = ?, recurrence = ?, updated_at = ? WHERE id = ? AND deleted = 0
        `).bind(event.calendar_id, event.title, event.start_at, event.end_at, event.all_day ? 1 : 0, event.location || null, event.description || null, event.reminder_minutes || null, event.recurrence || null, ts, id).run();
        await env.DB.prepare('INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)').bind('admin', id, 'upsert', ts).run();
        return json({ ok: true });
      }
      if (path.startsWith('/api/events/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/')[3]);
        const ts = now();
        await env.DB.prepare('UPDATE events SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0').bind(ts, id).run();
        await env.DB.prepare('INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)').bind('admin', id, 'delete', ts).run();
        return json({ ok: true });
      }
      if (path === '/api/events' && method === 'GET') {
        const url = new URL(req.url);
        const calendar_id = url.searchParams.get('calendar_id');
        const search = url.searchParams.get('search');
        let query = 'SELECT e.*, c.name as calendar_name, c.color as calendar_color FROM events e LEFT JOIN calendars c ON e.calendar_id = c.id WHERE e.deleted = 0';
        const params = [];
        if (calendar_id) {
          query += ' AND e.calendar_id = ?';
          params.push(calendar_id);
        }
        if (search) {
          query += ' AND (e.title LIKE ? OR e.description LIKE ?)';
          params.push(`%${search}%`, `%${search}%`);
        }
        query += ' ORDER BY e.start_at DESC';
        const { results } = await env.DB.prepare(query).bind(...params).all();
        return json({ events: results });
      }

      // ---- 全量事件列表 ----
      if (path === '/api/events' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM events WHERE deleted = 0 ORDER BY start_at ASC').all();
        return json({ events: rows.results });
      }

      // ---- 增量同步（设备专用）----
      if (path === '/api/sync' && method === 'POST') {
        if (isAdmin(auth)) return json({ error: 'device token required' }, 403);
        await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now(), auth.id).run();
        const body = await request.json().catch(() => ({}));
        const applied = await applyChanges(env, auth.id, body.changes);
        const pull = await pullChanges(env, body.since, auth.id);
        return json({ applied, changes: pull.changes, cursor: pull.cursor, server_time: now() });
      }

      // ---- 备份 / 恢复（仅管理员）----
      if (path === '/api/backup' && method === 'POST') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        return json(await createBackup(env));
      }
      if (path === '/api/backups' && method === 'GET') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const rows = await env.DB.prepare('SELECT key, created_at, event_count, size_bytes FROM backups ORDER BY created_at DESC').all();
        return json({ backups: rows.results });
      }
      if (path.startsWith('/api/backup/') && method === 'GET') {
        if (!isAdmin(auth)) {
          // 下载走新窗口打开，允许通过 ?t= 传入管理员 token
          const qt = url.searchParams.get('t') || '';
          if (!(env.ADMIN_TOKEN && qt === env.ADMIN_TOKEN)) return json({ error: 'admin only' }, 403);
        }
        const key = decodeURIComponent(path.split('/').slice(3).join('/'));
        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        return new Response(obj.body, {
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="backup.json"` },
        });
      }
      if (path.startsWith('/api/backup/') && method === 'DELETE') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const key = decodeURIComponent(path.split('/').slice(3).join('/'));
        const row = await env.DB.prepare('SELECT key FROM backups WHERE key = ?').bind(key).first();
        if (!row) return json({ error: 'not found' }, 404);
        await env.BUCKET.delete(key);
        await env.DB.prepare('DELETE FROM backups WHERE key = ?').bind(key).run();
        return json({ ok: true });
      }
      if (path === '/api/restore' && method === 'POST') {
        if (!isAdmin(auth)) return json({ error: 'admin only' }, 403);
        const body = await request.json().catch(() => ({}));
        if (!body.key) return json({ error: 'key required' }, 400);
        const result = await restoreBackup(env, body.key);
        return json(result, result.ok ? 200 : 400);
      }

      return json({ error: 'not found' }, 404);
    }

    // 非 /api 路径交给静态资源（public/）
    return env.ASSETS.fetch(request);
}
