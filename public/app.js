'use strict';

// ───────────── 유틸 ─────────────
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KST = 'Asia/Seoul';
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false }) : '');
// 'YYYY-MM-DD'는 이미 KST 날짜이므로 브라우저 시간대와 무관하게 UTC 기준으로 요일만 계산
const fmtDate = (d) => {
  const dt = new Date(d + 'T00:00:00Z');
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${'일월화수목금토'[dt.getUTCDay()]})`;
};
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const monthKst = (offset = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
};
const shiftMonth = (m, n) => {
  const d = new Date(m + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const workMin = (r) => (r.outAt ? Math.max(0, Math.round((new Date(r.outAt) - new Date(r.inAt)) / 60000) - (r.breakMin || 0)) : 0);
const fmtHM = (min) => `${Math.floor(min / 60)}시간 ${String(min % 60).padStart(2, '0')}분`;
const fmtH = (min) => (min / 60).toFixed(2);

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const session = {
  get token() { try { return localStorage.getItem('token') || ''; } catch { return ''; } },
  get role() { try { return localStorage.getItem('role') || ''; } catch { return ''; } },
  set(token, role) { try { localStorage.setItem('token', token); localStorage.setItem('role', role); } catch { /* 저장 불가 환경 */ } },
  clear() { try { localStorage.removeItem('token'); localStorage.removeItem('role'); } catch { /* noop */ } },
};

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(session.token ? { authorization: 'Bearer ' + session.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 비JSON 응답 */ }
  if (res.status === 401 && session.token) {
    session.clear();
    if (path !== '/login') { toast('다시 로그인해 주세요.'); start(); }
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('이 브라우저는 위치정보를 지원하지 않습니다.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(
        e.code === 1 ? '위치 권한이 꺼져 있습니다. 브라우저/휴대폰 설정에서 이 사이트의 위치 권한을 허용해 주세요.'
        : e.code === 3 ? '위치 확인 시간이 초과되었습니다. 다시 시도해 주세요.'
        : '위치를 확인할 수 없습니다. GPS를 켜고 다시 시도해 주세요.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'msg ' + (kind || '');
  el.textContent = text;
  el.hidden = !text;
}

// ───────────── 로그인 ─────────────
async function start() {
  if (session.token && session.role === 'employee') return renderEmployee().catch(loginFallback);
  if (session.token && session.role === 'admin') return renderAdmin().catch(loginFallback);
  return renderLogin();
}
function loginFallback() { session.clear(); renderLogin(); }

async function renderLogin(tab = 'employee') {
  let boot;
  try { boot = await api('GET', '/bootstrap'); } catch (e) { boot = { employees: [], stores: [], error: e.message }; }
  $app.innerHTML = `
    <div class="top"><h1>🏪 편의점 근무기록</h1></div>
    <div class="tabs">
      <button data-tab="employee" class="${tab === 'employee' ? 'on' : ''}">직원 모드</button>
      <button data-tab="admin" class="${tab === 'admin' ? 'on' : ''}">관리자 모드</button>
    </div>
    <div class="card">
      ${tab === 'employee' ? `
        <h2>직원 로그인</h2>
        <label for="emp">이름</label>
        <select id="emp">${boot.employees.length ? boot.employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('') : '<option value="">등록된 직원이 없습니다</option>'}</select>
        <label for="pin">PIN (숫자 4~6자리)</label>
        <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6">
        <div class="actions"><button class="primary" id="go">로그인</button></div>
        <p class="hint">PIN을 모르면 사장님께 문의하세요.</p>` : `
        <h2>관리자 로그인</h2>
        <label for="pw">비밀번호</label>
        <input id="pw" type="password" autocomplete="current-password">
        <div class="actions"><button class="primary" id="go">로그인</button></div>`}
      <div id="msg" class="msg err" hidden></div>
      ${boot.error ? `<div class="msg err">${esc(boot.error)}</div>` : ''}
    </div>`;
  $app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => renderLogin(b.dataset.tab)));
  const submit = async () => {
    const btn = document.getElementById('go');
    btn.disabled = true;
    try {
      const body = tab === 'employee'
        ? { role: 'employee', empId: document.getElementById('emp').value, pin: document.getElementById('pin').value }
        : { role: 'admin', password: document.getElementById('pw').value };
      const r = await api('POST', '/login', body);
      session.set(r.token, r.role);
      start();
    } catch (e) { setMsg('msg', e.message, 'err'); btn.disabled = false; }
  };
  document.getElementById('go').onclick = submit;
  $app.querySelector('input:last-of-type').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function logout() {
  session.clear();
  Object.assign(adm, { tab: 'records', month: monthKst(), store: '', emp: '' });
  renderLogin();
}

// ───────────── 직원 모드 ─────────────
async function renderEmployee(month = monthKst()) {
  const [me, rec] = await Promise.all([api('GET', '/me'), api('GET', '/me/records?month=' + month)]);
  const storeName = (id) => me.stores.find((s) => s.id === id)?.name || '-';
  const open = me.open;
  const total = rec.records.reduce((a, r) => a + workMin(r), 0);

  $app.innerHTML = `
    <div class="top"><div><h1>${esc(me.user.name)}님</h1><div class="who">직원 모드</div></div>
      <div><button class="small" id="pin">PIN 변경</button> <button class="small" id="out">로그아웃</button></div></div>

    <div class="card">
      <div class="status" id="st">${open
        ? `<b>${esc(storeName(open.storeId))}</b> 근무 중<br><span class="sub">${fmtDate(open.date)} ${fmtTime(open.inAt)} 출근 · <span id="el"></span></span>`
        : '<b>퇴근 상태</b><br><span class="sub">출근할 매장을 선택하고 버튼을 누르세요.</span>'}</div>
      ${open ? '' : `<label for="store">매장</label>
        <select id="store">${me.stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`}
      <div style="margin-top:12px"><button class="punch ${open ? 'out' : 'in'}" id="punch">${open ? '퇴근하기' : '출근하기'}</button></div>
      <div id="pmsg" class="msg" hidden></div>
      <p class="hint">${me.enforceLocation ? '📍 매장 근처에서만 기록됩니다. 버튼을 누르면 현재 위치를 확인합니다.' : '📍 현재 위치가 함께 기록됩니다.'}</p>
    </div>

    <div class="card">
      <div class="monthnav">
        <button class="small" id="prev">◀</button><b>${month.replace('-', '년 ')}월</b><button class="small" id="next">▶</button>
      </div>
      <div class="list">${rec.records.length ? rec.records.map((r) => `
        <div class="item"><div class="l">
          <b>${fmtDate(r.date)}</b> ${esc(storeName(r.storeId))}
          ${r.source === 'manual' ? `<span class="badge ${r.status === 'pending' ? 'warn' : 'ok'}">수기${r.status === 'pending' ? '·확인대기' : ''}</span>` : ''}
          ${r.source === 'admin' ? '<span class="badge">관리자입력</span>' : ''}
          ${!r.outAt ? (open && open.id === r.id ? '<span class="badge ok">근무중</span>' : '<span class="badge bad">퇴근미기록</span>') : ''}
          <div class="sub">${fmtTime(r.inAt)} ~ ${r.outAt ? fmtTime(r.outAt) : '근무중'}${r.breakMin ? ` · 휴게 ${r.breakMin}분` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</div>
        </div><div class="r">${r.outAt ? fmtHM(workMin(r)) : '-'}</div></div>`).join('')
        : '<p class="sub">이번 달 기록이 없습니다.</p>'}</div>
      <div class="total"><span>월 합계</span><span>${fmtHM(total)} (${fmtH(total)}h)</span></div>
      <div class="actions"><button id="manual">출퇴근을 놓쳤나요? 직접 입력</button></div>
    </div>

    <dialog id="dlg"></dialog>`;

  document.getElementById('out').onclick = logout;
  document.getElementById('prev').onclick = () => renderEmployee(shiftMonth(month, -1));
  document.getElementById('next').onclick = () => renderEmployee(shiftMonth(month, 1));

  if (open) {
    const tick = () => {
      const el = document.getElementById('el');
      if (!el) return clearInterval(iv);
      el.textContent = fmtHM(Math.floor((Date.now() - new Date(open.inAt)) / 60000)) + ' 경과';
    };
    const iv = setInterval(tick, 30000);
    tick();
  }

  const punchBtn = document.getElementById('punch');
  punchBtn.onclick = async () => {
    punchBtn.disabled = true;
    setMsg('pmsg', '📡 현재 위치 확인 중… (최대 20초)', '');
    try {
      const pos = await getPosition();
      const r = await api('POST', '/me/punch', {
        type: open ? 'out' : 'in',
        storeId: open ? open.storeId : document.getElementById('store').value,
        ...pos,
      });
      toast(r.message);
      renderEmployee(month);
    } catch (e) { setMsg('pmsg', e.message, 'err'); punchBtn.disabled = false; }
  };

  const dlg = document.getElementById('dlg');
  document.getElementById('manual').onclick = () => {
    dlg.innerHTML = `
      <h2>근무시간 직접 입력</h2>
      <p class="hint">위치 확인 없이 등록되며, 관리자 확인 후 확정됩니다. 퇴근이 출근보다 빠르면 다음날 퇴근으로 계산됩니다.</p>
      <label>매장</label><select id="m-store">${me.stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
      <label>근무일(출근한 날)</label><input id="m-date" type="date" value="${todayKst()}" max="${todayKst()}">
      <div class="row"><div><label>출근</label><input id="m-start" type="time" value="09:00"></div><div><label>퇴근</label><input id="m-end" type="time" value="18:00"></div></div>
      <label>휴게시간(분)</label><input id="m-break" type="number" inputmode="numeric" min="0" max="600" value="0">
      <label>사유(선택)</label><input id="m-note" maxlength="200" placeholder="예: 퇴근 버튼을 깜빡함">
      <div id="m-msg" class="msg err" hidden></div>
      <div class="actions"><button id="m-cancel">취소</button><button class="primary" id="m-save">등록</button></div>`;
    dlg.showModal();
    document.getElementById('m-cancel').onclick = () => dlg.close();
    document.getElementById('m-save').onclick = async () => {
      try {
        await api('POST', '/me/manual', {
          storeId: document.getElementById('m-store').value, date: document.getElementById('m-date').value,
          start: document.getElementById('m-start').value, end: document.getElementById('m-end').value,
          breakMin: document.getElementById('m-break').value, note: document.getElementById('m-note').value,
        });
        dlg.close(); toast('등록되었습니다. 관리자 확인 대기 중'); renderEmployee(month);
      } catch (e) { setMsg('m-msg', e.message, 'err'); }
    };
  };

  document.getElementById('pin').onclick = () => {
    dlg.innerHTML = `
      <h2>PIN 변경</h2>
      <label>현재 PIN</label><input id="p-old" type="password" inputmode="numeric" maxlength="6">
      <label>새 PIN (숫자 4~6자리)</label><input id="p-new" type="password" inputmode="numeric" maxlength="6">
      <div id="p-msg" class="msg err" hidden></div>
      <div class="actions"><button id="p-cancel">취소</button><button class="primary" id="p-save">변경</button></div>`;
    dlg.showModal();
    document.getElementById('p-cancel').onclick = () => dlg.close();
    document.getElementById('p-save').onclick = async () => {
      try {
        await api('POST', '/me/pin', { oldPin: document.getElementById('p-old').value, newPin: document.getElementById('p-new').value });
        dlg.close(); toast('PIN이 변경되었습니다.');
      } catch (e) { setMsg('p-msg', e.message, 'err'); }
    };
  };
}

// ───────────── 관리자 모드 ─────────────
const adm = { tab: 'records', month: monthKst(), store: '', emp: '', cfg: null, records: [] };

async function loadAdmin() {
  const [cfg, rec] = await Promise.all([api('GET', '/admin/config'), api('GET', '/admin/records?month=' + adm.month)]);
  adm.cfg = cfg;
  adm.records = rec.records;
}

async function renderAdmin() {
  await loadAdmin();
  $app.innerHTML = `
    <div class="top"><div><h1>관리자</h1><div class="who">관리자 모드</div></div><button class="small" id="out">로그아웃</button></div>
    <div class="tabs">
      ${[['records', '근무기록'], ['summary', '월 집계'], ['emps', '직원'], ['stores', '매장']].map(([k, n]) => `<button data-t="${k}" class="${adm.tab === k ? 'on' : ''}">${n}</button>`).join('')}
    </div>
    <div id="view"></div><dialog id="dlg"></dialog>`;
  document.getElementById('out').onclick = logout;
  $app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { adm.tab = b.dataset.t; renderAdmin(); }));
  ({ records: viewRecords, summary: viewSummary, emps: viewEmployees, stores: viewStores })[adm.tab]();
}

const empName = (id) => adm.cfg.employees.find((e) => e.id === id)?.name || '(삭제됨)';
const stName = (id) => adm.cfg.stores.find((s) => s.id === id)?.name || '-';
const filtered = () => adm.records.filter((r) => (!adm.store || r.storeId === adm.store) && (!adm.emp || r.empId === adm.emp));

function monthBar() {
  return `<div class="monthnav"><button class="small" id="prev">◀</button><b>${adm.month.replace('-', '년 ')}월</b><button class="small" id="next">▶</button></div>`;
}
function bindMonthBar() {
  document.getElementById('prev').onclick = () => { adm.month = shiftMonth(adm.month, -1); renderAdmin(); };
  document.getElementById('next').onclick = () => { adm.month = shiftMonth(adm.month, 1); renderAdmin(); };
}
function filterBar() {
  return `<div class="row">
    <div><label>매장</label><select id="f-store"><option value="">전체</option>${adm.cfg.stores.map((s) => `<option value="${esc(s.id)}" ${adm.store === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div><label>직원</label><select id="f-emp"><option value="">전체</option>${adm.cfg.employees.map((e) => `<option value="${esc(e.id)}" ${adm.emp === e.id ? 'selected' : ''}>${esc(e.name)}${e.active ? '' : ' (퇴사)'}</option>`).join('')}</select></div></div>`;
}
function bindFilters() {
  document.getElementById('f-store').onchange = (e) => { adm.store = e.target.value; renderAdmin(); };
  document.getElementById('f-emp').onchange = (e) => { adm.emp = e.target.value; renderAdmin(); };
}

function geoBadge(r) {
  if (r.source === 'manual') return `<span class="badge ${r.status === 'pending' ? 'warn' : 'ok'}">수기${r.status === 'pending' ? '·확인대기' : ''}</span>`;
  if (r.source === 'admin') return '<span class="badge">관리자입력</span>';
  const g = (x, label) => (x ? `<span class="badge ${x.ok ? 'ok' : 'bad'}" title="정확도 ±${x.acc ?? '?'}m">${label} ${x.dist != null ? x.dist + 'm' : '위치기록'}</span>` : '');
  return g(r.inGeo, '출근') + g(r.outGeo, '퇴근');
}

function viewRecords() {
  const rows = filtered();
  const total = rows.reduce((a, r) => a + workMin(r), 0);
  const pending = rows.filter((r) => r.status === 'pending').length;
  document.getElementById('view').innerHTML = `
    <div class="card">${monthBar()}${filterBar()}
      <div class="actions"><button id="add">＋ 기록 추가</button><button id="csv">CSV 내보내기</button></div></div>
    <div class="card">
      ${pending ? `<div class="msg" style="margin:0 0 10px">확인 대기 중인 수기 입력 ${pending}건이 있습니다.</div>` : ''}
      <div class="tablewrap"><table>
        <tr><th>날짜</th><th>직원</th><th>매장</th><th>출근</th><th>퇴근</th><th class="num">휴게</th><th class="num">근무</th><th>위치/구분</th><th></th></tr>
        ${rows.length ? rows.map((r) => `<tr>
          <td>${fmtDate(r.date)}</td><td>${esc(empName(r.empId))}</td><td>${esc(stName(r.storeId))}</td>
          <td>${fmtTime(r.inAt)}</td><td>${r.outAt ? fmtTime(r.outAt) : '<span class="badge bad">미기록</span>'}</td>
          <td class="num">${r.breakMin || 0}분</td><td class="num">${r.outAt ? fmtH(workMin(r)) + 'h' : '-'}</td>
          <td>${geoBadge(r)}${r.note ? `<div class="sub">${esc(r.note)}</div>` : ''}</td>
          <td>${r.status === 'pending' ? `<button class="small primary" data-ok="${esc(r.id)}">확정</button> ` : ''}<button class="small" data-edit="${esc(r.id)}">수정</button></td></tr>`).join('')
          : '<tr><td colspan="9" class="sub">기록이 없습니다.</td></tr>'}
      </table></div>
      <div class="total"><span>합계</span><span>${fmtHM(total)} (${fmtH(total)}h)</span></div></div>`;
  bindMonthBar(); bindFilters();
  document.getElementById('add').onclick = () => recordDialog(null);
  document.getElementById('csv').onclick = () => exportCsv(rows);
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => recordDialog(rows.find((r) => r.id === b.dataset.edit))));
  document.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => {
    const r = rows.find((x) => x.id === b.dataset.ok);
    try { await saveRecord(r, { status: 'ok' }); toast('확정했습니다.'); renderAdmin(); } catch (e) { toast(e.message); }
  }));
}

function saveRecord(r, over = {}) {
  const v = {
    date: r.date, start: fmtTime(r.inAt), end: r.outAt ? fmtTime(r.outAt) : '',
    storeId: r.storeId, breakMin: r.breakMin || 0, status: r.status, note: r.note || '', ...over,
  };
  return api('PUT', '/admin/records/' + r.id, v);
}

function recordDialog(r) {
  const dlg = document.getElementById('dlg');
  const isNew = !r;
  dlg.innerHTML = `
    <h2>${isNew ? '근무 기록 추가' : '근무 기록 수정'}</h2>
    ${isNew ? `<label>직원</label><select id="d-emp">${adm.cfg.employees.filter((e) => e.active).map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>` : `<p><b>${esc(empName(r.empId))}</b></p>`}
    <label>매장</label><select id="d-store">${adm.cfg.stores.map((s) => `<option value="${esc(s.id)}" ${(r?.storeId || '') === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <label>근무일(출근한 날)</label><input id="d-date" type="date" value="${r ? r.date : todayKst()}">
    <div class="row"><div><label>출근</label><input id="d-start" type="time" value="${r ? fmtTime(r.inAt) : '09:00'}"></div>
    <div><label>퇴근</label><input id="d-end" type="time" value="${r?.outAt ? fmtTime(r.outAt) : isNew ? '18:00' : ''}"></div></div>
    <label>휴게시간(분)</label><input id="d-break" type="number" min="0" max="600" value="${r?.breakMin || 0}">
    <label>메모</label><input id="d-note" maxlength="200" value="${esc(r?.note || '')}">
    ${isNew ? '' : `<div class="check"><input type="checkbox" id="d-pending" ${r.status === 'pending' ? 'checked' : ''}><label for="d-pending" style="margin:0">확인 대기 상태로 두기</label></div>`}
    <div id="d-msg" class="msg err" hidden></div>
    <div class="actions">${isNew ? '' : '<button class="danger" id="d-del">삭제</button>'}<button id="d-cancel">취소</button><button class="primary" id="d-save">저장</button></div>`;
  dlg.showModal();
  document.getElementById('d-cancel').onclick = () => dlg.close();
  if (!isNew) document.getElementById('d-del').onclick = async () => {
    if (!confirm('이 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    try { await api('DELETE', '/admin/records/' + r.id); dlg.close(); toast('삭제했습니다.'); renderAdmin(); } catch (e) { setMsg('d-msg', e.message, 'err'); }
  };
  document.getElementById('d-save').onclick = async () => {
    const v = {
      date: document.getElementById('d-date').value, start: document.getElementById('d-start').value, end: document.getElementById('d-end').value,
      storeId: document.getElementById('d-store').value, breakMin: document.getElementById('d-break').value, note: document.getElementById('d-note').value,
    };
    try {
      if (isNew) await api('POST', '/admin/records', { ...v, empId: document.getElementById('d-emp').value });
      else await api('PUT', '/admin/records/' + r.id, { ...v, status: document.getElementById('d-pending').checked ? 'pending' : 'ok' });
      dlg.close(); toast('저장했습니다.'); renderAdmin();
    } catch (e) { setMsg('d-msg', e.message, 'err'); }
  };
}

function exportCsv(rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['날짜', '직원', '매장', '출근', '퇴근', '휴게(분)', '근무(시간)', '구분', '출근거리(m)', '퇴근거리(m)', '상태', '메모'];
  const body = [...rows].sort((a, b) => (a.inAt > b.inAt ? 1 : -1)).map((r) => [
    r.date, empName(r.empId), stName(r.storeId), fmtTime(r.inAt), fmtTime(r.outAt), r.breakMin || 0, r.outAt ? fmtH(workMin(r)) : '',
    { gps: 'GPS', manual: '수기', admin: '관리자' }[r.source], r.inGeo?.dist ?? '', r.outGeo?.dist ?? '', r.status === 'pending' ? '확인대기' : '확정', r.note,
  ]);
  const csv = '﻿' + [head, ...body].map((row) => row.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `근무기록_${adm.month}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function viewSummary() {
  const rows = adm.records.filter((r) => r.outAt);
  const map = new Map();
  for (const r of rows) {
    const e = map.get(r.empId) || { total: 0, days: new Set(), by: {} };
    const m = workMin(r);
    e.total += m; e.days.add(r.date); e.by[r.storeId] = (e.by[r.storeId] || 0) + m;
    map.set(r.empId, e);
  }
  const grand = [...map.values()].reduce((a, e) => a + e.total, 0);
  document.getElementById('view').innerHTML = `
    <div class="card">${monthBar()}
      <div class="tablewrap"><table>
        <tr><th>직원</th><th class="num">근무일수</th>${adm.cfg.stores.map((s) => `<th class="num">${esc(s.name)}(h)</th>`).join('')}<th class="num">합계(h)</th></tr>
        ${map.size ? [...map].sort((a, b) => b[1].total - a[1].total).map(([id, e]) => `<tr>
          <td>${esc(empName(id))}</td><td class="num">${e.days.size}일</td>
          ${adm.cfg.stores.map((s) => `<td class="num">${fmtH(e.by[s.id] || 0)}</td>`).join('')}
          <td class="num"><b>${fmtH(e.total)}</b></td></tr>`).join('') : `<tr><td colspan="${adm.cfg.stores.length + 3}" class="sub">집계할 기록이 없습니다.</td></tr>`}
      </table></div>
      <div class="total"><span>전체 합계</span><span>${fmtH(grand)}h</span></div>
      <p class="hint">퇴근이 기록된 근무만 집계됩니다(휴게시간 차감). 확인 대기 중인 수기 입력도 포함되니 '근무기록' 탭에서 확정하세요.</p></div>`;
  bindMonthBar();
}

function viewEmployees() {
  document.getElementById('view').innerHTML = `
    <div class="card"><h2>직원 등록</h2>
      <div class="row"><div><label>이름</label><input id="n-name" maxlength="20"></div><div><label>PIN (숫자 4~6자리)</label><input id="n-pin" inputmode="numeric" maxlength="6"></div></div>
      <div id="n-msg" class="msg err" hidden></div>
      <div class="actions"><button class="primary" id="n-add">등록</button></div></div>
    <div class="card"><h2>직원 목록</h2><div class="list">
      ${adm.cfg.employees.length ? adm.cfg.employees.map((e) => `
        <div class="item"><div class="l"><b>${esc(e.name)}</b> ${e.active ? '' : '<span class="badge">퇴사</span>'}</div>
        <div class="r"><button class="small" data-pin="${esc(e.id)}">PIN 재설정</button>
        <button class="small" data-ren="${esc(e.id)}">이름</button>
        <button class="small ${e.active ? 'danger' : ''}" data-act="${esc(e.id)}">${e.active ? '퇴사 처리' : '복직'}</button></div></div>`).join('')
        : '<p class="sub">등록된 직원이 없습니다.</p>'}</div>
      <p class="hint">퇴사 처리해도 과거 근무기록은 유지되며, 로그인만 막힙니다.</p></div>`;
  document.getElementById('n-add').onclick = async () => {
    try {
      await api('POST', '/admin/employees', { name: document.getElementById('n-name').value, pin: document.getElementById('n-pin').value });
      toast('등록했습니다.'); renderAdmin();
    } catch (e) { setMsg('n-msg', e.message, 'err'); }
  };
  const upd = async (id, body) => { try { await api('PUT', '/admin/employees/' + id, body); toast('저장했습니다.'); renderAdmin(); } catch (e) { toast(e.message); } };
  document.querySelectorAll('[data-pin]').forEach((b) => (b.onclick = () => {
    const pin = prompt('새 PIN (숫자 4~6자리)');
    if (pin) upd(b.dataset.pin, { pin });
  }));
  document.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = () => {
    const cur = adm.cfg.employees.find((e) => e.id === b.dataset.ren);
    const name = prompt('새 이름', cur.name);
    if (name) upd(b.dataset.ren, { name });
  }));
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
    const cur = adm.cfg.employees.find((e) => e.id === b.dataset.act);
    if (!cur.active || confirm(`${cur.name}님을 복직 처리할까요?`)) {
      if (cur.active && !confirm(`${cur.name}님을 퇴사 처리할까요? 로그인이 차단됩니다.`)) return;
      upd(cur.id, { active: !cur.active });
    }
  }));
}

function viewStores() {
  const c = adm.cfg;
  document.getElementById('view').innerHTML = `
    <div class="card"><h2>매장 위치 설정</h2>
      <p class="hint" style="margin-top:0">각 매장에 <b>직접 방문한 상태의 휴대폰</b>에서 관리자로 로그인해 「현재 위치로 설정」을 누르는 것이 가장 정확합니다.</p>
      ${c.stores.map((s) => `<div class="storebox" data-sid="${esc(s.id)}">
        <label>매장명</label><input class="s-name" maxlength="20" value="${esc(s.name)}">
        <div class="row"><div><label>위도</label><input class="s-lat" inputmode="decimal" value="${s.lat ?? ''}"></div><div><label>경도</label><input class="s-lng" inputmode="decimal" value="${s.lng ?? ''}"></div></div>
        <label>허용 반경(m)</label><input class="s-rad" type="number" min="20" max="2000" value="${s.radius}">
        <div class="actions"><button class="s-here">📍 현재 위치로 설정</button></div>
        <div class="hint">${s.lat == null ? '⚠ 위치 미설정' : '설정됨'}</div></div>`).join('')}
      <div class="check"><input type="checkbox" id="enf" ${c.enforceLocation ? 'checked' : ''}><label for="enf" style="margin:0">매장 반경 밖에서는 출퇴근 기록 차단</label></div>
      <p class="hint">해제하면 위치는 기록하되 차단하지 않습니다(근무기록 탭에서 거리 확인 가능). 실내 GPS 오차를 고려해 반경은 100~150m를 권장합니다.</p>
      <div id="s-msg" class="msg err" hidden></div>
      <div class="actions"><button class="primary" id="s-save">저장</button></div></div>`;
  document.querySelectorAll('.s-here').forEach((b) => (b.onclick = async () => {
    const box = b.closest('.storebox');
    b.disabled = true; b.textContent = '위치 확인 중…';
    try {
      const p = await getPosition();
      box.querySelector('.s-lat').value = p.lat.toFixed(6);
      box.querySelector('.s-lng').value = p.lng.toFixed(6);
      toast(`위치 반영 (오차 약 ${Math.round(p.acc)}m). 저장을 눌러 확정하세요.`);
    } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = '📍 현재 위치로 설정';
  }));
  document.getElementById('s-save').onclick = async () => {
    const stores = [...document.querySelectorAll('.storebox')].map((box) => ({
      id: box.dataset.sid, name: box.querySelector('.s-name').value,
      lat: box.querySelector('.s-lat').value.trim(), lng: box.querySelector('.s-lng').value.trim(), radius: box.querySelector('.s-rad').value,
    }));
    try { await api('PUT', '/admin/stores', { stores, enforceLocation: document.getElementById('enf').checked }); toast('저장했습니다.'); renderAdmin(); }
    catch (e) { setMsg('s-msg', e.message, 'err'); }
  };
}

start();
