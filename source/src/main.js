import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { initializeFirestore, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, deleteField, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
import * as L from './lib.js';
import * as F from './face.js';
import { T } from './i18n.js';

const FC = window.PP_FIREBASE || {};
const S = {
  cfgOk: !!(FC.apiKey && FC.projectId && String(FC.apiKey).indexOf('PASTE') < 0),
  lang: 'te', tab: null, authMode: 'login', authReady: false, uid: null, me: undefined, cfg: L.cfg(null),
  users: [], att: { today: {}, view: {} }, myAtt: {}, ready: {}, unsub: {}, err: '', busy: false, consent: false,
  filter: 'all', today: L.todayIST(), viewMonth: L.todayIST().slice(0, 7), registering: false, drawn: null,
};
try { S.lang = localStorage.getItem('pp-lang') || 'te'; } catch (e) { /* ignore */ }
let db = null, auth = null;

// ---------- helpers ----------
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function t(k, v) {
  let s = (T[S.lang] && T[S.lang][k]) || T.en[k] || k;
  if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]);
  return s;
}
const loc = () => (S.lang === 'te' ? 'te-IN' : 'en-IN');
const TF = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtTime = (ms) => TF.format(new Date(ms));
function fmtDate(d, o) {
  const p = d.split('-');
  try { return new Intl.DateTimeFormat(loc(), Object.assign({ timeZone: 'UTC' }, o || { weekday: 'short', day: 'numeric', month: 'short' })).format(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]))); } catch (e) { return d; }
}
function monthLabel(m) { const p = m.split('-'); try { return new Intl.DateTimeFormat(loc(), { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(+p[0], +p[1] - 1, 1))); } catch (e) { return m; } }
function hm(h) { const m = Math.round(h * 60); return Math.floor(m / 60) + (S.lang === 'te' ? ' గం ' : 'h ') + L.pad(m % 60) + (S.lang === 'te' ? ' ని' : 'm'); }
function initial(n) {
  n = String(n || '').trim(); if (!n) return '?';
  try { if (window.Intl && Intl.Segmenter) return new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(n)[Symbol.iterator]().next().value.segment.toUpperCase(); } catch (e) { /* ignore */ }
  return Array.from(n)[0].toUpperCase();
}
const safePhoto = (p) => (typeof p === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p) ? p : '');
const nowText = () => TF.format(new Date());
const brName = (id) => L.branchOf(S.cfg, id).name;
const isAdmin = () => !!(S.me && S.me.role === 'admin' && S.me.status === 'active');
function errText(e) {
  if (e && e.ui) return e.ui;
  const c = e && (e.code || e.message);
  if (c === 'cam') return t('eCam');
  if (c === 'model') return t('eModel');
  if (c === 'noface') return t('eNoFace');
  if (e && e.geo === 1) return t('eDenied');
  if (e && e.geo) return t('eLocFail');
  if (c === 'permission-denied') return t('ePerm');
  return t('eSave');
}
function pill(c) { return c ? '<span class="pill p-' + c + '">' + esc(t('s' + c)) + '</span>' : ''; }
function chips(opts, cur, act) { return '<div class="chips">' + opts.map((o) => '<button type="button" class="chip" data-act="' + act + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (o[0] === cur) + '">' + esc(o[1]) + '</button>').join('') + '</div>'; }
const branchOpts = (all) => (all ? [['all', t('allBr')]] : []).concat(S.cfg.branches.map((b) => [b.id, b.name]));
const notice = (s) => '<div class="notice">' + esc(s) + '</div>';
const stat = (v, l) => '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>';
const field = (id, label, type, attrs, val) => '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" type="' + type + '" ' + (attrs || '') + ' value="' + esc(val == null ? '' : val) + '"></div>';
const logoutBtn = () => '<button class="btn sm" type="button" data-act="logout" style="align-self:flex-start">' + esc(t('logout')) + '</button>';
const connecting = () => '<section class="card"><p>' + esc(t('connecting')) + '</p></section>';

// ---------- data normalisers ----------
const tsMs = (x) => (x && x.ts && x.ts.toMillis ? x.ts.toMillis() : null);
function normRec(id, d) {
  return { id, date: d.date, uid: d.uid, name: d.name, branch: d.branch, inMs: tsMs(d.in), outMs: tsMs(d.out), inD: d.in && d.in.dist != null ? d.in.dist : null, outD: d.out && d.out.dist != null ? d.out.dist : null, status: d.status || null, note: d.note || '', src: d.src || '' };
}
function normUser(id, d) {
  const created = d.created && d.created.toMillis ? d.created.toMillis() : null;
  return { id, name: d.name || '', phone: d.phone || '', role: d.role || 'staff', status: d.status || 'pending', branch: d.branch || '', faceStatus: d.faceStatus || 'none', facePhoto: safePhoto(d.facePhoto), faceDesc: d.faceDesc || null, joined: created ? L.istDate(created) : '' };
}
const faceDescs = (m) => (m.faceDesc ? Object.keys(m.faceDesc).sort().map((k) => m.faceDesc[k]) : []);
const userById = (id) => S.users.find((u) => u.id === id) || (S.me && S.me.id === id ? S.me : null);
function getRecAny(date, uid) {
  const id = date + '_' + uid;
  return S.att.today[id] || S.att.view[id] || S.myAtt[id];
}

// ---------- views ----------
function viewAuth() {
  const reg = S.authMode === 'register';
  return '<section class="card auth"><div class="seg">' +
    ['login', 'register'].map((k) => '<button type="button" class="seg-b" data-act="authmode" data-v="' + k + '" aria-pressed="' + (S.authMode === k) + '">' + esc(t(k)) + '</button>').join('') + '</div>' +
    (reg ? field('a-name', t('name'), 'text', 'autocomplete="name" maxlength="60"') : '') +
    field('a-phone', t('phone'), 'tel', 'inputmode="numeric" maxlength="10" autocomplete="tel-national"') +
    field('a-pin', t('pin'), 'password', 'inputmode="numeric" maxlength="6" autocomplete="' + (reg ? 'new-password' : 'current-password') + '"') +
    '<p class="err" id="a-err" hidden></p><button class="btn btn-primary" type="button" data-act="authgo">' + esc(t(reg ? 'register' : 'login')) + '</button></section>';
}
function viewProfileMissing() {
  return '<section class="card"><h2>' + esc(t('profileMissing')) + '</h2>' + field('p-name', t('name'), 'text', 'maxlength="60"') + '<p class="err" id="p-err" hidden></p>' +
    '<button class="btn btn-primary" type="button" data-act="mkprofile">' + esc(t('save')) + '</button>' + logoutBtn() + '</section>';
}
function enrollCard() {
  return '<section class="card"><h2>' + esc(t('enrollTitle')) + '</h2><p class="muted">' + esc(t('enrollBody')) + '</p>' +
    '<label class="check"><input type="checkbox" id="consent"' + (S.consent ? ' checked' : '') + '> <span>' + esc(t('consent')) + '</span></label>' +
    '<p class="err" id="enroll-err" hidden></p><button class="btn btn-primary" type="button" data-act="enroll">' + esc(t('enrollBtn')) + '</button></section>';
}
function viewOnboard() {
  const m = S.me;
  if (m.status === 'inactive') return '<section class="card"><p>' + esc(t('inactiveMsg')) + '</p>' + logoutBtn() + '</section>';
  if (m.faceStatus !== 'enrolled') return enrollCard() + logoutBtn();
  return '<section class="card"><h2>' + esc(t('pendTitle')) + '</h2><p class="muted">' + esc(t('pendBody')) + '</p><p class="small muted">' + esc(m.name) + ' · ' + esc(m.phone) + '</p>' +
    '<p class="small muted">' + esc(t('acctId')) + ': <span class="mono">' + esc(S.uid) + '</span></p>' + logoutBtn() + '</section>';
}
function punchTarget() {
  const today = S.today, r = S.myAtt[today + '_' + S.uid];
  if (r && r.inMs && !r.outMs) return { kind: 'out', rec: r };
  if (r && r.outMs) return { kind: 'done', rec: r };
  const y = L.istDate(Date.now() - 86400000), ry = S.myAtt[y + '_' + S.uid];
  if (ry && ry.inMs && !ry.outMs && Date.now() - ry.inMs < 20 * 36e5) return { kind: 'out', rec: ry };
  return { kind: 'in', rec: r || null };
}
function viewMeTab() {
  const m = S.me;
  if (m.faceStatus !== 'enrolled') return enrollCard();
  if (!m.branch) return notice(t('noBranch'));
  const b = L.branchOf(S.cfg, m.branch), tg = punchTarget(), rec = tg.rec, date = rec ? rec.date : S.today;
  const st = L.dayStatus(rec, m, date, S.cfg, S.today);
  let line, btn;
  if (!rec || !rec.inMs) { line = esc(t('stNotIn')); btn = '<button class="btn btn-xl btn-primary" type="button" data-act="punch">' + esc(t('btnIn')) + '</button>'; }
  else if (!rec.outMs) { line = esc(t('stIn', { t: fmtTime(rec.inMs) })) + ' ' + pill(st.code); btn = '<button class="btn btn-xl btn-out" type="button" data-act="punch">' + esc(t('btnOut')) + '</button>'; }
  else { line = esc(t('stDone', { t: fmtTime(rec.outMs), h: st.hours != null ? hm(st.hours) : '—' })) + ' ' + pill(st.code); btn = '<button class="btn btn-xl" type="button" disabled>' + esc(t('btnDone')) + '</button>'; }
  const warn = b.lat == null ? notice(t('noLoc')) : '';
  return '<section class="card hero"><div class="hero-top"><div><p class="eyebrow">' + esc(fmtDate(S.today, { weekday: 'long', day: 'numeric', month: 'long' })) + '</p><h2>' + esc(t('hello', { n: m.name })) + '</h2>' +
    '<p class="muted small">' + esc(b.name) + ' · ' + esc(t('shift', { a: b.start, b: b.end })) + '</p></div><div class="clock" id="clock">' + esc(nowText()) + '</div></div>' +
    '<div class="stateline">' + line + '</div>' + warn + btn + '</section>';
}
function timesText(r) { return r && r.inMs ? esc(fmtTime(r.inMs)) + (r.outMs ? ' – ' + esc(fmtTime(r.outMs)) : '') : '—'; }
function viewHist() {
  const m = S.me, cur = S.today.slice(0, 7), days = L.monthDays(cur).filter((d) => d <= S.today);
  const get = (d) => S.myAtt[d + '_' + S.uid];
  const sum = L.summarize(m, days, get, S.cfg, S.today);
  return '<section class="card"><h2>' + esc(t('thisMonth')) + '</h2><div class="stats">' + stat(sum.n.P + sum.n.L, t('present')) + stat(sum.n.L, t('late')) + stat(sum.n.H, t('half')) + stat(sum.n.V, t('leave')) + stat(sum.n.A, t('absent')) + stat(sum.hours.toFixed(1), t('hours')) + '</div></section>' +
    '<section class="card"><h2>' + esc(t('recent')) + '</h2><div class="list">' + days.slice().reverse().slice(0, 14).map((d) => {
      const r = get(d), s = L.dayStatus(r, m, d, S.cfg, S.today);
      return '<div class="row"><span class="who"><b>' + esc(fmtDate(d)) + '</b>' + (s.noOut ? '<span class="flag">' + esc(t('noOut')) + '</span>' : '') + '</span><span class="times">' + timesText(r) + '</span>' + pill(s.code) + '</div>';
    }).join('') + '</div></section>' + logoutBtn();
}

// ----- admin: today -----
const activeUsers = () => S.users.filter((u) => u.status === 'active').sort((a, b) => (a.branch || '').localeCompare(b.branch || '') || a.name.localeCompare(b.name));
function viewToday() {
  if (!S.ready.users || !S.ready.today) return connecting();
  const list = activeUsers();
  if (!list.length) return '<section class="card empty"><h2>' + esc(t('empty')) + '</h2><p class="muted">' + esc(t('staffEmpty')) + '</p></section>';
  const rows = list.filter((u) => S.filter === 'all' || u.branch === S.filter).map((u) => { const rec = S.att.today[S.today + '_' + u.id]; return { u, rec, st: L.dayStatus(rec, u, S.today, S.cfg, S.today) }; });
  const c = { P: 0, L: 0, H: 0, N: 0, A: 0, V: 0 }; rows.forEach((r) => { if (c[r.st.code] != null) c[r.st.code]++; });
  let h = '<div class="controls">' + chips(branchOpts(true), S.filter, 'filter') + '<span class="muted small">' + esc(fmtDate(S.today, { weekday: 'long', day: 'numeric', month: 'long' })) + '</span></div>';
  if (S.cfg.weeklyOff.indexOf(L.weekday(S.today)) >= 0) h += notice(t('offToday'));
  h += '<div class="stats">' + stat(c.P + c.L + c.H, t('inCount')) + stat(c.L, t('late')) + stat(c.N + c.A, t('notIn')) + stat(c.V, t('leave')) + '</div>';
  S.cfg.branches.filter((b) => S.filter === 'all' || b.id === S.filter).forEach((b) => {
    const rs = rows.filter((r) => r.u.branch === b.id); if (!rs.length && S.filter === 'all') return;
    h += '<div class="list"><div class="list-h"><span>' + esc(b.name) + '</span><span class="muted small">' + esc(t('of', { a: rs.filter((r) => r.rec && r.rec.inMs).length, b: rs.length })) + '</span></div>' +
      (rs.length ? rs.map((r) => '<button type="button" class="row" data-act="day" data-uid="' + esc(r.u.id) + '" data-date="' + S.today + '"><span class="av">' + esc(initial(r.u.name)) + '</span><span class="who"><b>' + esc(r.u.name) + '</b>' + (r.rec && r.rec.inD != null ? '<small>' + esc(t('away', { d: r.rec.inD })) + '</small>' : '') + '</span><span class="times">' + timesText(r.rec) + '</span>' + pill(r.st.code) + '</button>').join('') : '<div class="row muted">' + esc(t('noneHere')) + '</div>') + '</div>';
  });
  const noBranch = list.filter((u) => !S.cfg.branches.some((b) => b.id === u.branch));
  if (noBranch.length && S.filter === 'all') h += '<div class="list"><div class="list-h"><span>—</span></div>' + noBranch.map((u) => '<button type="button" class="row" data-act="user" data-uid="' + esc(u.id) + '"><span class="av">' + esc(initial(u.name)) + '</span><span class="who"><b>' + esc(u.name) + '</b></span></button>').join('') + '</div>';
  return h;
}

// ----- admin: records -----
function recData() {
  const days = L.monthDays(S.viewMonth);
  const get = (u) => (d) => S.att.view[d + '_' + u.id];
  const list = S.users.filter((u) => {
    if (S.filter !== 'all' && u.branch !== S.filter) return false;
    return u.status === 'active' || days.some((d) => get(u)(d));
  }).sort((a, b) => (a.branch || '').localeCompare(b.branch || '') || a.name.localeCompare(b.name));
  return { days, list, sums: list.map((u) => L.summarize(u, days, get(u), S.cfg, S.today)) };
}
function viewRecords() {
  if (!S.ready.users || !S.ready.view) return connecting();
  const d = recData(), days = d.days, wo = (x) => S.cfg.weeklyOff.indexOf(L.weekday(x)) >= 0;
  let h = '<div class="controls"><div class="chips"><button class="chip" type="button" data-act="month" data-v="-1" aria-label="' + esc(t('prevM')) + '">‹</button><span class="chip" style="min-width:150px;text-align:center">' + esc(monthLabel(S.viewMonth)) + '</span><button class="chip" type="button" data-act="month" data-v="1" aria-label="' + esc(t('nextM')) + '">›</button></div>' +
    '<button class="btn sm" type="button" data-act="csv">' + esc(t('csv')) + '</button></div>' + chips(branchOpts(true), S.filter, 'filter');
  const th = '<tr><th class="nm">' + esc(t('employee')) + '</th>' + days.map((x) => {
    let w = ''; try { w = new Intl.DateTimeFormat(loc(), { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8)))); } catch (e) { /* ignore */ }
    return '<th class="' + (wo(x) ? 'wo' : '') + '">' + (+x.slice(8)) + '<br><span style="font-weight:400">' + esc(w) + '</span></th>';
  }).join('') + ['P', 'L', 'H', 'V', 'A'].map((k) => '<th class="sum">' + k + '</th>').join('') + '<th class="sum">' + esc(t('hours')) + '</th></tr>';
  const body = d.list.map((u, i) => {
    const s = d.sums[i];
    return '<tr><td class="nm">' + esc(u.name) + '</td>' + s.codes.map((c, j) => '<td class="' + (wo(days[j]) ? 'wo' : '') + '"><button type="button" class="cell c-' + c + '" data-act="day" data-uid="' + esc(u.id) + '" data-date="' + days[j] + '" aria-label="' + esc(u.name + ' ' + days[j]) + '">' + (c || '') + '</button></td>').join('') +
      '<td class="sum">' + (s.n.P + s.n.L) + '</td><td class="sum">' + s.n.L + '</td><td class="sum">' + s.n.H + '</td><td class="sum">' + s.n.V + '</td><td class="sum">' + s.n.A + '</td><td class="sum">' + s.hours.toFixed(1) + '</td></tr>';
  }).join('');
  h += '<div class="scroll"><table class="rec"><thead>' + th + '</thead><tbody>' + body + '</tbody></table></div>';
  h += '<div class="legend">' + ['P', 'L', 'H', 'V', 'A', 'W'].map((k) => '<span><i class="c-' + k + '">' + k + '</i>' + esc(t('s' + k)) + '</span>').join('') + '</div>';
  return h;
}

// ----- admin: staff -----
function statusPill(u) { return '<span class="pill p-' + (u.status === 'active' ? 'P' : u.status === 'pending' ? 'L' : 'A') + '">' + esc(t(u.status === 'active' ? 'active' : u.status === 'pending' ? 'pending' : 'off')) + '</span>'; }
function viewStaff() {
  if (!S.ready.users) return connecting();
  if (!S.users.length) return '<section class="card empty"><h2>' + esc(t('empty')) + '</h2><p class="muted">' + esc(t('staffEmpty')) + '</p></section>';
  const ord = { pending: 0, active: 1, inactive: 2 };
  const us = S.users.slice().sort((a, b) => (ord[a.status] - ord[b.status]) || a.name.localeCompare(b.name));
  return '<div class="list">' + us.map((u) => '<button type="button" class="row" data-act="user" data-uid="' + esc(u.id) + '">' +
    (u.facePhoto ? '<img class="av" src="' + u.facePhoto + '" alt="">' : '<span class="av">' + esc(initial(u.name)) + '</span>') +
    '<span class="who"><b>' + esc(u.name) + (u.role === 'admin' ? ' · ' + esc(t('admin')) : '') + '</b><small>' + esc(u.phone) + (u.branch ? ' · ' + esc(brName(u.branch)) : '') + '</small></span>' +
    '<span class="acts">' + statusPill(u) + '<span class="pill ' + (u.faceStatus === 'enrolled' ? 'p-P' : 'p-N') + '">' + esc(t(u.faceStatus === 'enrolled' ? 'faceOk' : 'faceNo')) + '</span></span></button>').join('') + '</div>';
}

// ----- admin: settings -----
function viewSettings() {
  const c = S.cfg, wd = [];
  for (let i = 0; i < 7; i++) { let n = String(i); try { n = new Intl.DateTimeFormat(loc(), { timeZone: 'UTC', weekday: 'short' }).format(new Date(Date.UTC(2024, 0, 7 + i))); } catch (e) { /* ignore */ } wd.push(n); }
  const thr = c.faceThreshold;
  return '<section class="card"><h2>' + esc(t('setTitle')) + '</h2>' + c.branches.map((b, i) =>
    '<div class="bset"><div class="field"><label for="s-n' + i + '">' + esc(t('branchName')) + '</label><input id="s-n' + i + '" value="' + esc(b.name) + '" maxlength="40"></div>' +
    '<div class="two">' + field('s-lat' + i, t('lat'), 'number', 'step="any"', b.lat) + field('s-lng' + i, t('lng'), 'number', 'step="any"', b.lng) + '</div>' +
    '<button class="btn sm" type="button" data-act="here" data-i="' + i + '" style="align-self:flex-start">' + esc(t('useHere')) + '</button>' +
    field('s-rad' + i, t('radius'), 'number', 'min="20" max="2000"', b.radius) +
    '<div class="two">' + field('s-s' + i, t('shiftStart'), 'time', '', b.start) + field('s-e' + i, t('shiftEnd'), 'time', '', b.end) + '</div></div>').join('') + '</section>' +
    '<section class="card"><h2>' + esc(t('rules')) + '</h2><div class="two">' + field('s-grace', t('grace'), 'number', 'min="0" max="120"', c.grace) + field('s-half', t('halfHours'), 'number', 'min="0" max="12" step="0.5"', c.halfHours) + '</div>' +
    '<div class="field"><label>' + esc(t('weeklyOff')) + '</label><div class="days">' + wd.map((n, i) => '<label><input type="checkbox" id="s-off' + i + '"' + (c.weeklyOff.indexOf(i) >= 0 ? ' checked' : '') + '>' + esc(n) + '</label>').join('') + '</div></div>' +
    '<div class="field"><label for="s-thr">' + esc(t('strict')) + '</label><select id="s-thr">' + [['0.4', 'strictHigh'], ['0.45', 'strictMid'], ['0.5', 'strictLow']].map((o) => '<option value="' + o[0] + '"' + (Math.abs(thr - +o[0]) < 0.01 ? ' selected' : '') + '>' + esc(t(o[1])) + '</option>').join('') + '</select></div>' +
    '<label class="check"><input type="checkbox" id="s-blink"' + (c.blink !== false ? ' checked' : '') + '> <span>' + esc(t('blinkReq')) + '</span></label></section>' +
    '<div class="actions"><button class="btn btn-primary" type="button" data-act="savecfg">' + esc(t('save')) + '</button></div><p class="muted small">' + esc(t('clockNote')) + '</p>' + logoutBtn();
}

// ---------- render ----------
function chrome() {
  $('#sub').textContent = t('appSub');
  $('#lang').textContent = S.lang === 'te' ? 'EN' : 'తె';
  const r = $('#role'); const m = S.me;
  if (m && m.status === 'active') { r.hidden = false; r.textContent = t(m.role === 'admin' ? 'admin' : 'staff'); } else r.hidden = true;
  const nav = $('#tabs');
  const tabs = m && m.status === 'active' ? (m.role === 'admin' ? [['today', 'tabToday'], ['records', 'tabRecords'], ['staff', 'tabStaff'], ['settings', 'tabSettings'], ['me', 'tabMe']] : [['me', 'tabMe'], ['hist', 'tabHist']]) : [];
  nav.hidden = !tabs.length;
  const sig = S.lang + '|' + S.tab + '|' + tabs.length;
  if (S.sig !== sig) {
    S.sig = sig;
    nav.innerHTML = tabs.map((x) => '<button type="button" class="tab" data-act="tab" data-v="' + x[0] + '"' + (S.tab === x[0] ? ' aria-current="page"' : '') + '>' + esc(t(x[1])) + '</button>').join('');
  }
}
function render(force) {
  if (force) S.drawn = null;
  chrome();
  const v = $('#view'); let h, key;
  if (!S.cfgOk) { key = 'setup'; h = notice(t('setupNeeded')); }
  else if (!S.authReady || S.registering) { key = 'wait'; h = connecting(); }
  else if (!S.uid) { key = 'auth'; h = viewAuth(); }
  else if (S.me === undefined) { key = 'wait'; h = connecting(); }
  else if (S.me === null) { key = 'profile'; h = viewProfileMissing(); }
  else if (S.me.status !== 'active' || (S.me.role !== 'admin' && S.me.faceStatus !== 'enrolled')) { key = 'onboard'; h = viewOnboard(); }
  else {
    const admin = S.me.role === 'admin', valid = admin ? ['today', 'records', 'staff', 'settings', 'me'] : ['me', 'hist'];
    if (valid.indexOf(S.tab) < 0) S.tab = valid[0];
    key = S.tab;
    h = ({ today: viewToday, records: viewRecords, staff: viewStaff, settings: viewSettings, me: viewMeTab, hist: viewHist })[S.tab]();
  }
  if ((key === 'auth' || key === 'settings' || key === 'profile') && S.drawn === key && v.contains(document.activeElement) && document.activeElement !== v) return;
  S.drawn = key;
  if (S.err) h = notice(t('eSave') + ' (' + S.err + ')') + h;
  v.innerHTML = h;
}

// ---------- toast and overlay ----------
let toastT;
function toast(m) { const el = $('#toast'); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 4500); }
const ov = {
  show() { $('#overlay').hidden = false; $('#ov-err').hidden = true; $('#cam').hidden = false; $('#ov-say').textContent = ''; $('#ov-close').textContent = t('cancel'); },
  say(s) { $('#ov-say').textContent = s; },
  err(s) { const e = $('#ov-err'); e.textContent = s; e.hidden = false; $('#cam').hidden = true; $('#ov-say').textContent = ''; $('#ov-close').textContent = t('close'); },
  hide() { $('#overlay').hidden = true; },
};
function sheet(title, body) {
  $('#sheetRoot').innerHTML = '<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-h"><h2>' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="' + esc(t('close')) + '">×</button></div>' + body + '<p class="err" id="sheet-err" hidden></p></div></div>';
  const f = $('#sheetRoot input,#sheetRoot select'); if (f) f.focus();
}
const closeSheet = () => { $('#sheetRoot').innerHTML = ''; };
function sheetErr(m) { const e = $('#sheet-err'); if (e) { e.textContent = m; e.hidden = false; } }
function showErr(id, m) { const e = $('#' + id); if (e) { e.textContent = m; e.hidden = false; } }

// ---------- camera / location flows ----------
function getPos() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej({ geo: 2 });
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), (e) => rej({ geo: e.code || 2 }), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
async function runCam(first, work) {
  if (S.busy) return null;
  S.busy = true; S.cancelled = false; ov.show();
  let stream = null;
  const chk = () => { if (S.cancelled) throw new Error('cancel'); };
  try {
    if (first) await first();
    chk(); ov.say(t('stepModel')); await F.loadModels();
    chk(); ov.say(t('stepCam')); const video = $('#cam'); stream = await F.startCamera(video); S.stream = stream; chk();
    return { r: await work(video) };
  } catch (e) {
    if (e && e.message === 'cancel') return null;
    ov.err(errText(e)); return null;
  } finally {
    F.stopCamera(stream); $('#cam').srcObject = null; S.stream = null; S.busy = false;
  }
}
const sayKey = (k) => t('say' + k.charAt(0).toUpperCase() + k.slice(1));
async function punch() {
  const m = S.me, b = L.branchOf(S.cfg, m.branch);
  if (!m.branch) return;
  if (b.lat == null) { toast(t('noLoc')); return; }
  S.today = L.todayIST();
  const tg = punchTarget(); if (tg.kind === 'done') return;
  let pos, g;
  const res = await runCam(async () => {
    ov.say(t('stepLoc')); pos = await getPos(); g = L.geoCheck(pos, b);
    if (g.reason === 'weak') throw { ui: t('eWeak', { a: Math.round(pos.acc) }) };
    if (!g.ok) throw { ui: t('eFar', { d: Math.round(g.d), b: b.name, r: b.radius }) };
  }, async (video) => {
    const r = await F.verify(video, faceDescs(m), S.cfg.faceThreshold, (k) => ov.say(sayKey(k)), S.cfg.blink !== false);
    if (!r.ok) throw { ui: t(r.reason === 'noblink' ? 'eNoBlink' : r.reason === 'noface' ? 'eNoFace' : 'eNoMatch') };
    return r;
  });
  if (!res) return;
  try {
    ov.say(t('sayChecking'));
    const p = { ts: serverTimestamp(), lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), acc: Math.round(pos.acc), dist: Math.round(g.d), fd: Math.round(res.r.score * 1000) / 1000 };
    if (tg.kind === 'in') await setDoc(doc(db, 'attendance', S.today + '_' + S.uid), { date: S.today, uid: S.uid, name: m.name, branch: m.branch, in: p, out: null, src: 'self' });
    else await updateDoc(doc(db, 'attendance', tg.rec.id), { out: p });
    ov.hide(); toast(tg.kind === 'in' ? t('okIn', { t: nowText(), d: Math.round(g.d) }) : t('okOut', { t: nowText() }));
  } catch (e) { ov.err(errText(e)); }
}
async function enrollFace() {
  if (!S.consent) { showErr('enroll-err', t('needConsent')); return; }
  const res = await runCam(null, async (video) => { ov.say(t('sayEnroll')); return F.enroll(video, (k) => ov.say(k === 'hold' ? t('sayHold') : t('sayNoface'))); });
  if (!res) return;
  try {
    ov.say(t('sayChecking'));
    const fd = {}; res.r.descs.forEach((d, i) => { fd['d' + i] = d.map((x) => Math.round(x * 1e5) / 1e5); });
    await updateDoc(doc(db, 'users', S.uid), { faceDesc: fd, facePhoto: res.r.photo, faceStatus: 'enrolled', faceAt: serverTimestamp(), consent: true });
    ov.hide(); toast(t('enrolledOk'));
  } catch (e) { ov.err(errText(e)); }
}

// ---------- auth ----------
const phoneNorm = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const emailOf = (p) => p + '@paisapulse.app';
function authErr(e) {
  const c = e && e.code;
  if (c === 'auth/email-already-in-use') return t('taken');
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-email') return t('wrongLogin');
  if (c === 'auth/too-many-requests') return t('tooMany');
  if (c === 'auth/network-request-failed') return t('netErr');
  if (c === 'auth/operation-not-allowed') return t('authOff');
  if (c === 'auth/weak-password') return t('badPin');
  return t('eSave');
}
async function authGo() {
  const reg = S.authMode === 'register', phone = phoneNorm($('#a-phone').value), pin = $('#a-pin').value.trim(), name = reg ? $('#a-name').value.trim() : '';
  if (reg && !name) return showErr('a-err', t('needName'));
  if (phone.length !== 10) return showErr('a-err', t('badPhone'));
  if (!/^\d{6}$/.test(pin)) return showErr('a-err', t('badPin'));
  try {
    if (reg) {
      S.registering = true; render(true);
      const cred = await createUserWithEmailAndPassword(auth, emailOf(phone), pin);
      await setDoc(doc(db, 'users', cred.user.uid), { name, phone, role: 'staff', status: 'pending', branch: '', faceStatus: 'none', created: serverTimestamp() });
      S.registering = false; render(true);
    } else await signInWithEmailAndPassword(auth, emailOf(phone), pin);
  } catch (e) { S.registering = false; render(true); showErr('a-err', authErr(e)); }
}
async function mkProfile() {
  const name = $('#p-name').value.trim(); if (!name) return showErr('p-err', t('needName'));
  try { await setDoc(doc(db, 'users', S.uid), { name, phone: phoneNorm((auth.currentUser.email || '').split('@')[0]), role: 'staff', status: 'pending', branch: '', faceStatus: 'none', created: serverTimestamp() }); } catch (e) { showErr('p-err', errText(e)); }
}

// ---------- admin sheets and writes ----------
function openUser(id) {
  const u = userById(id); if (!u) return;
  const self = id === S.uid;
  sheet(u.name, '<div class="who-big">' + (u.facePhoto ? '<img class="photo" src="' + u.facePhoto + '" alt="">' : '<span class="av big">' + esc(initial(u.name)) + '</span>') +
    '<div><div class="muted small mono">' + esc(u.phone) + '</div>' + statusPill(u) + '</div></div>' +
    field('u-name', t('name'), 'text', 'maxlength="60" autocomplete="off"', u.name) +
    '<div class="field"><label for="u-br">' + esc(t('branch')) + '</label><select id="u-br"><option value="">—</option>' + S.cfg.branches.map((b) => '<option value="' + esc(b.id) + '"' + (u.branch === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select></div>' +
    '<div class="actions">' +
    (u.status === 'pending' ? '<button class="btn btn-primary" type="button" data-act="u-save" data-uid="' + esc(id) + '" data-approve="1">' + esc(t('approve')) + '</button>' : '<button class="btn btn-primary" type="button" data-act="u-save" data-uid="' + esc(id) + '">' + esc(t('save')) + '</button>') + '</div>' +
    '<div class="actions">' +
    (u.status === 'active' && !self ? '<button class="btn danger" type="button" data-act="u-status" data-v="inactive" data-uid="' + esc(id) + '">' + esc(t('deactivate')) + '</button>' : '') +
    (u.status === 'inactive' ? '<button class="btn" type="button" data-act="u-status" data-v="active" data-uid="' + esc(id) + '">' + esc(t('reactivate')) + '</button>' : '') +
    (u.faceStatus === 'enrolled' ? '<button class="btn" type="button" data-act="u-face" data-confirm="1" data-uid="' + esc(id) + '">' + esc(t('resetFace')) + '</button>' : '') +
    (!self ? '<button class="btn" type="button" data-act="u-role" data-confirm="1" data-uid="' + esc(id) + '" data-v="' + (u.role === 'admin' ? 'staff' : 'admin') + '">' + esc(t(u.role === 'admin' ? 'removeAdmin' : 'makeAdmin')) + '</button>' : '') + '</div>');
}
async function userUpdate(id, data) { try { await updateDoc(doc(db, 'users', id), data); return true; } catch (e) { sheetErr(errText(e)); return false; } }
function openDay(uid, date) {
  const u = userById(uid); if (!u) return; const rec = getRecAny(date, uid) || {};
  sheet(t('editDay'), '<p class="muted">' + esc(u.name) + ' · ' + esc(fmtDate(date)) + '</p>' +
    '<div class="field"><label for="f-status">' + esc(t('status')) + '</label><select id="f-status"><option value="">' + esc(t('autoSt')) + '</option>' + [['leave', 'sV'], ['absent', 'sA'], ['half', 'sH']].map((o) => '<option value="' + o[0] + '"' + (rec.status === o[0] ? ' selected' : '') + '>' + esc(t(o[1])) + '</option>').join('') + '</select></div>' +
    '<div class="two">' + field('f-in', t('tIn'), 'time', '', rec.inMs ? L.istHHMM(rec.inMs) : '') + field('f-out', t('tOut'), 'time', '', rec.outMs ? L.istHHMM(rec.outMs) : '') + '</div>' +
    field('f-note', t('note'), 'text', 'maxlength="200"', rec.note || '') +
    '<div class="actions"><button class="btn danger" type="button" data-act="clearday" data-uid="' + esc(uid) + '" data-date="' + date + '">' + esc(t('clearDay')) + '</button><button class="btn btn-primary" type="button" data-act="saveday" data-uid="' + esc(uid) + '" data-date="' + date + '">' + esc(t('save')) + '</button></div>');
}
async function saveDay(uid, date) {
  const u = userById(uid), old = getRecAny(date, uid) || {}, st = $('#f-status').value, a = L.msAtIST(date, $('#f-in').value), b = L.msAtIST(date, $('#f-out').value), note = $('#f-note').value.trim();
  if (b && !a) return sheetErr(t('needIn'));
  if (a && b && b <= a) return sheetErr(t('outBefore'));
  try {
    const ref = doc(db, 'attendance', date + '_' + uid);
    if (!a && !b && !st && !note) await deleteDoc(ref);
    else await setDoc(ref, { date, uid, name: u.name, branch: old.branch || u.branch || '', in: a ? { ts: Timestamp.fromMillis(a), manual: true } : null, out: b ? { ts: Timestamp.fromMillis(b), manual: true } : null, status: st || null, note, src: 'admin' });
    closeSheet();
  } catch (e) { sheetErr(errText(e)); }
}
async function saveCfg() {
  const br = S.cfg.branches.map((b, i) => {
    const lat = parseFloat($('#s-lat' + i).value), lng = parseFloat($('#s-lng' + i).value), rad = parseFloat($('#s-rad' + i).value);
    return { id: b.id, name: ($('#s-n' + i).value.trim() || b.name).slice(0, 40), lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null, radius: isFinite(rad) && rad >= 20 ? rad : b.radius, start: $('#s-s' + i).value || b.start, end: $('#s-e' + i).value || b.end };
  });
  const off = []; for (let i = 0; i < 7; i++) if ($('#s-off' + i).checked) off.push(i);
  try {
    await setDoc(doc(db, 'config', 'main'), { branches: br, grace: Math.max(0, Math.min(120, parseInt($('#s-grace').value, 10) || 0)), halfHours: Math.max(0, Math.min(12, parseFloat($('#s-half').value) || 0)), weeklyOff: off, faceThreshold: parseFloat($('#s-thr').value) || 0.45, blink: $('#s-blink').checked });
    toast(t('saved'));
  } catch (e) { toast(errText(e)); }
}
function exportCsv() {
  const d = recData(), rows = [['Employee', 'Phone', 'Branch', 'Present', 'Late', 'Half', 'Leave', 'Absent', 'Hours'].concat(d.days.map((x) => +x.slice(8)))];
  d.list.forEach((u, i) => { const s = d.sums[i]; rows.push([u.name, u.phone, brName(u.branch), s.n.P + s.n.L, s.n.L, s.n.H, s.n.V, s.n.A, s.hours.toFixed(1)].concat(s.codes)); });
  const blob = new Blob(['﻿' + L.csv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'paisapulse-attendance-' + S.viewMonth + '.csv';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

// ---------- actions ----------
const A = {
  lang() { S.lang = S.lang === 'te' ? 'en' : 'te'; try { localStorage.setItem('pp-lang', S.lang); } catch (e) { /* ignore */ } closeSheet(); S.sig = ''; render(true); },
  tab(el) { S.tab = el.getAttribute('data-v'); S.sig = ''; render(true); },
  authmode(el) { S.authMode = el.getAttribute('data-v'); render(true); },
  authgo() { authGo(); },
  mkprofile() { mkProfile(); },
  logout() { S.authMode = 'login'; signOut(auth); },
  enroll() { enrollFace(); },
  punch() { punch(); },
  filter(el) { S.filter = el.getAttribute('data-v'); render(true); },
  month(el) { S.viewMonth = L.shiftMonth(S.viewMonth, +el.getAttribute('data-v')); S.ready.view = false; subView(); render(true); },
  csv() { exportCsv(); },
  day(el) { openDay(el.getAttribute('data-uid'), el.getAttribute('data-date')); },
  saveday(el) { saveDay(el.getAttribute('data-uid'), el.getAttribute('data-date')); },
  clearday(el) { deleteDoc(doc(db, 'attendance', el.getAttribute('data-date') + '_' + el.getAttribute('data-uid'))).then(closeSheet, (e) => sheetErr(errText(e))); },
  user(el) { openUser(el.getAttribute('data-uid')); },
  async 'u-save'(el) {
    const id = el.getAttribute('data-uid'), br = $('#u-br').value, ap = el.getAttribute('data-approve');
    const nm = $('#u-name').value.trim().slice(0, 60);
    if (!nm) return sheetErr(t('needName'));
    if (ap && !br) return sheetErr(t('pickBranch'));
    const ok = await userUpdate(id, ap ? { name: nm, branch: br, status: 'active' } : { name: nm, branch: br }); if (ok) closeSheet();
  },
  async 'u-status'(el) { if (await userUpdate(el.getAttribute('data-uid'), { status: el.getAttribute('data-v') })) closeSheet(); },
  async 'u-face'(el) { if (await userUpdate(el.getAttribute('data-uid'), { faceStatus: 'none', faceDesc: deleteField(), facePhoto: deleteField() })) closeSheet(); },
  async 'u-role'(el) { if (await userUpdate(el.getAttribute('data-uid'), { role: el.getAttribute('data-v') })) closeSheet(); },
  savecfg() { saveCfg(); },
  async here(el) {
    const i = el.getAttribute('data-i');
    try { const p = await getPos(); $('#s-lat' + i).value = p.lat.toFixed(6); $('#s-lng' + i).value = p.lng.toFixed(6); toast(t('gotLoc', { a: Math.round(p.acc) })); } catch (e) { toast(errText(e)); }
  },
  closesheet: closeSheet,
  scrim: closeSheet,
  ovclose() { S.cancelled = true; if (S.stream) F.stopCamera(S.stream); const c = $('#cam'); if (c) c.srcObject = null; ov.hide(); },
};
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const a = el.getAttribute('data-act');
  if (a === 'scrim' && ev.target !== el) return;
  if (el.getAttribute('data-confirm') && !el.getAttribute('data-armed')) { el.setAttribute('data-armed', '1'); el.textContent = t('tapAgain'); return; }
  const f = A[a]; if (f) f(el, ev);
});
document.addEventListener('change', (ev) => { if (ev.target && ev.target.id === 'consent') S.consent = ev.target.checked; });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });
setInterval(() => { const c = $('#clock'); if (c) c.textContent = nowText(); }, 1000);

// ---------- firebase wiring ----------
function sub(key, ref, apply) {
  if (S.unsub[key]) S.unsub[key]();
  S.unsub[key] = onSnapshot(ref, (s) => { try { apply(s); S.err = ''; } catch (e) { console.error(e); S.err = 'bug ' + e.message; } render(); },
    (e) => { S.err = e.code || 'error'; render(); });
}
function stopKeys(keys) { keys.forEach((k) => { if (S.unsub[k]) { S.unsub[k](); delete S.unsub[k]; } }); }
function unsubAll() { stopKeys(Object.keys(S.unsub)); S.ready = {}; }
const recsFrom = (q) => { const o = {}; q.docs.forEach((d) => { o[d.id] = normRec(d.id, d.data({ serverTimestamps: 'estimate' })); }); return o; };
function subToday() { sub('today', query(collection(db, 'attendance'), where('date', '==', S.today)), (q) => { S.att.today = recsFrom(q); S.ready.today = true; }); }
function subView() {
  const d = L.monthDays(S.viewMonth);
  sub('view', query(collection(db, 'attendance'), where('date', '>=', d[0]), where('date', '<=', d[d.length - 1])), (q) => { S.att.view = recsFrom(q); S.ready.view = true; });
}
function afterMe() {
  const m = S.me;
  if (!m || m.status !== 'active') { stopKeys(['myAtt', 'users', 'today', 'view']); return; }
  if (!S.tab) S.tab = m.role === 'admin' ? 'today' : 'me';
  if (!S.unsub.myAtt) sub('myAtt', query(collection(db, 'attendance'), where('uid', '==', S.uid)), (q) => { S.myAtt = recsFrom(q); S.ready.myAtt = true; });
  if (m.role === 'admin') {
    if (!S.unsub.users) sub('users', collection(db, 'users'), (q) => { S.users = q.docs.map((d) => normUser(d.id, d.data({ serverTimestamps: 'estimate' }))); S.ready.users = true; });
    if (!S.unsub.today) subToday();
    if (!S.unsub.view) subView();
  } else stopKeys(['users', 'today', 'view']);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !db || !S.uid) return;
  const n = L.todayIST(); if (n === S.today) return;
  S.today = n; if (S.unsub.today) subToday(); render();
});

function boot() {
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!S.cfgOk) return;
  const app = initializeApp(FC);
  auth = getAuth(app);
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true, ignoreUndefinedProperties: true });
  onAuthStateChanged(auth, (u) => {
    S.authReady = true; unsubAll(); S.tab = null; S.sig = '';
    if (!u) { S.uid = null; S.me = undefined; S.users = []; S.att = { today: {}, view: {} }; S.myAtt = {}; render(true); return; }
    S.uid = u.uid; S.me = undefined; render(true);
    sub('cfg', doc(db, 'config', 'main'), (s) => { S.cfg = L.cfg(s.exists() ? s.data() : null); });
    sub('me', doc(db, 'users', u.uid), (s) => { S.me = s.exists() ? normUser(s.id, s.data({ serverTimestamps: 'estimate' })) : null; afterMe(); });
  });
}
boot();
