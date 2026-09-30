import crypto from 'node:crypto';
import { getDb } from '../lib/db.mjs';

export const config = { path: '/api/*' };

// ───────────── 공통 유틸 ─────────────
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const newId = () => crypto.randomBytes(5).toString('hex');

function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) throw new HttpError(500, '서버 설정 오류: Netlify 환경변수 ADMIN_PASSWORD 가 설정되지 않았습니다.');
  return s;
}

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pin, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

const PIN_RE = /^\d{4,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// KST(+09:00) 기준 날짜/시간 처리
const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const kstToIso = (date, time) => new Date(`${date}T${time}:00+09:00`).toISOString();

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ───────────── 데이터 접근 ─────────────
const DEFAULT_CONFIG = () => ({
  enforceLocation: true,
  stores: [
    { id: 's1', name: '1호점', lat: null, lng: null, radius: 100 },
    { id: 's2', name: '2호점', lat: null, lng: null, radius: 100 },
  ],
  employees: [],
});

async function loadConfig(db) {
  const c = await db.get('config');
  return c || DEFAULT_CONFIG();
}

const recKey = (r) => `rec/${r.date.slice(0, 7)}/${r.id}`;

async function saveRecord(db, r) {
  await db.set(recKey(r), r);
  const openKey = `open/${r.empId}`;
  if (!r.outAt) {
    await db.set(openKey, { key: recKey(r), id: r.id });
  } else {
    const o = await db.get(openKey);
    if (o && o.id === r.id) await db.del(openKey);
  }
}

async function removeRecord(db, r) {
  await db.del(recKey(r));
  const o = await db.get(`open/${r.empId}`);
  if (o && o.id === r.id) await db.del(`open/${r.empId}`);
}

async function findRecord(db, id) {
  const keys = await db.list('rec/');
  const key = keys.find((k) => k.endsWith(`/${id}`));
  return key ? db.get(key) : null;
}

async function loadMonth(db, month) {
  const keys = await db.list(`rec/${month}/`);
  const rows = await Promise.all(keys.map((k) => db.get(k)));
  return rows
    .filter(Boolean)
    .sort((a, b) => (a.inAt < b.inAt ? 1 : -1));
}

const publicEmployee = (e) => ({ id: e.id, name: e.name, active: e.active });

// ───────────── 인증 ─────────────
function auth(req, role) {
  const h = req.headers.get('authorization') || '';
  const p = verify(h.replace(/^Bearer /, ''));
  if (!p) throw new HttpError(401, '로그인이 필요합니다.');
  if (role && p.role !== role) throw new HttpError(403, '권한이 없습니다.');
  return p;
}

async function login(db, body) {
  if (body.role === 'admin') {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) throw new HttpError(500, '서버 설정 오류: ADMIN_PASSWORD 환경변수가 없습니다.');
    const lock = (await db.get('lock/admin')) || { fails: 0, until: 0 };
    if (lock.until > Date.now()) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    if (!safeEqual(body.password ?? '', pw)) {
      lock.fails += 1;
      if (lock.fails >= 5) {
        lock.until = Date.now() + 10 * 60e3;
        lock.fails = 0;
      }
      await db.set('lock/admin', lock);
      throw new HttpError(401, '비밀번호가 올바르지 않습니다.');
    }
    await db.del('lock/admin');
    return { token: sign({ role: 'admin', exp: Date.now() + 12 * 3600e3 }), role: 'admin' };
  }

  const cfg = await loadConfig(db);
  const emp = cfg.employees.find((e) => e.id === body.empId && e.active);
  if (!emp) throw new HttpError(401, '직원 정보를 찾을 수 없습니다.');
  const lockKey = `lock/${emp.id}`;
  const lock = (await db.get(lockKey)) || { fails: 0, until: 0 };
  if (lock.until > Date.now()) throw new HttpError(429, 'PIN을 여러 번 틀려 10분간 잠겼습니다. 사장님께 문의하세요.');
  if (!PIN_RE.test(String(body.pin ?? '')) || !checkPin(String(body.pin), emp.pinHash)) {
    lock.fails += 1;
    if (lock.fails >= 5) {
      lock.until = Date.now() + 10 * 60e3;
      lock.fails = 0;
    }
    await db.set(lockKey, lock);
    throw new HttpError(401, 'PIN이 올바르지 않습니다.');
  }
  await db.del(lockKey);
  return {
    token: sign({ role: 'employee', empId: emp.id, exp: Date.now() + 30 * 24 * 3600e3 }),
    role: 'employee',
    user: publicEmployee(emp),
  };
}

// ───────────── 직원 기능 ─────────────
function readGeo(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const acc = Number(body.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw bad('위치정보를 확인할 수 없습니다. 휴대폰 위치 권한을 허용해 주세요.');
  }
  return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null };
}

function checkLocation(cfg, store, geo) {
  const hasStore = store.lat != null && store.lng != null;
  const dist = hasStore ? haversine(geo.lat, geo.lng, store.lat, store.lng) : null;
  const ok = hasStore ? dist <= store.radius : false;
  if (cfg.enforceLocation) {
    if (!hasStore) throw bad(`${store.name}의 위치가 아직 설정되지 않았습니다. 사장님께 문의하세요.`);
    if (geo.acc != null && geo.acc > 300) {
      throw bad(`GPS 정확도가 낮습니다(오차 약 ${geo.acc}m). 실외/창가에서 다시 시도하세요.`);
    }
    if (!ok) throw bad(`${store.name}에서 약 ${dist}m 떨어져 있습니다. 매장 ${store.radius}m 이내에서 기록할 수 있습니다.`);
  }
  return { lat: geo.lat, lng: geo.lng, acc: geo.acc, dist, ok };
}

async function punch(db, emp, body) {
  const cfg = await loadConfig(db);
  const geo = readGeo(body);
  const open = await db.get(`open/${emp.id}`);
  const openRec = open ? await db.get(open.key) : null;

  if (body.type === 'in') {
    const store = cfg.stores.find((s) => s.id === body.storeId);
    if (!store) throw bad('매장을 선택하세요.');
    if (openRec && Date.now() - new Date(openRec.inAt).getTime() < 16 * 3600e3) {
      throw bad('이미 출근 처리되어 있습니다. 먼저 퇴근을 기록하세요.');
    }
    const g = checkLocation(cfg, store, geo);
    const now = new Date().toISOString();
    const rec = {
      id: newId(), empId: emp.id, storeId: store.id, date: kstDate(now),
      inAt: now, outAt: null, breakMin: 0, source: 'gps', status: 'ok', note: '',
      inGeo: g, outGeo: null,
    };
    // 16시간 넘게 열려있던 이전 기록은 미퇴근 상태로 남겨 관리자가 보정
    await saveRecord(db, rec);
    return { record: rec, message: `${store.name} 출근 완료` + (g.dist != null ? ` (매장에서 ${g.dist}m)` : '') };
  }

  if (body.type === 'out') {
    if (!openRec) throw bad('출근 기록이 없습니다. 출근을 먼저 기록하세요.');
    const store = cfg.stores.find((s) => s.id === openRec.storeId);
    const g = checkLocation(cfg, store, geo);
    openRec.outAt = new Date().toISOString();
    openRec.outGeo = g;
    await saveRecord(db, openRec);
    return { record: openRec, message: `${store.name} 퇴근 완료` + (g.dist != null ? ` (매장에서 ${g.dist}m)` : '') };
  }
  throw bad('잘못된 요청입니다.');
}

function buildTimes(date, start, end) {
  if (!DATE_RE.test(date) || !TIME_RE.test(start) || (end && !TIME_RE.test(end))) {
    throw bad('날짜/시간 형식이 올바르지 않습니다.');
  }
  const inAt = kstToIso(date, start);
  let outAt = null;
  if (end) {
    outAt = kstToIso(date, end);
    // 종료가 시작보다 이르거나 같으면 익일 퇴근(야간 근무)으로 처리
    if (outAt <= inAt) outAt = new Date(new Date(outAt).getTime() + 86400e3).toISOString();
  }
  return { inAt, outAt };
}

function readBreak(v) {
  const n = Math.round(Number(v ?? 0));
  if (!Number.isFinite(n) || n < 0 || n > 600) throw bad('휴게시간은 0~600분으로 입력하세요.');
  return n;
}

async function manualEntry(db, emp, body) {
  const cfg = await loadConfig(db);
  if (!cfg.stores.some((s) => s.id === body.storeId)) throw bad('매장을 선택하세요.');
  if (!body.end) throw bad('퇴근 시간을 입력하세요.');
  const { inAt, outAt } = buildTimes(body.date, body.start, body.end);
  if (new Date(inAt).getTime() > Date.now() + 3600e3) throw bad('미래 날짜는 입력할 수 없습니다.');
  const rec = {
    id: newId(), empId: emp.id, storeId: body.storeId, date: body.date,
    inAt, outAt, breakMin: readBreak(body.breakMin), source: 'manual', status: 'pending',
    note: String(body.note ?? '').slice(0, 200), inGeo: null, outGeo: null,
  };
  await saveRecord(db, rec);
  return { record: rec, message: '수기 입력이 등록되었습니다. 관리자 확인 후 확정됩니다.' };
}

// ───────────── 관리자 기능 ─────────────
async function adminUpdateRecord(db, id, body) {
  const old = await findRecord(db, id);
  if (!old) throw new HttpError(404, '기록을 찾을 수 없습니다.');
  const cfg = await loadConfig(db);
  if (body.storeId && !cfg.stores.some((s) => s.id === body.storeId)) throw bad('매장이 올바르지 않습니다.');
  const { inAt, outAt } = buildTimes(body.date, body.start, body.end || null);
  const next = {
    ...old,
    date: body.date, inAt, outAt,
    storeId: body.storeId || old.storeId,
    breakMin: readBreak(body.breakMin),
    status: body.status === 'pending' ? 'pending' : 'ok',
    note: String(body.note ?? '').slice(0, 200),
  };
  if (recKey(old) !== recKey(next)) await removeRecord(db, old);
  await saveRecord(db, next);
  return next;
}

async function adminCreateRecord(db, body) {
  const cfg = await loadConfig(db);
  if (!cfg.employees.some((e) => e.id === body.empId)) throw bad('직원을 선택하세요.');
  if (!cfg.stores.some((s) => s.id === body.storeId)) throw bad('매장을 선택하세요.');
  const { inAt, outAt } = buildTimes(body.date, body.start, body.end || null);
  const rec = {
    id: newId(), empId: body.empId, storeId: body.storeId, date: body.date,
    inAt, outAt, breakMin: readBreak(body.breakMin), source: 'admin', status: 'ok',
    note: String(body.note ?? '').slice(0, 200), inGeo: null, outGeo: null,
  };
  await saveRecord(db, rec);
  return rec;
}

function readName(v) {
  const name = String(v ?? '').trim();
  if (!name || name.length > 20) throw bad('이름은 1~20자로 입력하세요.');
  return name;
}

async function adminSaveStores(db, body) {
  const cfg = await loadConfig(db);
  const list = Array.isArray(body.stores) ? body.stores : [];
  cfg.stores = cfg.stores.map((s) => {
    const n = list.find((x) => x.id === s.id);
    if (!n) return s;
    const lat = n.lat === '' || n.lat == null ? null : Number(n.lat);
    const lng = n.lng === '' || n.lng == null ? null : Number(n.lng);
    if ((lat != null && !(Math.abs(lat) <= 90)) || (lng != null && !(Math.abs(lng) <= 180))) throw bad('좌표가 올바르지 않습니다.');
    const radius = Math.round(Number(n.radius));
    if (!(radius >= 20 && radius <= 2000)) throw bad('허용 반경은 20~2000m로 입력하세요.');
    return { ...s, name: readName(n.name), lat, lng, radius };
  });
  if (typeof body.enforceLocation === 'boolean') cfg.enforceLocation = body.enforceLocation;
  await db.set('config', cfg);
}

// ───────────── 라우터 ─────────────
async function route(req, db) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const method = req.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  const seg = path.split('/').filter(Boolean);

  // 공개
  if (method === 'GET' && path === '/bootstrap') {
    const cfg = await loadConfig(db);
    return {
      stores: cfg.stores.map((s) => ({ id: s.id, name: s.name })),
      employees: cfg.employees.filter((e) => e.active).map(publicEmployee),
    };
  }
  if (method === 'POST' && path === '/login') return login(db, body);

  // 직원
  if (seg[0] === 'me') {
    const p = auth(req, 'employee');
    const cfg = await loadConfig(db);
    const emp = cfg.employees.find((e) => e.id === p.empId && e.active);
    if (!emp) throw new HttpError(401, '사용할 수 없는 계정입니다.');

    if (method === 'GET' && path === '/me') {
      const open = await db.get(`open/${emp.id}`);
      return {
        user: publicEmployee(emp),
        stores: cfg.stores.map((s) => ({ id: s.id, name: s.name, radius: s.radius })),
        enforceLocation: cfg.enforceLocation,
        open: open ? await db.get(open.key) : null,
      };
    }
    if (method === 'GET' && path === '/me/records') {
      const month = url.searchParams.get('month') || '';
      if (!MONTH_RE.test(month)) throw bad('month 형식이 올바르지 않습니다.');
      return { records: (await loadMonth(db, month)).filter((r) => r.empId === emp.id) };
    }
    if (method === 'POST' && path === '/me/punch') return punch(db, emp, body);
    if (method === 'POST' && path === '/me/manual') return manualEntry(db, emp, body);
    if (method === 'POST' && path === '/me/pin') {
      if (!checkPin(String(body.oldPin ?? ''), emp.pinHash)) throw bad('현재 PIN이 올바르지 않습니다.');
      if (!PIN_RE.test(String(body.newPin ?? ''))) throw bad('새 PIN은 숫자 4~6자리입니다.');
      emp.pinHash = hashPin(String(body.newPin));
      await db.set('config', cfg);
      return { ok: true };
    }
  }

  // 관리자
  if (seg[0] === 'admin') {
    auth(req, 'admin');

    if (method === 'GET' && path === '/admin/config') {
      const cfg = await loadConfig(db);
      return { enforceLocation: cfg.enforceLocation, stores: cfg.stores, employees: cfg.employees.map(publicEmployee) };
    }
    if (method === 'GET' && path === '/admin/records') {
      const month = url.searchParams.get('month') || '';
      if (!MONTH_RE.test(month)) throw bad('month 형식이 올바르지 않습니다.');
      return { records: await loadMonth(db, month) };
    }
    if (method === 'POST' && path === '/admin/records') return { record: await adminCreateRecord(db, body) };
    if (seg[1] === 'records' && seg[2]) {
      if (method === 'PUT') return { record: await adminUpdateRecord(db, seg[2], body) };
      if (method === 'DELETE') {
        const r = await findRecord(db, seg[2]);
        if (!r) throw new HttpError(404, '기록을 찾을 수 없습니다.');
        await removeRecord(db, r);
        return { ok: true };
      }
    }
    if (method === 'PUT' && path === '/admin/stores') {
      await adminSaveStores(db, body);
      return { ok: true };
    }
    if (method === 'POST' && path === '/admin/employees') {
      const cfg = await loadConfig(db);
      const name = readName(body.name);
      if (!PIN_RE.test(String(body.pin ?? ''))) throw bad('PIN은 숫자 4~6자리입니다.');
      if (cfg.employees.some((e) => e.active && e.name === name)) throw bad('같은 이름의 직원이 이미 있습니다.');
      cfg.employees.push({ id: newId(), name, active: true, pinHash: hashPin(String(body.pin)) });
      await db.set('config', cfg);
      return { ok: true };
    }
    if (method === 'PUT' && seg[1] === 'employees' && seg[2]) {
      const cfg = await loadConfig(db);
      const emp = cfg.employees.find((e) => e.id === seg[2]);
      if (!emp) throw new HttpError(404, '직원을 찾을 수 없습니다.');
      if (body.name !== undefined) emp.name = readName(body.name);
      if (typeof body.active === 'boolean') emp.active = body.active;
      if (body.pin !== undefined && body.pin !== '') {
        if (!PIN_RE.test(String(body.pin))) throw bad('PIN은 숫자 4~6자리입니다.');
        emp.pinHash = hashPin(String(body.pin));
        await db.del(`lock/${emp.id}`);
      }
      await db.set('config', cfg);
      return { ok: true };
    }
  }

  throw new HttpError(404, '존재하지 않는 API입니다.');
}

export default async (req) => {
  try {
    return json(await route(req, getDb()));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: '서버 오류가 발생했습니다.' }, 500);
  }
};
