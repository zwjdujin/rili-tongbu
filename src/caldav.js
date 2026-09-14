/**
 * rili-tongbu CalDAV 服务端（最小可用实现）v0.0.5
 * 支持 iOS 原生日历账户双向同步：
 *   - 服务发现（/.well-known/caldav → /caldav/，principal / home-set）
 *   - PROPFIND 列出日历与事件（getetag）
 *   - REPORT sync-collection（增量）/ calendar-multiget / calendar-query
 *   - GET / PUT / DELETE 单个事件（.ics）
 * 认证：HTTP Basic，用户名任意，密码 = 设备 Token（或 ADMIN_TOKEN）。
 * 时区约定：非 UTC 时间按北京时间（UTC+8）解析。
 */

const CALDAV_NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';
const P8H = 8 * 3600 * 1000; // 北京时间偏移

function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function xmlResponse(body, status = 207) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 2, calendar-access' },
  });
}

function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="rili-tongbu", charset="UTF-8"' },
  });
}

/** Basic 认证：密码或用户名匹配设备 Token / ADMIN_TOKEN */
async function basicAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (env.ADMIN_TOKEN && (pass === env.ADMIN_TOKEN || user === env.ADMIN_TOKEN)) {
    return { id: 'admin', name: 'admin' };
  }
  for (const t of [pass, user]) {
    if (!t) continue;
    const device = await env.DB.prepare('SELECT id, name FROM devices WHERE token = ?').bind(t).first();
    if (device) return device;
  }
  return null;
}

/** 解析 CalDAV 时间：返回 { ms, allDay } */
function parseDateTime(value, params = []) {
  const v = value.trim();
  const isDateOnly = params.some((p) => p.toUpperCase().includes('VALUE=DATE')) || /^\d{8}$/.test(v);
  if (isDateOnly) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return { ms: z ? utc : utc - P8H, allDay: false };
}

/** 展开折叠行（RFC5545：CRLF + 空格/Tab 续行）并切分属性 */
function unfoldICS(text) {
  return text
    .replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter(Boolean);
}

/** 解析 ICS 中的第一个 VEVENT */
export function parseICS(text) {
  const lines = unfoldICS(text);
  const ev = { description: '', location: '' };
  let inEvent = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) { inEvent = true; continue; }
    if (upper.startsWith('END:VEVENT')) break;
    if (!inEvent) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const parts = left.split(';');
    const name = parts[0].toUpperCase();
    const params = parts.slice(1);
    switch (name) {
      case 'UID': ev.id = value; break;
      case 'SUMMARY': ev.title = unescapeICS(value); break;
      case 'DESCRIPTION': ev.description = unescapeICS(value); break;
      case 'LOCATION': ev.location = unescapeICS(value); break;
      case 'RRULE': ev.recurrence = value; break;
      case 'DTSTART': {
        const r = parseDateTime(value, params);
        if (r) { ev.start_at = r.ms; ev.all_day = r.allDay; }
        break;
      }
      case 'DTEND': {
        const r = parseDateTime(value, params);
        if (r) ev.end_at = r.ms;
        break;
      }
      case 'LAST-MODIFIED': {
        const r = parseDateTime(value, params);
        if (r) ev._lm = r.ms;
        break;
      }
      case 'DTSTAMP': {
        const r = parseDateTime(value, params);
        if (r) ev._dtstamp = r.ms;
        break;
      }
    }
  }
  if (!ev.id || !Number.isFinite(ev.start_at)) return null;
  if (!Number.isFinite(ev.end_at)) ev.end_at = ev.all_day ? ev.start_at + 86400000 : ev.start_at + 3600000;
  ev.updated_at = ev._lm ?? ev._dtstamp ?? Date.now();
  return ev;
}

function unescapeICS(s) {
  return String(s).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** D1 事件行 → ICS 文本 */
export function eventToICS(e) {
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (ms, allDay) => {
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    if (allDay) return `${date}`;
    return `${date}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  };
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//rili-tongbu//caldav//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${e.id}`,
    `DTSTAMP:${fmt(e.updated_at, false)}`,
    `DTSTART${e.all_day ? ';VALUE=DATE' : ''}:${fmt(e.start_at, e.all_day)}`,
    `DTEND${e.all_day ? ';VALUE=DATE' : ''}:${fmt(e.end_at, e.all_day)}`,
    `SUMMARY:${icsEscape(e.title)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.recurrence) lines.push(`RRULE:${e.recurrence}`);
  lines.push('LAST-MODIFIED:' + fmt(e.updated_at, false));
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** CalDAV 写入 / 删除 → 记入 change_log，保持 /api/sync 与 ICS 订阅可见 */
async function logChange(env, deviceId, eventId, op) {
  await env.DB.prepare(
    'INSERT INTO change_log (device_id, event_id, op, changed_at) VALUES (?, ?, ?, ?)'
  ).bind(deviceId, eventId, op, Date.now()).run();
}

/** 确保存在 default 日历 */
async function ensureDefaultCalendar(env) {
  const cal = await env.DB.prepare("SELECT id FROM calendars WHERE id = 'default'").first();
  if (!cal) {
    await env.DB.prepare(
      "INSERT INTO calendars (id, name, color, created_at) VALUES ('default', '日历同步', '#3b82f6', ?)"
    ).bind(Date.now()).run();
  }
}

function calHref(calId) { return `/caldav/${calId}/`; }
function evHref(calId, uid) { return `/caldav/${calId}/${encodeURIComponent(uid)}.ics`; }

/** PROPFIND 响应 */
async function propfind(request, env, path) {
  const depth = (request.headers.get('Depth') || '0').trim();
  const segs = path.replace(/^\/caldav\/?/, '').split('/').filter(Boolean);
  await ensureDefaultCalendar(env);

  if (segs.length === 0) {
    // 根：principal + home-set（Depth 1 时附带日历列表）
    const cals = await env.DB.prepare('SELECT * FROM calendars ORDER BY created_at ASC').all();
    let body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>\n`;
    body += `<D:response><D:href>/caldav/</D:href><D:propstat><D:prop>`
      + `<D:current-user-principal><D:href>/caldav/</D:href></D:current-user-principal>`
      + `<C:calendar-home-set><D:href>/caldav/</D:href></C:calendar-home-set>`
      + `<D:displayname>rili-tongbu</D:displayname>`
      + `<D:resourcetype><D:collection/></D:resourcetype>`
      + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n`;
    if (depth !== '0') {
      for (const c of cals.results) {
        body += `<D:response><D:href>${calHref(c.id)}</D:href><D:propstat><D:prop>`
          + `<D:displayname>${xmlEscape(c.name)}</D:displayname>`
          + `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`
          + `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`
          + `<C:calendar-color>${xmlEscape(c.color || '#3b82f6')}</C:calendar-color>`
          + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n`;
      }
    }
    body += '</D:multistatus>';
    return xmlResponse(body);
  }

  const calId = decodeURIComponent(segs[0]);
  const cal = await env.DB.prepare('SELECT * FROM calendars WHERE id = ?').bind(calId).first();
  if (!cal) return new Response('Not Found', { status: 404 });

  const events = await env.DB.prepare(
    'SELECT * FROM events WHERE calendar_id = ? AND deleted = 0'
  ).bind(calId).all();

  let body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>\n`;
  body += `<D:response><D:href>${calHref(calId)}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${xmlEscape(cal.name)}</D:displayname>`
    + `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`
    + `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`
    + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n`;
  if (depth !== '0') {
    for (const e of events.results) {
      body += `<D:response><D:href>${evHref(calId, e.id)}</D:href><D:propstat><D:prop>`
        + `<D:getetag>&quot;${e.updated_at}&quot;</D:getetag>`
        + `<D:getcontenttype>text/calendar; component=vevent</D:getcontenttype>`
        + `<D:resourcetype/>`
        + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n`;
    }
  }
  body += '</D:multistatus>';
  return xmlResponse(body);
}

/** 解析 REPORT 请求体中的 href 列表与 sync-token */
function parseReportBody(text) {
  const tokenMatch = text.match(/<(?:[\w-]+:)?sync-token[^>]*>([^<]+)</i);
  const hrefs = [];
  const hrefRe = /<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi;
  let m;
  while ((m = hrefRe.exec(text)) !== null) hrefs.push(m[1].trim());
  return { token: tokenMatch ? parseInt(tokenMatch[1], 10) || 0 : 0, hrefs };
}

function eventResponseXml(calId, e) {
  return `<D:response><D:href>${evHref(calId, e.id)}</D:href><D:propstat><D:prop>`
    + `<D:getetag>&quot;${e.updated_at}&quot;</D:getetag>`
    + `<C:calendar-data>${xmlEscape(eventToICS(e))}</C:calendar-data>`
    + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n`;
}

async function report(request, env, path, deviceId) {
  const text = await request.text().catch(() => '');
  const segs = path.replace(/^\/caldav\/?/, '').split('/').filter(Boolean);
  if (segs.length === 0) return new Response('Not Found', { status: 404 });
  const calId = decodeURIComponent(segs[0]);
  const isSync = /sync-collection/i.test(text);
  const isMultiget = /calendar-multiget/i.test(text);

  if (isMultiget) {
    const { hrefs } = parseReportBody(text);
    let body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>\n`;
    for (const href of hrefs) {
      const m = href.match(/\/caldav\/([^/]+)\/(.+)\.ics$/);
      if (!m) continue;
      const uid = decodeURIComponent(m[2]);
      const e = await env.DB.prepare(
        'SELECT * FROM events WHERE id = ? AND deleted = 0'
      ).bind(uid).first();
      if (e) body += eventResponseXml(calId, e);
      else body += `<D:response><D:href>${href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>\n`;
    }
    body += '</D:multistatus>';
    return xmlResponse(body);
  }

  if (isSync) {
    const { token } = parseReportBody(text);
    const nowTs = Date.now();
    const changed = await env.DB.prepare(
      'SELECT * FROM events WHERE updated_at > ?'
    ).bind(token).all();
    let body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>\n`;
    for (const e of changed.results) {
      if (e.deleted) {
        body += `<D:response><D:href>${evHref(e.calendar_id, e.id)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>\n`;
      } else {
        body += eventResponseXml(e.calendar_id, e);
      }
    }
    body += `<D:sync-token>${nowTs}</D:sync-token>\n`;
    body += '</D:multistatus>';
    return xmlResponse(body);
  }

  // calendar-query（默认：全量返回 etag + 数据）
  const events = await env.DB.prepare(
    'SELECT * FROM events WHERE calendar_id = ? AND deleted = 0'
  ).bind(calId).all();
  let body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>\n`;
  for (const e of events.results) body += eventResponseXml(calId, e);
  body += '</D:multistatus>';
  return xmlResponse(body);
}

/** CalDAV 主入口 */
export async function handleCaldav(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: '1, 2, calendar-access',
        Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, PROPPATCH',
      },
    });
  }

  const device = await basicAuth(request, env);
  if (!device) return unauthorized();
  await ensureDefaultCalendar(env);

  // well-known 与根路径发现
  if (path === '/.well-known/caldav' || path === '/.well-known/caldav/') {
    return Response.redirect(`${url.origin}/caldav/`, 301);
  }

  const normPath = path === '/caldav' ? '/caldav/' : path;
  if (!normPath.startsWith('/caldav/')) {
    // 客户端直接对 / 做 PROPFIND：引导到 /caldav/
    if (method === 'PROPFIND' || method === 'REPORT') {
      return Response.redirect(`${url.origin}/caldav/`, 301);
    }
    return new Response('Not Found', { status: 404 });
  }

  switch (method) {
    case 'PROPFIND':
      return propfind(request, env, normPath);
    case 'REPORT':
      return report(request, env, normPath, device.id);
    case 'PROPPATCH': {
      // 日历颜色等属性：一律返回成功，避免客户端报错
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${CALDAV_NS}>`
        + `<D:response><D:href>${xmlEscape(normPath)}</D:href><D:propstat><D:prop/>`
        + `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
      return xmlResponse(body);
    }
    case 'MKCALENDAR':
      return new Response('Forbidden', { status: 403 });
    case 'GET': {
      const m = normPath.match(/^\/caldav\/([^/]+)\/(.+)\.ics\/?$/);
      if (!m) return new Response('Not Found', { status: 404 });
      const uid = decodeURIComponent(m[2]);
      const e = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND deleted = 0').bind(uid).first();
      if (!e) return new Response('Not Found', { status: 404 });
      return new Response(eventToICS(e), {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          ETag: `"${e.updated_at}"`,
        },
      });
    }
    case 'PUT': {
      const m = normPath.match(/^\/caldav\/([^/]+)\/(.+)\.ics\/?$/);
      if (!m) return new Response('Not Found', { status: 404 });
      const calId = decodeURIComponent(m[1]);
      const hrefUid = decodeURIComponent(m[2]);
      const icsText = await request.text();
      const ev = parseICS(icsText);
      if (!ev) return new Response('Bad Request: cannot parse VEVENT', { status: 400 });
      if (ev.id !== hrefUid) {
        // UID 与 URL 不一致时以 URL 为准，保证幂等
        ev.id = hrefUid;
      }
      const calExists = await env.DB.prepare('SELECT id FROM calendars WHERE id = ?').bind(calId).first();
      const calendarId = calExists ? calId : 'default';
      const existing = await env.DB.prepare('SELECT updated_at FROM events WHERE id = ?').bind(ev.id).first();
      const isNew = !existing;
      if (!isNew && existing.updated_at > ev.updated_at) {
        // 客户端基于旧数据写入：返回当前状态让客户端重新拉取
        const cur = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(ev.id).first();
        return new Response(eventToICS(cur), {
          status: 204,
          headers: { ETag: `"${cur.updated_at}"` },
        });
      }
      await env.DB.prepare(
        `INSERT INTO events (id, calendar_id, title, description, location, start_at, end_at, all_day, reminder_minutes, recurrence, updated_at, deleted, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           calendar_id = excluded.calendar_id, title = excluded.title,
           description = excluded.description, location = excluded.location,
           start_at = excluded.start_at, end_at = excluded.end_at,
           all_day = excluded.all_day, reminder_minutes = excluded.reminder_minutes,
           recurrence = excluded.recurrence, updated_at = excluded.updated_at,
           deleted = 0, updated_by = excluded.updated_by`
      ).bind(ev.id, calendarId, ev.title || '(无标题)', ev.description, ev.location,
        ev.start_at, ev.end_at, ev.all_day ? 1 : 0, null, ev.recurrence ?? null,
        ev.updated_at, device.id).run();
      await logChange(env, device.id, ev.id, 'upsert');
      return new Response(isNew ? 'Created' : '', {
        status: isNew ? 201 : 204,
        headers: { ETag: `"${ev.updated_at}"` },
      });
    }
    case 'DELETE': {
      const m = normPath.match(/^\/caldav\/([^/]+)\/(.+)\.ics\/?$/);
      if (!m) return new Response('Not Found', { status: 404 });
      const uid = decodeURIComponent(m[2]);
      const ts = Date.now();
      const existing = await env.DB.prepare('SELECT updated_at FROM events WHERE id = ?').bind(uid).first();
      if (!existing) return new Response('Not Found', { status: 404 });
      await env.DB.prepare(
        'UPDATE events SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?'
      ).bind(ts, device.id, uid).run();
      await logChange(env, device.id, uid, 'delete');
      return new Response('', { status: 204 });
    }
    default:
      return new Response('Method Not Allowed', { status: 405 });
  }
}
