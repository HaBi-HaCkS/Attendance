// Browser-only face helpers: camera, face-api models, enrolment and live check (blink + match).
import { earAvg, makeBlinkDetector, matchScore, faceDist } from './lib.js';

let ready = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.faceapi) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('model'));
    document.head.appendChild(s);
  });
}

export function loadModels() {
  if (ready) return ready;
  ready = (async () => {
    await loadScript('vendor/face-api.js');
    const fa = window.faceapi;
    try { await fa.tf.setBackend('webgl'); } catch (e) { try { await fa.tf.setBackend('cpu'); } catch (e2) { /* keep default */ } }
    await fa.tf.ready();
    await fa.nets.tinyFaceDetector.loadFromUri('vendor/models');
    await fa.nets.faceLandmark68Net.loadFromUri('vendor/models');
    await fa.nets.faceRecognitionNet.loadFromUri('vendor/models');
  })().catch((e) => { ready = null; throw new Error('model'); });
  return ready;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('cam');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (e) { throw new Error('cam'); }
  video.srcObject = stream;
  await video.play().catch(() => {});
  for (let i = 0; i < 50 && !video.videoWidth; i++) await sleep(60);
  return stream;
}
export function stopCamera(stream) { if (stream) stream.getTracks().forEach((t) => t.stop()); }

const opts = () => new window.faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
const bigEnough = (det, video) => det.detection.box.width / (video.videoWidth || 1) >= 0.22;

function detect(video) { return window.faceapi.detectSingleFace(video, opts()).withFaceLandmarks(); }
function describe(video) { return window.faceapi.detectSingleFace(video, opts()).withFaceLandmarks().withFaceDescriptor(); }

function thumb(video, box) {
  const m = 0.3, side = Math.max(box.width, box.height) * (1 + m);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const sx = Math.max(0, cx - side / 2), sy = Math.max(0, cy - side / 2);
  const sw = Math.min(side, video.videoWidth - sx), sh = Math.min(side, video.videoHeight - sy);
  const c = document.createElement('canvas'); c.width = 160; c.height = 160;
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, 160, 160);
  return c.toDataURL('image/jpeg', 0.7);
}

// Take 3 descriptors of the same person, ~0.7 s apart, plus one small photo.
export async function enroll(video, say) {
  const descs = []; let photo = null; const t0 = Date.now(); let last = 0;
  while (descs.length < 3 && Date.now() - t0 < 30000) {
    if (!video.srcObject) throw new Error('cancel');
    const r = await describe(video);
    if (!r || !bigEnough(r, video)) { say('noface'); await sleep(100); continue; }
    if (Date.now() - last < 700) { await sleep(60); continue; }
    const d = Array.from(r.descriptor);
    if (descs.length && faceDist(descs[0], d) > 0.45) { say('noface'); continue; } // different face or bad frame
    descs.push(d); last = Date.now(); say('hold');
    if (!photo) photo = thumb(video, r.detection.box);
  }
  if (descs.length < 3) throw new Error('noface');
  return { descs, photo };
}

// Live check: wait for a blink (eyes open -> closed -> open), then compare 3 frames with the enrolled face.
export async function verify(video, stored, thr, say, needBlink) {
  const bd = makeBlinkDetector(); const t0 = Date.now(); let blinked = !needBlink; // admin can switch the blink check off in Settings
  if (needBlink) say('blink');
  while (!blinked && Date.now() - t0 < 20000) {
    if (!video.srcObject) throw new Error('cancel');
    const d = await detect(video);
    if (!d || !bigEnough(d, video)) { say('noface'); await sleep(80); continue; }
    say('blink');
    if (bd.feed(earAvg(d.landmarks.positions))) blinked = true;
  }
  if (!blinked) return { ok: false, reason: 'noblink' };
  say('hold');
  const live = []; let tries = 0;
  while (live.length < 3 && tries < 14) {
    if (!video.srcObject) throw new Error('cancel');
    tries++;
    const r = await describe(video);
    if (r && bigEnough(r, video)) live.push(Array.from(r.descriptor));
    await sleep(120);
  }
  if (live.length < 2) return { ok: false, reason: 'noface' };
  const score = matchScore(stored, live);
  return score <= thr ? { ok: true, score } : { ok: false, reason: 'nomatch', score };
}
