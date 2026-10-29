// Pure logic: dates (India time), distance, attendance status, face matching, blink detection, CSV.
// No DOM and no Firebase here, so it can be tested in Node.

export const IST = 19800000; // UTC+05:30 in ms

export function pad(n) { return n < 10 ? '0' + n : '' + n; }
export function istDate(ms) {
  const d = new Date(ms + IST);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
export function todayIST() { return istDate(Date.now()); }
export function weekday(date) { const p = date.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }
export function istMins(ms) { return Math.floor((((ms + IST) % 86400000) + 86400000) % 86400000 / 60000); }
export function istHHMM(ms) { const m = istMins(ms); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
export function msAtIST(date, hm) {
  if (!date || !hm) return null;
  const p = date.split('-'), t = hm.split(':');
  return Date.UTC(+p[0], +p[1] - 1, +p[2], +t[0], +t[1], 0) - IST;
}
export function monthDays(m) {
  const p = m.split('-'), n = new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate(), o = [];
  for (let i = 1; i <= n; i++) o.push(m + '-' + pad(i));
  return o;
}
export function shiftMonth(m, k) {
  const p = m.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1 + k, 1));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
}
export function mins(hm) { const p = (hm || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }

// ---- settings -------------------------------------------------------------
const DEF = {
  branches: [
    { id: 'b1', name: 'Branch 1', lat: null, lng: null, radius: 100, start: '09:30', end: '18:30' },
    { id: 'b2', name: 'Branch 2', lat: null, lng: null, radius: 100, start: '09:30', end: '18:30' },
  ],
  grace: 10, halfHours: 4, weeklyOff: [0], faceThreshold: 0.45, blink: true,
};
export function cfg(raw) {
  const c = JSON.parse(JSON.stringify(DEF));
  if (!raw) return c;
  if (Array.isArray(raw.branches) && raw.branches.length) {
    c.branches = raw.branches.map((b, i) => {
      const d = DEF.branches[i] || DEF.branches[0];
      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
      return {
        id: String(b.id || 'b' + (i + 1)), name: String(b.name || d.name), lat: num(b.lat), lng: num(b.lng),
        radius: typeof b.radius === 'number' && b.radius > 0 ? b.radius : d.radius, start: b.start || d.start, end: b.end || d.end,
      };
    });
  }
  if (typeof raw.grace === 'number') c.grace = raw.grace;
  if (typeof raw.halfHours === 'number') c.halfHours = raw.halfHours;
  if (Array.isArray(raw.weeklyOff)) c.weeklyOff = raw.weeklyOff.filter((n) => n >= 0 && n <= 6);
  if (typeof raw.faceThreshold === 'number' && raw.faceThreshold > 0.2 && raw.faceThreshold < 0.8) c.faceThreshold = raw.faceThreshold;
  if (typeof raw.blink === 'boolean') c.blink = raw.blink;
  return c;
}
export function branchOf(c, id) {
  for (let i = 0; i < c.branches.length; i++) if (c.branches[i].id === id) return c.branches[i];
  return c.branches[0];
}

// ---- location -------------------------------------------------------------
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// pos: {lat,lng,acc}; b: branch. reason: '' | 'noloc' | 'weak' | 'far'
export function geoCheck(pos, b) {
  if (!b || b.lat == null || b.lng == null) return { ok: false, d: null, reason: 'noloc' };
  const d = haversine(pos.lat, pos.lng, b.lat, b.lng);
  if (!(pos.acc <= 150)) return { ok: false, d, reason: 'weak' };
  return d <= b.radius ? { ok: true, d, reason: '' } : { ok: false, d, reason: 'far' };
}

// ---- attendance status ----------------------------------------------------
// rec: {inMs,outMs,status,branch}; user: {branch,joined}
export function dayStatus(rec, user, date, c, today) {
  const r = { code: '', hours: null, noOut: false };
  if (!rec && user && user.joined && date < user.joined) return r;
  if (rec && rec.inMs && rec.outMs) { const h = (rec.outMs - rec.inMs) / 36e5; if (h >= 0) r.hours = h; }
  if (rec && rec.status) { const m = { leave: 'V', absent: 'A', half: 'H' }[rec.status]; if (m) { r.code = m; return r; } }
  if (rec && rec.inMs) {
    const b = branchOf(c, rec.branch || (user && user.branch));
    const late = istMins(rec.inMs) > mins(b.start) + c.grace;
    if (!rec.outMs && date < today) r.noOut = true;
    if (r.hours != null && r.hours < c.halfHours) { r.code = 'H'; return r; }
    r.code = late ? 'L' : 'P';
    return r;
  }
  if (c.weeklyOff.indexOf(weekday(date)) >= 0) { r.code = 'W'; return r; }
  if (date > today) return r;
  r.code = date === today ? 'N' : 'A';
  return r;
}
export function summarize(user, days, getRec, c, today) {
  const codes = [], n = { P: 0, L: 0, H: 0, V: 0, A: 0, W: 0, N: 0 };
  let hrs = 0, noOut = 0;
  days.forEach((d) => {
    const s = dayStatus(getRec(d), user, d, c, today);
    codes.push(s.code); if (s.code) n[s.code]++; if (s.hours) hrs += s.hours; if (s.noOut) noOut++;
  });
  return { codes, n, hours: hrs, noOut };
}
export function csv(rows) {
  return rows.map((r) => r.map((f) => {
    let s = String(f == null ? '' : f);
    if (/^[=+@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

// ---- face matching --------------------------------------------------------
export function faceDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
export function median(xs) {
  const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// stored: array of descriptors (enrolled), live: array of descriptors (just captured).
// Score = median over live frames of the closest enrolled descriptor. Lower is better.
export function matchScore(stored, live) {
  if (!stored.length || !live.length) return Infinity;
  return median(live.map((l) => Math.min.apply(null, stored.map((s) => faceDist(s, l)))));
}

// ---- blink detection (liveness) -------------------------------------------
function pd(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
function eyeEar(p) { const h = pd(p[0], p[3]); return h ? (pd(p[1], p[5]) + pd(p[2], p[4])) / (2 * h) : 0; }
// pts: 68 landmark points [{x,y}]
export function earAvg(pts) { return (eyeEar(pts.slice(36, 42)) + eyeEar(pts.slice(42, 48))) / 2; }
// Feed one eye-aspect-ratio value per frame. Returns true once: eyes open -> closed -> open.
export function makeBlinkDetector() {
  const calib = []; let base = 0, state = 'calib';
  return {
    feed(e) {
      if (state === 'calib') {
        calib.push(e);
        if (calib.length >= 6) { const s = calib.slice().sort((a, b) => b - a); base = s[1]; state = 'open'; }
        return false;
      }
      if (state === 'open') { if (e < base * 0.78) state = 'closed'; return false; }
      return e > base * 0.9;
    },
    get base() { return base; },
  };
}
