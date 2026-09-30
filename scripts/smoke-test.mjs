// 로컬 스모크 테스트: 파일 저장소로 API 핸들러를 직접 호출  (npm test)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-'));
process.env.ADMIN_PASSWORD = 'admin-pass';
const { default: handler } = await import('../netlify/functions/api.mjs');

const call = async (method, p, body, token) => {
  const res = await handler(new Request('http://x/api' + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, ...(await res.json()) };
};

const admin = (await call('POST', '/login', { role: 'admin', password: 'admin-pass' })).token;
assert.equal((await call('POST', '/login', { role: 'admin', password: 'nope' })).status, 401);
assert.equal((await call('GET', '/admin/config')).status, 401);

// 매장 위치 설정 (서울시청 근처)
const S = { lat: 37.5663, lng: 126.9779 };
let r = await call('PUT', '/admin/stores', { enforceLocation: true, stores: [
  { id: 's1', name: '강남점', ...S, radius: 100 }, { id: 's2', name: '홍대점', lat: 37.55, lng: 126.92, radius: 100 }] }, admin);
assert.equal(r.status, 200);

// 직원 등록/로그인
assert.equal((await call('POST', '/admin/employees', { name: '김알바', pin: '12' }, admin)).status, 400);
assert.equal((await call('POST', '/admin/employees', { name: '김알바', pin: '1234' }, admin)).status, 200);
const boot = await call('GET', '/bootstrap');
assert.equal(boot.employees.length, 1);
assert.ok(!JSON.stringify(boot).includes('pinHash'));
const empId = boot.employees[0].id;
assert.equal((await call('POST', '/login', { role: 'employee', empId, pin: '9999' })).status, 401);
const emp = (await call('POST', '/login', { role: 'employee', empId, pin: '1234' })).token;
assert.equal((await call('GET', '/admin/config', null, emp)).status, 403);

// 위치 검증: 멀리서 출근 → 차단, 근처 → 성공
r = await call('POST', '/me/punch', { type: 'in', storeId: 's1', lat: 37.60, lng: 127.0, acc: 20 }, emp);
assert.equal(r.status, 400); assert.match(r.error, /떨어져/);
r = await call('POST', '/me/punch', { type: 'in', storeId: 's1', lat: S.lat + 0.0003, lng: S.lng, acc: 20 }, emp);
assert.equal(r.status, 200); assert.equal(r.record.inGeo.ok, true);
assert.equal((await call('POST', '/me/punch', { type: 'in', storeId: 's1', ...S, acc: 10 }, emp)).status, 400); // 중복 출근
assert.equal((await call('GET', '/me', null, emp)).open.storeId, 's1');

// 퇴근 (매장 밖 → 차단, 안 → 성공)
assert.equal((await call('POST', '/me/punch', { type: 'out', lat: 37.7, lng: 127, acc: 10 }, emp)).status, 400);
r = await call('POST', '/me/punch', { type: 'out', ...S, acc: 10 }, emp);
assert.equal(r.status, 200); assert.ok(r.record.outAt);
assert.equal((await call('GET', '/me', null, emp)).open, null);

// 수기 입력(야간 22:00→06:00 = 8시간) 및 관리자 확정/수정/삭제
r = await call('POST', '/me/manual', { storeId: 's2', date: '2026-09-01', start: '22:00', end: '06:00', breakMin: 60 }, emp);
assert.equal(r.status, 200); assert.equal(r.record.status, 'pending');
assert.equal((new Date(r.record.outAt) - new Date(r.record.inAt)) / 60000, 480);
const list = await call('GET', '/admin/records?month=2026-09', null, admin);
assert.equal(list.records.filter((x) => x.source === 'manual').length, 1);
const id = list.records.find((x) => x.source === 'manual').id;
r = await call('PUT', '/admin/records/' + id, { date: '2026-11-01', start: '09:00', end: '18:00', storeId: 's1', breakMin: 60, status: 'ok' }, admin);
assert.equal(r.status, 200);
assert.equal((await call('GET', '/admin/records?month=2026-09', null, admin)).records.filter((x) => x.id === id).length, 0);
assert.equal((await call('GET', '/admin/records?month=2026-11', null, admin)).records.length, 1);
assert.equal((await call('DELETE', '/admin/records/' + id, null, admin)).status, 200);

// PIN 5회 오류 → 잠금 → 관리자 PIN 재설정으로 해제
for (let i = 0; i < 5; i++) await call('POST', '/login', { role: 'employee', empId, pin: '0000' });
assert.equal((await call('POST', '/login', { role: 'employee', empId, pin: '1234' })).status, 429);
await call('PUT', '/admin/employees/' + empId, { pin: '4321' }, admin);
assert.equal((await call('POST', '/login', { role: 'employee', empId, pin: '4321' })).status, 200);

// 퇴사 처리 시 기존 토큰 차단
await call('PUT', '/admin/employees/' + empId, { active: false }, admin);
assert.equal((await call('GET', '/me', null, emp)).status, 401);

console.log('✅ 모든 스모크 테스트 통과');
