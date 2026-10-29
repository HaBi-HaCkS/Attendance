import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/lib.js';

test('IST date/time helpers', () => {
  const ms = Date.UTC(2026, 9, 29, 20, 0, 0); // 20:00 UTC = 01:30 IST next day
  assert.equal(L.istDate(ms), '2026-10-30');
  assert.equal(L.istHHMM(ms), '01:30');
  assert.equal(L.msAtIST('2026-10-30', '01:30'), ms);
  assert.equal(L.weekday('2026-10-29'), 4);
  assert.equal(L.monthDays('2026-02').length, 28);
  assert.equal(L.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(L.shiftMonth('2026-12', 1), '2027-01');
});

test('haversine ~ known distance', () => {
  const d = L.haversine(14.6819, 77.6006, 14.6819, 77.6016); // ~0.001 deg lng at lat 14.68 ≈ 107.7 m
  assert.ok(d > 105 && d < 110, 'got ' + d);
  assert.equal(L.haversine(10, 10, 10, 10), 0);
});

test('geoCheck: inside, outside, weak GPS, no location set', () => {
  const b = { lat: 14.6819, lng: 77.6006, radius: 100 };
  assert.deepEqual(L.geoCheck({ lat: 14.6819, lng: 77.6010, acc: 20 }, b).ok, true);
  assert.equal(L.geoCheck({ lat: 14.6819, lng: 77.6030, acc: 20 }, b).reason, 'far');
  assert.equal(L.geoCheck({ lat: 14.6819, lng: 77.6006, acc: 400 }, b).reason, 'weak');
  assert.equal(L.geoCheck({ lat: 14.6819, lng: 77.6006, acc: NaN }, b).reason, 'weak');
  assert.equal(L.geoCheck({ lat: 1, lng: 1, acc: 5 }, { lat: null, lng: null, radius: 100 }).reason, 'noloc');
});

test('cfg defaults and sanitising', () => {
  const c = L.cfg(null);
  assert.equal(c.branches.length, 2);
  assert.equal(c.blink, true);
  assert.equal(L.cfg({ blink: false }).blink, false);
  assert.equal(L.cfg({ blink: 'no' }).blink, true);
  const c2 = L.cfg({ branches: [{ id: 'x', name: 'HQ', lat: '1', lng: 2, radius: -5 }], faceThreshold: 5, weeklyOff: [0, 9] });
  assert.equal(c2.branches[0].lat, null);
  assert.equal(c2.branches[0].lng, 2);
  assert.equal(c2.branches[0].radius, 100);
  assert.equal(c2.faceThreshold, 0.45);
  assert.deepEqual(c2.weeklyOff, [0]);
  assert.equal(L.branchOf(c2, 'nope').id, 'x');
});

const c = L.cfg(null);
const mk = (date, hm) => L.msAtIST(date, hm);
test('dayStatus: present / late / half / absent / off / today', () => {
  const today = '2026-10-29';
  const d = '2026-10-28'; // Wednesday
  assert.equal(L.dayStatus({ inMs: mk(d, '09:35'), outMs: mk(d, '18:40'), branch: 'b1' }, { branch: 'b1' }, d, c, today).code, 'P');
  assert.equal(L.dayStatus({ inMs: mk(d, '09:45'), outMs: mk(d, '18:40'), branch: 'b1' }, { branch: 'b1' }, d, c, today).code, 'L');
  assert.equal(L.dayStatus({ inMs: mk(d, '09:30'), outMs: mk(d, '12:30'), branch: 'b1' }, { branch: 'b1' }, d, c, today).code, 'H');
  const noOut = L.dayStatus({ inMs: mk(d, '09:30'), branch: 'b1' }, { branch: 'b1' }, d, c, today);
  assert.equal(noOut.code, 'P'); assert.equal(noOut.noOut, true);
  assert.equal(L.dayStatus(null, { branch: 'b1' }, d, c, today).code, 'A');
  assert.equal(L.dayStatus(null, { branch: 'b1' }, '2026-10-25', c, today).code, 'W'); // Sunday
  assert.equal(L.dayStatus(null, { branch: 'b1' }, today, c, today).code, 'N');
  assert.equal(L.dayStatus(null, { branch: 'b1' }, '2026-10-30', c, today).code, '');
  assert.equal(L.dayStatus({ status: 'leave' }, { branch: 'b1' }, d, c, today).code, 'V');
  assert.equal(L.dayStatus(null, { branch: 'b1', joined: '2026-10-28' }, '2026-10-20', c, today).code, '');
});

test('summarize counts', () => {
  const today = '2026-10-29';
  const days = ['2026-10-26', '2026-10-27', '2026-10-28'];
  const recs = { '2026-10-26': { inMs: mk('2026-10-26', '09:30'), outMs: mk('2026-10-26', '18:30'), branch: 'b1' } };
  const s = L.summarize({ branch: 'b1' }, days, (d) => recs[d], c, today);
  assert.equal(s.n.P, 1); assert.equal(s.n.A, 2); assert.ok(Math.abs(s.hours - 9) < 1e-9);
});

test('csv escaping and formula-injection guard', () => {
  assert.equal(L.csv([['a', 'b,c', 'd"e'], [1, null, '=SUM(A1)']]), 'a,"b,c","d""e"\r\n1,,\'=SUM(A1)');
});

test('face matching', () => {
  const v = (x) => Array.from({ length: 128 }, (_, i) => (i === 0 ? x : 0));
  assert.equal(L.faceDist(v(0), v(0.3)), 0.3);
  assert.ok(Math.abs(L.matchScore([v(0), v(1)], [v(0.1), v(0.12), v(0.9)]) - 0.1) < 1e-9); // 0.9 is 0.1 from the 2nd enrolled vector
  assert.ok(L.matchScore([v(0)], [v(0.8), v(0.9), v(0.85)]) > 0.5); // a different person must exceed the threshold
  assert.equal(L.matchScore([], [v(0)]), Infinity);
  assert.equal(L.median([3, 1, 2]), 2); assert.equal(L.median([1, 2, 3, 4]), 2.5);
});

test('blink detector: needs open -> closed -> open', () => {
  const b = L.makeBlinkDetector();
  const seq = [0.30, 0.31, 0.29, 0.30, 0.30, 0.31];
  seq.forEach((e) => assert.equal(b.feed(e), false));
  assert.equal(b.feed(0.30), false);
  assert.equal(b.feed(0.12), false); // closed
  assert.equal(b.feed(0.30), true);  // reopened => blink
  const b2 = L.makeBlinkDetector();
  seq.concat([0.3, 0.3, 0.29, 0.31, 0.3]).forEach((e) => assert.equal(b2.feed(e), false)); // photo: never blinks
});

test('earAvg on synthetic landmarks', () => {
  const pts = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  const eye = (o, h) => { // 6 points: corners 0 and 3, lids 1,2 top and 5,4 bottom
    pts[o] = { x: 0, y: 0 }; pts[o + 3] = { x: 30, y: 0 };
    pts[o + 1] = { x: 10, y: -h }; pts[o + 2] = { x: 20, y: -h };
    pts[o + 5] = { x: 10, y: h }; pts[o + 4] = { x: 20, y: h };
  };
  eye(36, 5); eye(42, 5);
  assert.ok(Math.abs(L.earAvg(pts) - (10 + 10) / (2 * 30)) < 1e-9);
});
