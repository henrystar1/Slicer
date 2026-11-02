import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const PROFILES = {
  ender3v3se: { name: 'Creality Ender 3 V3 SE', bedX: 220, bedY: 220, maxZ: 250, filamentDiameter: 1.75 }
};
const DEFAULT_START =
`M140 S[first_bed_temp]
M104 S[first_nozzle_temp]
G28 ; Homing
; BED_MESH_CALIBRATE ; <- bei Bedarf einkommentieren
M190 S[first_bed_temp]
M109 S[first_nozzle_temp]
G90
M83
G92 E0
; Purge-Linie
G1 X8 Y20 Z0.3 F5000
G1 X8 Y180 Z0.3 E6 F1500
G1 X8.6 Y180 Z0.3 F5000
G1 X8.6 Y20 Z0.3 E6 F1500
G1 Z2 F600
`;
const DEFAULT_END =
`M83
G1 E-2 F2400
G91
G1 Z10 F600
G90
G1 X10 Y[bed_y] F6000
M104 S0
M140 S0
M107
M84
`;

// ------------------------------------------------------------ Einstellungen
const NUM = ['wallCount','topLayers','bottomLayers','infillDensity','brimWidth','firstNozzleTemp','nozzleTemp','firstBedTemp','bedTemp',
  'fanSpeed','fanStartLayer','speedFirstLayer','speedOuterWall','speedInnerWall','speedInfill','speedSolid','speedTravel',
  'retractLength','retractSpeed','zHop','flow'];
const SEL = ['layerHeight','infillPattern','adhesion','profile'];
const TXT = ['host','apikey','startGcode','endGcode'];
const STORE = 'enderSlicer.v1';

function safeGet() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; } }
function safeSet(o) { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) {} }

function loadSettings() {
  const s = safeGet();
  for (const id of [...NUM, ...SEL, ...TXT]) if (s[id] !== undefined && $(id)) $(id).value = s[id];
  $('startPrint').checked = !!s.startPrint;
  if (!$('startGcode').value) $('startGcode').value = DEFAULT_START;
  if (!$('endGcode').value) $('endGcode').value = DEFAULT_END;
}
function saveSettings() {
  const s = {};
  for (const id of [...NUM, ...SEL, ...TXT]) s[id] = $(id).value;
  s.startPrint = $('startPrint').checked;
  safeSet(s);
}
function readSettings() {
  const p = PROFILES[$('profile').value];
  const s = { bedX: p.bedX, bedY: p.bedY, maxZ: p.maxZ, filamentDiameter: p.filamentDiameter };
  for (const id of NUM) { const v = parseFloat($(id).value); if (!isNaN(v)) s[id] = v; }
  s.layerHeight = parseFloat($('layerHeight').value);
  s.firstLayerHeight = s.layerHeight;
  s.infillPattern = $('infillPattern').value;
  s.adhesion = $('adhesion').value;
  s.startGcode = $('startGcode').value;
  s.endGcode = $('endGcode').value;
  return s;
}
loadSettings();
document.querySelectorAll('#panel input, #panel select, #panel textarea').forEach((el) => el.addEventListener('change', saveSettings));
$('btnDefaultGcode').onclick = () => { $('startGcode').value = DEFAULT_START; $('endGcode').value = DEFAULT_END; saveSettings(); toast('Standard-G-Code wiederhergestellt', 'ok'); };

// ------------------------------------------------------------ Toast / Overlay
let toastTimer;
function toast(msg, kind, ms) {
  const t = $('toast'); t.textContent = msg; t.className = kind || ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms || 5000);
}
function overlay(show, text, p) {
  $('overlay').hidden = !show;
  if (text) $('overlayText').textContent = text;
  if (p !== undefined) $('barFill').style.width = Math.round(p * 100) + '%';
}

// ------------------------------------------------------------ 3D-Ansicht
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.position.set(260, 240, 330);
const controls = new OrbitControls(camera, canvas);
controls.target.set(110, 20, -110);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 1.1));
const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(200, 400, 150); scene.add(dl);

// Koordinaten: G-Code (x,y,z) -> three (x, z, -y)
const bed = new THREE.Group(); scene.add(bed);
function buildBed() {
  bed.clear();
  const p = PROFILES[$('profile').value];
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(p.bedX, p.bedY), new THREE.MeshBasicMaterial({ color: 0x23304d }));
  plane.rotation.x = -Math.PI / 2; plane.position.set(p.bedX / 2, -0.05, -p.bedY / 2); bed.add(plane);
  const grid = new THREE.GridHelper(p.bedX, p.bedX / 10, 0x4b5f8c, 0x34446a);
  grid.position.set(p.bedX / 2, 0, -p.bedY / 2); bed.add(grid);
  const h = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(p.bedX, p.maxZ, p.bedY)),
    new THREE.LineBasicMaterial({ color: 0x3b4d78, transparent: true, opacity: 0.45 }));
  h.position.set(p.bedX / 2, p.maxZ / 2, -p.bedY / 2); bed.add(h);
}
buildBed();

let modelMesh = null, previewLines = null;
function resize() {
  const r = $('viewer').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); new ResizeObserver(resize).observe($('viewer')); resize();
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

function showMesh(tris) {
  if (modelMesh) { scene.remove(modelMesh); modelMesh.geometry.dispose(); modelMesh = null; }
  const n = tris.length / 3, pos = new Float32Array(tris.length);
  for (let i = 0; i < n; i++) { pos[i * 3] = tris[i * 3]; pos[i * 3 + 1] = tris[i * 3 + 2]; pos[i * 3 + 2] = -tris[i * 3 + 1]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.computeVertexNormals();
  modelMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xff9a2e, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
  scene.add(modelMesh);
}

const TYPE_COLORS = [0x7fb2ff, 0xff7a2e, 0xffd24a, 0xd9534f, 0x6dde8a];
function showPreview(pv) {
  if (previewLines) { scene.remove(previewLines); previewLines.geometry.dispose(); previewLines = null; }
  const nSeg = pv.types.length, pos = new Float32Array(nSeg * 6), col = new Float32Array(nSeg * 6);
  const c = new THREE.Color();
  for (let i = 0; i < nSeg; i++) {
    for (let k = 0; k < 2; k++) {
      const s = i * 6 + k * 3, src = i * 6 + k * 3;
      pos[s] = pv.pos[src]; pos[s + 1] = pv.pos[src + 2]; pos[s + 2] = -pv.pos[src + 1];
      c.setHex(TYPE_COLORS[pv.types[i]]);
      col[s] = c.r; col[s + 1] = c.g; col[s + 2] = c.b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  previewLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
  previewLines.frustumCulled = false;
  scene.add(previewLines);
  const nL = pv.layerEnds.length;
  $('layerSlider').min = 1; $('layerSlider').max = nL; $('layerSlider').value = nL;
  state.layerEnds = pv.layerEnds; state.layerZ = pv.layerZ;
  setLayer(nL);
}
function setLayer(l) {
  if (!previewLines) return;
  const end = state.layerEnds[l - 1];
  previewLines.geometry.setDrawRange(0, end * 2);
  $('layerLabel').textContent = l + ' / ' + state.layerEnds.length + '\n' + state.layerZ[l - 1].toFixed(2) + ' mm';
  $('layerLabel').style.whiteSpace = 'pre'; $('layerLabel').style.textAlign = 'center';
}
$('layerSlider').addEventListener('input', (e) => setLayer(+e.target.value));

function setView(mode) {
  const pv = mode === 'preview';
  $('tabModel').classList.toggle('on', !pv); $('tabPreview').classList.toggle('on', pv);
  if (modelMesh) modelMesh.visible = !pv;
  if (previewLines) previewLines.visible = pv;
  $('layerBox').hidden = !pv || !previewLines;
}
$('tabModel').onclick = () => setView('model');
$('tabPreview').onclick = () => setView('preview');

// ------------------------------------------------------------ Modell
const state = { raw: null, name: '', placed: null, size: [0, 0, 0], rot: { rx: 0, ry: 0, rz: 0 }, gcode: null, layerEnds: null, layerZ: null };
const Loader = window.Loader;

async function handleFile(file) {
  if (!file) return;
  try {
    overlay(true, 'Lade ' + file.name + ' …', 0.1);
    const buf = await file.arrayBuffer();
    const tris = await Loader.loadModel(file.name, buf);
    state.raw = tris; state.name = file.name.replace(/\.[^.]+$/, '');
    state.rot = { rx: 0, ry: 0, rz: 0 }; $('scale').value = 100; $('rz').value = 0;
    state.gcode = null; $('result').hidden = true; $('tabPreview').disabled = true;
    if (previewLines) { scene.remove(previewLines); previewLines = null; }
    rebuildModel(true);
    $('drop').classList.add('hide'); $('btnSlice').disabled = false; setView('model');
  } catch (e) { toast('Fehler: ' + e.message, 'err', 8000); }
  finally { overlay(false); }
}
$('file').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
['dragover', 'drop'].forEach((ev) => $('viewer').addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop') handleFile(e.dataTransfer.files[0]); }));

function rebuildModel(fit) {
  if (!state.raw) return;
  const sc = (parseFloat($('scale').value) || 100) / 100;
  const rz = (state.rot.rz + (parseFloat($('rz').value) || 0));
  const t = Loader.transform(state.raw, { sx: sc, sy: sc, sz: sc, rx: state.rot.rx, ry: state.rot.ry, rz });
  const p = PROFILES[$('profile').value];
  const placed = Loader.placeOnBed(t, p.bedX, p.bedY);
  state.placed = placed.tris; state.size = placed.size;
  showMesh(state.placed);
  const [x, y, z] = placed.size;
  const fits = x <= p.bedX && y <= p.bedY && z <= p.maxZ;
  $('modelInfo').innerHTML = `<b>${state.name}</b><br>${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm · ${(state.raw.length / 9).toLocaleString('de')} Dreiecke` +
    (fits ? '' : '<br><span style="color:var(--bad)">⚠ passt nicht auf das Druckbett</span>');
  if (fit) { controls.target.set(p.bedX / 2, z / 2, -p.bedY / 2); controls.update(); }
}
$('scale').addEventListener('change', () => rebuildModel());
$('rz').addEventListener('change', () => rebuildModel());
document.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => {
  if (!state.raw) return;
  const a = 'r' + b.dataset.rot; state.rot[a] = (state.rot[a] + 90) % 360; rebuildModel();
}));
$('btnReset').onclick = () => { state.rot = { rx: 0, ry: 0, rz: 0 }; $('scale').value = 100; $('rz').value = 0; rebuildModel(); };

// ------------------------------------------------------------ Slicen
let worker = null;
$('btnSlice').onclick = () => {
  if (!state.placed) return;
  const p = PROFILES[$('profile').value];
  const [x, y, z] = state.size;
  if (x > p.bedX || y > p.bedY || z > p.maxZ) { toast('Das Modell ist größer als der Bauraum – bitte skalieren.', 'err', 7000); return; }
  saveSettings();
  if (worker) worker.terminate();
  worker = new Worker('worker.js');
  overlay(true, 'Starte …', 0);
  $('btnSlice').disabled = true;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') overlay(true, m.text, m.p);
    else if (m.type === 'done') {
      overlay(false); $('btnSlice').disabled = false;
      state.gcode = m.gcode; state.stats = m.stats;
      showPreview(m.preview); $('tabPreview').disabled = false; setView('preview');
      const st = m.stats;
      $('stats').innerHTML = `<span>Schichten</span><span>${st.layers}</span><span>Druckzeit</span><span>${st.timeText}</span>` +
        `<span>Filament</span><span>${(st.filamentMm / 1000).toFixed(2)} m · ${st.filamentG.toFixed(1)} g</span>` +
        `<span>G-Code</span><span>${(m.gcode.length / 1024 / 1024).toFixed(2)} MB</span>`;
      $('result').hidden = false;
      $('panel').scrollTo({ top: $('panel').scrollHeight, behavior: 'smooth' });
    } else if (m.type === 'error') {
      overlay(false); $('btnSlice').disabled = false; toast('Slicing-Fehler: ' + m.message, 'err', 9000);
    }
  };
  worker.onerror = (e) => { overlay(false); $('btnSlice').disabled = false; toast('Worker-Fehler: ' + (e.message || 'unbekannt'), 'err', 9000); };
  // Kopie senden, damit state.placed für erneutes Slicen erhalten bleibt
  worker.postMessage({ tris: state.placed.slice(), settings: readSettings() });
};

// ------------------------------------------------------------ Download / Klipper-Upload
function gcodeName() { return (state.name || 'modell').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_') + '.gcode'; }

$('btnDownload').onclick = async () => {
  if (!state.gcode) return;
  const file = new File([state.gcode], gcodeName(), { type: 'text/plain' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

function baseUrl() {
  let h = $('host').value.trim();
  if (!h) throw new Error('Bitte zuerst die Moonraker-Adresse eintragen (z. B. 192.168.1.50:81).');
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/+$/, '');
}
function hdrs() { const k = $('apikey').value.trim(); return k ? { 'X-Api-Key': k } : {}; }

function mixedContentHint(url) {
  return location.protocol === 'https:' && url.startsWith('http:')
    ? '\n\nHinweis: Diese Seite läuft über https, dein Drucker über http. Safari blockiert das („Mixed Content“). Lösung: Die Seite direkt vom Pi aus öffnen (siehe Anleitung) oder Moonraker per https erreichbar machen.'
    : '';
}

$('btnTest').onclick = async () => {
  const st = $('connState');
  try {
    const url = baseUrl(); st.textContent = 'teste …'; st.style.color = '';
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url + '/server/info', { headers: hdrs(), signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    st.textContent = '✓ verbunden · Klipper: ' + (j.result.klippy_state || '?'); st.style.color = 'var(--ok)';
  } catch (e) {
    st.textContent = '✗ nicht erreichbar'; st.style.color = 'var(--bad)';
    let u = ''; try { u = baseUrl(); } catch (_) {}
    toast((e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message) + '. Läuft Moonraker, und ist die Seite in cors_domains erlaubt?' + mixedContentHint(u), 'err', 12000);
  }
};

$('btnUpload').onclick = async () => {
  if (!state.gcode) return;
  let url;
  try { url = baseUrl(); } catch (e) { toast(e.message, 'err'); document.getElementById('secPrinter').open = true; return; }
  const btn = $('btnUpload'); btn.disabled = true;
  try {
    overlay(true, 'Lade zu Klipper hoch …', 0.3);
    const fd = new FormData();
    fd.append('root', 'gcodes');
    if ($('startPrint').checked) fd.append('print', 'true');
    fd.append('file', new Blob([state.gcode], { type: 'text/plain' }), gcodeName());
    const r = await fetch(url + '/server/files/upload', { method: 'POST', body: fd, headers: hdrs() });
    if (!r.ok) throw new Error('Drucker antwortet mit HTTP ' + r.status);
    overlay(false);
    toast($('startPrint').checked ? '✓ Hochgeladen – Druck wird gestartet' : '✓ Hochgeladen: ' + gcodeName(), 'ok', 7000);
  } catch (e) {
    overlay(false);
    toast('Upload fehlgeschlagen: ' + e.message + mixedContentHint(url), 'err', 14000);
  } finally { btn.disabled = false; }
};

// ------------------------------------------------------------ Service Worker (Offline / Home-Bildschirm)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
