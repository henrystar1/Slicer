/* Ender Slicer – Modell-Loader (STL binär/ASCII, 3MF inkl. Transformationen & Komponenten)
 * Gibt eine Dreiecks-Suppe (Float32Array, 9 Werte je Dreieck) in mm zurück.
 */
(function (root) {
  'use strict';

  function parseSTL(buf) {
    var dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      var n = dv.getUint32(80, true);
      if (84 + n * 50 === buf.byteLength) {
        var out = new Float32Array(n * 9);
        for (var i = 0; i < n; i++) {
          var o = 84 + i * 50 + 12;
          for (var k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        }
        return out;
      }
    }
    // ASCII
    var text = new TextDecoder().decode(buf);
    var re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, m, vals = [];
    while ((m = re.exec(text))) vals.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    if (!vals.length || vals.length % 9) throw new Error('STL-Datei konnte nicht gelesen werden.');
    return Float32Array.from(vals);
  }

  // 3x4-Matrix (Spalten-Konvention der 3MF-Spezifikation: "m00 m01 m02 m10 ... m30 m31 m32")
  function parseMatrix(str) {
    if (!str) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    var v = str.trim().split(/\s+/).map(Number);
    return v.length === 12 ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  }
  function applyM(m, x, y, z) {
    return [
      x * m[0] + y * m[3] + z * m[6] + m[9],
      x * m[1] + y * m[4] + z * m[7] + m[10],
      x * m[2] + y * m[5] + z * m[8] + m[11]
    ];
  }
  function mulM(a, b) { // erst a, dann b
    var r = new Array(12);
    for (var c = 0; c < 3; c++) {
      r[c] = a[0] * b[c] + a[1] * b[3 + c] + a[2] * b[6 + c];
      r[3 + c] = a[3] * b[c] + a[4] * b[3 + c] + a[5] * b[6 + c];
      r[6 + c] = a[6] * b[c] + a[7] * b[3 + c] + a[8] * b[6 + c];
      r[9 + c] = a[9] * b[c] + a[10] * b[3 + c] + a[11] * b[6 + c] + b[9 + c];
    }
    return r;
  }

  async function unzip(buf) {
    var fflate = root.fflate;
    if (fflate) {
      var files = fflate.unzipSync(new Uint8Array(buf));
      return files;
    }
    throw new Error('fflate nicht geladen');
  }

  function attr(el, name) { return el.getAttribute(name); }

  async function parse3MF(buf) {
    var files = await unzip(buf);
    var dec = new TextDecoder();
    var names = Object.keys(files);
    var rels = names.find(function (n) { return /_rels\/\.rels$/i.test(n); });
    var modelPath = null;
    if (rels) {
      var rdoc = new DOMParser().parseFromString(dec.decode(files[rels]), 'application/xml');
      var rs = rdoc.getElementsByTagName('Relationship');
      for (var i = 0; i < rs.length; i++) {
        if (/3dmodel/i.test(attr(rs[i], 'Type') || '')) { modelPath = (attr(rs[i], 'Target') || '').replace(/^\//, ''); break; }
      }
    }
    if (!modelPath || !files[modelPath]) modelPath = names.find(function (n) { return /3D\/.*\.model$/i.test(n); });
    if (!modelPath) throw new Error('3MF enthält kein 3D-Modell.');

    var cache = {};
    function loadModelFile(path) {
      path = path.replace(/^\//, '');
      if (cache[path]) return cache[path];
      if (!files[path]) throw new Error('3MF: Datei fehlt: ' + path);
      var doc = new DOMParser().parseFromString(dec.decode(files[path]), 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('3MF: XML-Fehler in ' + path);
      var objs = {};
      var ol = doc.getElementsByTagName('object');
      for (var i = 0; i < ol.length; i++) {
        var o = ol[i], id = attr(o, 'id'), entry = { type: attr(o, 'type') || 'model', mesh: null, comps: [] };
        var mesh = o.getElementsByTagName('mesh')[0];
        if (mesh) {
          var vs = mesh.getElementsByTagName('vertex'), vv = new Float64Array(vs.length * 3);
          for (var v = 0; v < vs.length; v++) {
            vv[v * 3] = +attr(vs[v], 'x'); vv[v * 3 + 1] = +attr(vs[v], 'y'); vv[v * 3 + 2] = +attr(vs[v], 'z');
          }
          var ts = mesh.getElementsByTagName('triangle'), tt = new Uint32Array(ts.length * 3);
          for (var t = 0; t < ts.length; t++) {
            tt[t * 3] = +attr(ts[t], 'v1'); tt[t * 3 + 1] = +attr(ts[t], 'v2'); tt[t * 3 + 2] = +attr(ts[t], 'v3');
          }
          entry.mesh = { v: vv, t: tt };
        }
        var cs = o.getElementsByTagName('component');
        for (var c = 0; c < cs.length; c++) {
          entry.comps.push({ id: attr(cs[c], 'objectid'), path: attr(cs[c], 'p:path') || attr(cs[c], 'path'), m: parseMatrix(attr(cs[c], 'transform')) });
        }
        objs[id] = entry;
      }
      var items = [], il = doc.getElementsByTagName('item');
      for (i = 0; i < il.length; i++) items.push({ id: attr(il[i], 'objectid'), m: parseMatrix(attr(il[i], 'transform')) });
      var unit = (doc.documentElement.getAttribute('unit') || 'millimeter');
      return (cache[path] = { objs: objs, items: items, unit: unit });
    }

    var out = [];
    function emit(file, id, M, depth) {
      if (depth > 16) return;
      var obj = file.objs[id];
      if (!obj) return;
      if (obj.type === 'support' || obj.type === 'solidsupport' || obj.type === 'surface') return;
      if (obj.mesh) {
        var vv = obj.mesh.v, tt = obj.mesh.t;
        for (var t = 0; t < tt.length; t += 3) {
          var a = applyM(M, vv[tt[t] * 3], vv[tt[t] * 3 + 1], vv[tt[t] * 3 + 2]);
          var b = applyM(M, vv[tt[t + 1] * 3], vv[tt[t + 1] * 3 + 1], vv[tt[t + 1] * 3 + 2]);
          var c = applyM(M, vv[tt[t + 2] * 3], vv[tt[t + 2] * 3 + 1], vv[tt[t + 2] * 3 + 2]);
          out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        }
      }
      for (var k = 0; k < obj.comps.length; k++) {
        var cp = obj.comps[k];
        var f2 = cp.path ? loadModelFile(cp.path) : file;
        emit(f2, cp.id, mulM(cp.m, M), depth + 1);
      }
    }

    var main = loadModelFile(modelPath);
    var scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[main.unit] || 1;
    for (var i2 = 0; i2 < main.items.length; i2++) emit(main, main.items[i2].id, main.items[i2].m, 0);
    if (!out.length) throw new Error('3MF enthält keine druckbaren Dreiecke.');
    var arr = Float32Array.from(out);
    if (scale !== 1) for (var q = 0; q < arr.length; q++) arr[q] *= scale;
    return arr;
  }

  // Modell auf Bettmitte setzen, Unterseite auf Z=0
  function placeOnBed(tris, bedX, bedY) {
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < tris.length; i += 3) for (var k = 0; k < 3; k++) {
      var v = tris[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
    }
    var dx = bedX / 2 - (min[0] + max[0]) / 2, dy = bedY / 2 - (min[1] + max[1]) / 2, dz = -min[2];
    var out = new Float32Array(tris.length);
    for (i = 0; i < tris.length; i += 3) { out[i] = tris[i] + dx; out[i + 1] = tris[i + 1] + dy; out[i + 2] = tris[i + 2] + dz; }
    return { tris: out, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }

  // Transformationen (Skalierung, Rotation um Z, 90°-Drehungen)
  function transform(tris, opt) {
    var out = new Float32Array(tris.length);
    var sx = opt.sx || 1, sy = opt.sy || 1, sz = opt.sz || 1;
    var rz = (opt.rz || 0) * Math.PI / 180, cz = Math.cos(rz), szn = Math.sin(rz);
    var rx = (opt.rx || 0) * Math.PI / 180, cx = Math.cos(rx), sxn = Math.sin(rx);
    var ry = (opt.ry || 0) * Math.PI / 180, cy = Math.cos(ry), syn = Math.sin(ry);
    for (var i = 0; i < tris.length; i += 3) {
      var x = tris[i] * sx, y = tris[i + 1] * sy, z = tris[i + 2] * sz, t;
      t = y * cx - z * sxn; z = y * sxn + z * cx; y = t;       // um X
      t = x * cy + z * syn; z = -x * syn + z * cy; x = t;      // um Y
      t = x * cz - y * szn; y = x * szn + y * cz; x = t;       // um Z
      out[i] = x; out[i + 1] = y; out[i + 2] = z;
    }
    return out;
  }

  async function loadModel(name, buf) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'stl') return parseSTL(buf);
    if (ext === '3mf') return parse3MF(buf);
    throw new Error('Nur .stl und .3mf werden unterstützt.');
  }

  var api = { loadModel: loadModel, parseSTL: parseSTL, parse3MF: parse3MF, placeOnBed: placeOnBed, transform: transform };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Loader = api;
})(typeof self !== 'undefined' ? self : globalThis);
