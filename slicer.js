/* Ender Slicer – Slicing-Engine
 * Läuft im Browser-Worker (importScripts) und in Node (require) – gleiche Datei.
 * Eingabe: Dreiecks-Suppe (Float32Array, 9 Werte je Dreieck, mm, Modell liegt auf Z=0 und ist auf dem Bett platziert)
 * Ausgabe: G-Code (Klipper, relative Extrusion), Vorschau-Daten, Statistik
 */
(function (root) {
  'use strict';

  var CL = root.ClipperLib || (typeof require === 'function' ? require('./lib/clipper.js') : null);
  if (!CL) throw new Error('ClipperLib nicht gefunden');

  var S = 1000; // Clipper arbeitet mit ganzen Zahlen: 1 Einheit = 1 µm
  var JT = CL.JoinType, ET = CL.EndType, CT = CL.ClipType, PT = CL.PolyType, FT = CL.PolyFillType;

  var DEFAULT_START =
    'M140 S[first_bed_temp]\n' +
    'M104 S[first_nozzle_temp]\n' +
    'G28 ; Homing\n' +
    '; BED_MESH_CALIBRATE ; <- bei Bedarf einkommentieren\n' +
    'M190 S[first_bed_temp]\n' +
    'M109 S[first_nozzle_temp]\n' +
    'G90\n' +
    'M83\n' +
    'G92 E0\n' +
    '; Purge-Linie\n' +
    'G1 X8 Y20 Z0.3 F5000\n' +
    'G1 X8 Y180 Z0.3 E6 F1500\n' +
    'G1 X8.6 Y180 Z0.3 F5000\n' +
    'G1 X8.6 Y20 Z0.3 E6 F1500\n' +
    'G1 Z2 F600\n';

  var DEFAULT_END =
    'M83\n' +
    'G1 E-2 F2400\n' +
    'G91\n' +
    'G1 Z10 F600\n' +
    'G90\n' +
    'G1 X10 Y[bed_y] F6000\n' +
    'M104 S0\n' +
    'M140 S0\n' +
    'M107\n' +
    'M84\n';

  var DEFAULTS = {
    layerHeight: 0.2, firstLayerHeight: 0.2, lineWidth: 0.42,
    wallCount: 2, topLayers: 5, bottomLayers: 4,
    infillDensity: 15, infillPattern: 'grid',
    nozzleTemp: 210, firstNozzleTemp: 215, bedTemp: 60, firstBedTemp: 60,
    fanSpeed: 100, fanStartLayer: 2,
    speedFirstLayer: 30, speedOuterWall: 100, speedInnerWall: 150, speedInfill: 180, speedSolid: 120,
    speedTravel: 250, minLayerTime: 6, minSpeed: 20, accel: 2500,
    retractLength: 0.8, retractSpeed: 35, retractMinTravel: 1.5, zHop: 0,
    adhesion: 'skirt', skirtLoops: 2, skirtDistance: 5, brimWidth: 5,
    filamentDiameter: 1.75, filamentDensity: 1.24, flow: 100,
    bedX: 220, bedY: 220, maxZ: 250,
    klipperLayerInfo: true,
    startGcode: DEFAULT_START, endGcode: DEFAULT_END
  };

  // ---------------------------------------------------------------- Hilfsfunktionen

  function Fbuf() { this.a = new Float32Array(1 << 16); this.n = 0; }
  Fbuf.prototype.push = function (v) {
    if (this.n >= this.a.length) { var b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  };
  Fbuf.prototype.out = function () { return this.a.slice(0, this.n); };

  function Ubuf() { this.a = new Uint8Array(1 << 14); this.n = 0; }
  Ubuf.prototype.push = function (v) {
    if (this.n >= this.a.length) { var b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  };
  Ubuf.prototype.out = function () { return this.a.slice(0, this.n); };

  function offsetPaths(paths, deltaMm, round) {
    if (!paths.length) return [];
    var co = new CL.ClipperOffset(3, 25);
    co.AddPaths(paths, round ? JT.jtRound : JT.jtMiter, ET.etClosedPolygon);
    var out = new CL.Paths();
    co.Execute(out, deltaMm * S);
    return out;
  }

  function boolOp(type, subj, clip) {
    if (!subj.length) return [];
    if (!clip.length && type === CT.ctIntersection) return [];
    var c = new CL.Clipper();
    c.AddPaths(subj, PT.ptSubject, true);
    if (clip.length) c.AddPaths(clip, PT.ptClip, true);
    var out = new CL.Paths();
    c.Execute(type, out, FT.pftNonZero, FT.pftNonZero);
    return out;
  }

  function clipOpenLines(lines, region) {
    if (!lines.length || !region.length) return [];
    var c = new CL.Clipper();
    c.AddPaths(lines, PT.ptSubject, false);
    c.AddPaths(region, PT.ptClip, true);
    var tree = new CL.PolyTree();
    c.Execute(CT.ctIntersection, tree, FT.pftNonZero, FT.pftNonZero);
    return CL.Clipper.OpenPathsFromPolyTree(tree);
  }

  function dropTiny(paths, minAreaMm2) {
    var min = minAreaMm2 * S * S, out = [];
    for (var i = 0; i < paths.length; i++) {
      if (Math.abs(CL.Clipper.Area(paths[i])) >= min && paths[i].length >= 3) out.push(paths[i]);
    }
    return out;
  }

  // Öffnen (Erosion + Dilatation): entfernt dünne Splitter
  function opening(paths, mm) {
    if (!paths.length) return [];
    return offsetPaths(offsetPaths(paths, -mm, false), mm, false);
  }

  function toMm(path) {
    var r = new Array(path.length);
    for (var i = 0; i < path.length; i++) r[i] = [path[i].X / S, path[i].Y / S];
    return r;
  }

  // ---------------------------------------------------------------- Schnitt Dreiecke × Ebene

  function sliceMesh(tris, nLayers, zMid, h0, h) {
    var nTri = tris.length / 9;
    var segs = new Array(nLayers);
    for (var i = 0; i < nLayers; i++) segs[i] = [];
    var eps = 1e-5;

    for (var t = 0; t < nTri; t++) {
      var o = t * 9;
      var z0 = tris[o + 2], z1 = tris[o + 5], z2 = tris[o + 8];
      var zmin = Math.min(z0, z1, z2), zmax = Math.max(z0, z1, z2);
      if (zmax - zmin < 1e-9) continue; // horizontale Dreiecke schneiden nie
      var iStart = Math.max(0, Math.floor((zmin - h0) / h) - 1);
      var iEnd = Math.min(nLayers - 1, Math.ceil((zmax - h0) / h) + 1);
      for (var L = iStart; L <= iEnd; L++) {
        var p = zMid[L] + eps;
        if (p < zmin || p > zmax) continue;
        var pts = [];
        for (var e = 0; e < 3; e++) {
          var a = o + e * 3, b = o + ((e + 1) % 3) * 3;
          var az = tris[a + 2], bz = tris[b + 2];
          if ((az > p) === (bz > p)) continue;
          // Kante kanonisch ordnen (niedrigerer Z zuerst), damit Nachbardreiecke identische Punkte erzeugen
          var lo = a, hi = b;
          if (az > bz || (az === bz && (tris[a] > tris[b] || (tris[a] === tris[b] && tris[a + 1] > tris[b + 1])))) { lo = b; hi = a; }
          var f = (p - tris[lo + 2]) / (tris[hi + 2] - tris[lo + 2]);
          pts.push(tris[lo] + (tris[hi] - tris[lo]) * f, tris[lo + 1] + (tris[hi + 1] - tris[lo + 1]) * f);
        }
        if (pts.length === 4) segs[L].push(pts[0], pts[1], pts[2], pts[3]);
      }
    }
    return segs;
  }

  function key(x, y) { return Math.round(x * 10000) + '_' + Math.round(y * 10000); }

  function chainSegments(segs) {
    var n = segs.length / 4;
    if (!n) return [];
    var sk = new Array(n), ek = new Array(n), map = new Map(), i;
    for (i = 0; i < n; i++) {
      sk[i] = key(segs[i * 4], segs[i * 4 + 1]);
      ek[i] = key(segs[i * 4 + 2], segs[i * 4 + 3]);
      if (!map.has(sk[i])) map.set(sk[i], []);
      map.get(sk[i]).push(i);
      if (!map.has(ek[i])) map.set(ek[i], []);
      map.get(ek[i]).push(i);
    }
    var used = new Uint8Array(n), loops = [];
    for (i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      var loop = [{ X: Math.round(segs[i * 4] * S), Y: Math.round(segs[i * 4 + 1] * S) },
                  { X: Math.round(segs[i * 4 + 2] * S), Y: Math.round(segs[i * 4 + 3] * S) }];
      var cur = ek[i], start = sk[i];
      while (cur !== start) {
        var cand = map.get(cur), j = -1;
        for (var c = 0; c < cand.length; c++) if (!used[cand[c]]) { j = cand[c]; break; }
        if (j < 0) break;
        used[j] = 1;
        if (sk[j] === cur) {
          loop.push({ X: Math.round(segs[j * 4 + 2] * S), Y: Math.round(segs[j * 4 + 3] * S) });
          cur = ek[j];
        } else {
          loop.push({ X: Math.round(segs[j * 4] * S), Y: Math.round(segs[j * 4 + 1] * S) });
          cur = sk[j];
        }
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  // ---------------------------------------------------------------- Infill-Linien

  function infillLines(region, spacingMm, angleDeg) {
    if (!region.length) return [];
    var a = angleDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var rot = region.map(function (path) {
      return path.map(function (p) {
        var x = Math.round(p.X * ca + p.Y * sa), y = Math.round(-p.X * sa + p.Y * ca);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        return { X: x, Y: y };
      });
    });
    var sp = spacingMm * S;
    var k0 = Math.ceil(minY / sp), k1 = Math.floor(maxY / sp);
    if (k1 - k0 > 20000) return [];
    var lines = [];
    for (var k = k0; k <= k1; k++) {
      var y = Math.round(k * sp);
      lines.push([{ X: minX - 10, Y: y }, { X: maxX + 10, Y: y }]);
    }
    var clipped = clipOpenLines(lines, rot);
    var out = [];
    for (var i = 0; i < clipped.length; i++) {
      var c = clipped[i];
      if (c.length < 2) continue;
      var p0 = c[0], p1 = c[c.length - 1];
      var x0 = (p0.X * ca - p0.Y * sa) / S, y0 = (p0.X * sa + p0.Y * ca) / S;
      var x1 = (p1.X * ca - p1.Y * sa) / S, y1 = (p1.X * sa + p1.Y * ca) / S;
      if (Math.hypot(x1 - x0, y1 - y0) >= 0.3) out.push([x0, y0, x1, y1]);
    }
    return out;
  }

  // Greedy-Nearest-Neighbour (mit Richtungswechsel)
  function orderSegments(segs, pos) {
    if (segs.length > 900) return segs;
    var rem = segs.slice(), out = [], px = pos[0], py = pos[1];
    while (rem.length) {
      var best = 0, bd = Infinity, flip = false;
      for (var i = 0; i < rem.length; i++) {
        var s = rem[i];
        var d1 = (s[0] - px) * (s[0] - px) + (s[1] - py) * (s[1] - py);
        var d2 = (s[2] - px) * (s[2] - px) + (s[3] - py) * (s[3] - py);
        if (d1 < bd) { bd = d1; best = i; flip = false; }
        if (d2 < bd) { bd = d2; best = i; flip = true; }
      }
      var s2 = rem[best];
      rem[best] = rem[rem.length - 1]; rem.pop();
      var seg = flip ? [s2[2], s2[3], s2[0], s2[1]] : s2;
      out.push(seg);
      px = seg[2]; py = seg[3];
    }
    return out;
  }

  function rotateLoopToNearest(pts, pos) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = (pts[i][0] - pos[0]) * (pts[i][0] - pos[0]) + (pts[i][1] - pos[1]) * (pts[i][1] - pos[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    var out = pts.slice(bi).concat(pts.slice(0, bi));
    out.push(out[0]);
    return { pts: out, dist: Math.sqrt(bd) };
  }

  function orderLoops(loops, pos) {
    var rem = loops.slice(), out = [], p = pos;
    while (rem.length) {
      var best = -1, bd = Infinity;
      for (var i = 0; i < rem.length; i++) {
        var pts = rem[i];
        for (var j = 0; j < pts.length; j++) {
          var d = (pts[j][0] - p[0]) * (pts[j][0] - p[0]) + (pts[j][1] - p[1]) * (pts[j][1] - p[1]);
          if (d < bd) { bd = d; best = i; }
        }
      }
      var r = rotateLoopToNearest(rem[best], p);
      rem.splice(best, 1);
      out.push(r.pts);
      p = r.pts[r.pts.length - 1];
    }
    return out;
  }

  function pathLength(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }

  function fmtTime(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + 'h ' : '') + m + 'm ' + s + 's';
  }

  // ---------------------------------------------------------------- Hauptfunktion

  function slice(tris, userSettings, progress) {
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    for (k in userSettings) if (userSettings[k] !== undefined && userSettings[k] !== null) s[k] = userSettings[k];
    progress = progress || function () {};

    var w = s.lineWidth, h = s.layerHeight, h0 = s.firstLayerHeight;
    var W = Math.max(1, Math.round(s.wallCount));
    var nTri = tris.length / 9;
    if (!nTri) throw new Error('Das Modell enthält keine Dreiecke.');

    var maxZ = -Infinity, minZ = Infinity;
    for (var i = 2; i < tris.length; i += 3) { if (tris[i] > maxZ) maxZ = tris[i]; if (tris[i] < minZ) minZ = tris[i]; }
    if (maxZ > s.maxZ + 0.01) throw new Error('Das Modell ist höher als der Bauraum (' + maxZ.toFixed(1) + ' mm > ' + s.maxZ + ' mm).');

    var nLayers = Math.max(1, Math.round((maxZ - h0) / h) + 1);
    var zTop = [], zH = [], zMid = [];
    for (i = 0; i < nLayers; i++) {
      zH[i] = i === 0 ? h0 : h;
      zTop[i] = Math.round((h0 + i * h) * 1000) / 1000;
      zMid[i] = zTop[i] - zH[i] / 2;
    }

    progress(0.02, 'Schneide Modell …');
    var rawSegs = sliceMesh(tris, nLayers, zMid, h0, h);

    // ---- Konturen
    var slices = new Array(nLayers);
    for (i = 0; i < nLayers; i++) {
      var loops = chainSegments(rawSegs[i]);
      rawSegs[i] = null;
      var paths = loops.length ? CL.Clipper.SimplifyPolygons(loops, FT.pftEvenOdd) : [];
      paths = CL.Clipper.CleanPolygons(paths, 25);
      slices[i] = dropTiny(paths, 0.01);
      if (i % 10 === 0) progress(0.02 + 0.18 * i / nLayers, 'Konturen Schicht ' + (i + 1) + '/' + nLayers);
    }

    // ---- Wände + Innenbereich
    var walls = new Array(nLayers), inner = new Array(nLayers);
    for (i = 0; i < nLayers; i++) {
      var wl = [];
      for (var wk = 0; wk < W; wk++) {
        var p = offsetPaths(slices[i], -(w / 2 + wk * w), false);
        p = dropTiny(p, 0.005);
        if (!p.length) break;
        wl.push(p);
      }
      walls[i] = wl;
      inner[i] = wl.length === W ? dropTiny(offsetPaths(slices[i], -(W * w), false), 0.02) : [];
      if (i % 10 === 0) progress(0.2 + 0.2 * i / nLayers, 'Wände Schicht ' + (i + 1) + '/' + nLayers);
    }

    // ---- Boden/Deckel (solide Bereiche)
    var NB = Math.max(0, Math.round(s.bottomLayers)), NT = Math.max(0, Math.round(s.topLayers));
    var solid = new Array(nLayers), sparse = new Array(nLayers);
    for (i = 0; i < nLayers; i++) {
      var inn = inner[i];
      if (!inn.length) { solid[i] = []; sparse[i] = []; continue; }
      var parts = [], acc, j;

      // unten: Bereiche, in denen mindestens eine der N Schichten darunter fehlt
      if (i < NB) {
        parts.push(inn);
      } else if (NB > 0) {
        acc = inner[i - 1];
        for (j = 2; j <= NB && acc.length; j++) acc = boolOp(CT.ctIntersection, acc, inner[i - j]);
        parts.push(boolOp(CT.ctDifference, inn, acc));
      }
      // oben
      if (NT > 0) {
        if (i + NT >= nLayers) {
          // Schichten über dem Modell fehlen -> alles, was nicht von den vorhandenen Schichten darüber gedeckt ist
          acc = i + 1 < nLayers ? inner[i + 1] : [];
          for (j = 2; j <= NT && acc.length; j++) acc = (i + j < nLayers) ? boolOp(CT.ctIntersection, acc, inner[i + j]) : [];
        } else {
          acc = inner[i + 1];
          for (j = 2; j <= NT && acc.length; j++) acc = boolOp(CT.ctIntersection, acc, inner[i + j]);
        }
        parts.push(boolOp(CT.ctDifference, inn, acc));
      }

      var sol = [];
      for (var q = 0; q < parts.length; q++) if (parts[q].length) sol = sol.length ? boolOp(CT.ctUnion, sol, parts[q]) : parts[q];
      sol = sol.length ? dropTiny(opening(sol, 0.12 * w), 0.05) : [];
      solid[i] = sol;
      sparse[i] = sol.length ? dropTiny(boolOp(CT.ctDifference, inn, sol), 0.2) : inn;
      if (i % 10 === 0) progress(0.4 + 0.25 * i / nLayers, 'Boden/Deckel Schicht ' + (i + 1) + '/' + nLayers);
    }

    // ---- Werkzeugwege + G-Code
    var areaMm2 = function (lh) { return lh * (w - lh * (1 - Math.PI / 4)); };
    var filArea = Math.PI * Math.pow(s.filamentDiameter / 2, 2);
    var flow = s.flow / 100;
    var ePerMm = function (lh) { return areaMm2(lh) / filArea * flow; };

    var fmt = function (v, d) { return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString(); };

    var out = [];
    var prevBuf = new Fbuf(), prevTypes = new Ubuf(), layerEnds = new Uint32Array(nLayers);
    var tokens = {
      nozzle_temp: s.nozzleTemp, first_nozzle_temp: s.firstNozzleTemp, bed_temp: s.bedTemp, first_bed_temp: s.firstBedTemp,
      bed_x: s.bedX, bed_y: s.bedY, max_z: s.maxZ, layer_height: h, first_layer_height: h0, filament_diameter: s.filamentDiameter,
      nozzle_temperature: s.nozzleTemp, nozzle_temperature_initial_layer: s.firstNozzleTemp,
      bed_temperature: s.bedTemp, bed_temperature_initial_layer_single: s.firstBedTemp, bed_temperature_initial_layer: s.firstBedTemp,
      print_bed_max_x: s.bedX, print_bed_max_y: s.bedY
    };
    var subst = function (txt) {
      return String(txt).replace(/\[(\w+)\]/g, function (m, n) { return tokens.hasOwnProperty(n) ? tokens[n] : m; });
    };

    out.push('; generated by Ender Slicer (Browser) – Profil: Creality Ender 3 V3 SE / Klipper');
    out.push('; layer_height = ' + h);
    out.push('; first_layer_height = ' + h0);
    out.push('; wall_loops = ' + W);
    out.push('; sparse_infill_density = ' + s.infillDensity + '%');
    out.push('; sparse_infill_pattern = ' + s.infillPattern);
    out.push('; nozzle_temperature = ' + s.nozzleTemp);
    out.push('; bed_temperature = ' + s.bedTemp);
    out.push('; filament_diameter = ' + s.filamentDiameter);
    out.push('; ---- Start-G-Code ----');
    out.push(subst(s.startGcode).replace(/\n+$/, ''));
    out.push('M83 ; relative Extrusion');
    out.push('M104 S' + s.firstNozzleTemp);
    if (s.klipperLayerInfo) out.push('SET_PRINT_STATS_INFO TOTAL_LAYER=' + nLayers);
    out.push('; ---- Ende Start-G-Code ----');

    var cx = 0, cy = 0, cz = 0, lastF = -1, retracted = false, hopped = false;
    var totalE = 0, totalTime = 0;
    var pos = [s.bedX / 2, s.bedY / 2];
    var rl = s.retractLength, rs = s.retractSpeed * 60;

    var f = function (v) { v = Math.round(v * 60); if (v === lastF) return ''; lastF = v; return ' F' + v; };

    var emitRetract = function () {
      if (retracted || rl <= 0) return;
      out.push('G1 E-' + fmt(rl, 3) + ' F' + Math.round(rs)); lastF = Math.round(rs);
      retracted = true; totalTime += 0.1;
      if (s.zHop > 0 && !hopped) { out.push('G1 Z' + fmt(cz + s.zHop, 3) + ' F600'); lastF = 600; hopped = true; }
    };
    var emitUnretract = function (z) {
      if (hopped) { out.push('G1 Z' + fmt(z, 3) + ' F600'); lastF = 600; hopped = false; }
      if (retracted) { out.push('G1 E' + fmt(rl, 3) + ' F' + Math.round(rs)); lastF = Math.round(rs); retracted = false; totalTime += 0.1; }
    };

    for (i = 0; i < nLayers; i++) {
      var z = zTop[i], lh = zH[i], epm = ePerMm(lh);
      var speedCap = i === 0 ? s.speedFirstLayer : Infinity;
      var sp = function (v) { return Math.min(v, speedCap); };
      var layerPaths = []; // {type, pts, speed}
      var p0 = pos.slice();

      // Haftung
      if (i === 0 && s.adhesion !== 'none' && slices[0].length) {
        var aloops = [];
        if (s.adhesion === 'brim') {
          var nb = Math.max(1, Math.round(s.brimWidth / w));
          for (var b = nb - 1; b >= 0; b--) {
            var bp = offsetPaths(slices[0], w / 2 + b * w, true);
            for (var bi = 0; bi < bp.length; bi++) if (CL.Clipper.Orientation(bp[bi])) aloops.push(toMm(bp[bi]));
          }
        } else {
          for (var sl = 0; sl < Math.max(1, Math.round(s.skirtLoops)); sl++) {
            var kp = offsetPaths(slices[0], s.skirtDistance + sl * w, true);
            for (var ki = 0; ki < kp.length; ki++) if (CL.Clipper.Orientation(kp[ki])) aloops.push(toMm(kp[ki]));
          }
        }
        if (s.adhesion === 'brim') {
          // außen nach innen drucken, Reihenfolge wie erzeugt
          for (var al = 0; al < aloops.length; al++) {
            var rr = rotateLoopToNearest(aloops[al], p0);
            layerPaths.push({ type: 0, pts: rr.pts, speed: sp(s.speedOuterWall) });
            p0 = rr.pts[rr.pts.length - 1];
          }
        } else {
          var ord = orderLoops(aloops, p0);
          for (var ao = 0; ao < ord.length; ao++) layerPaths.push({ type: 0, pts: ord[ao], speed: sp(s.speedOuterWall) });
          if (ord.length) p0 = ord[ord.length - 1][ord[ord.length - 1].length - 1];
        }
      }

      // Wände: innen -> außen
      for (var wk2 = walls[i].length - 1; wk2 >= 0; wk2--) {
        var wl2 = walls[i][wk2].map(toMm);
        var wo = orderLoops(wl2, p0);
        for (var wi = 0; wi < wo.length; wi++) {
          layerPaths.push({ type: wk2 === 0 ? 1 : 2, pts: wo[wi], speed: sp(wk2 === 0 ? s.speedOuterWall : s.speedInnerWall) });
        }
        if (wo.length) p0 = wo[wo.length - 1][wo[wo.length - 1].length - 1];
      }

      // Solider Infill (Boden/Deckel)
      if (solid[i].length) {
        var reg = offsetPaths(solid[i], 0.15 * w, false);
        var sa = (i % 2 === 0) ? 45 : 135;
        var ss = orderSegments(infillLines(reg, w * 0.98, sa), p0);
        for (var si = 0; si < ss.length; si++) {
          layerPaths.push({ type: 4, pts: [[ss[si][0], ss[si][1]], [ss[si][2], ss[si][3]]], speed: sp(s.speedSolid) });
        }
        if (ss.length) p0 = [ss[ss.length - 1][2], ss[ss.length - 1][3]];
      }

      // Sparse-Infill
      var dens = Math.max(0, Math.min(100, s.infillDensity)) / 100;
      if (sparse[i].length && dens > 0) {
        var reg2 = offsetPaths(sparse[i], 0.15 * w, false);
        var angles, factor;
        if (dens >= 0.99) { angles = [(i % 2 === 0) ? 45 : 135]; factor = 1; }
        else if (s.infillPattern === 'lines') { angles = [(i % 2 === 0) ? 45 : 135]; factor = 1; }
        else if (s.infillPattern === 'triangles') { angles = [0, 60, 120]; factor = 3; }
        else { angles = [45, 135]; factor = 2; }
        var spacing = w / dens * factor;
        var all = [];
        for (var an = 0; an < angles.length; an++) all = all.concat(infillLines(reg2, spacing, angles[an]));
        var so = orderSegments(all, p0);
        for (var oi = 0; oi < so.length; oi++) {
          layerPaths.push({ type: 3, pts: [[so[oi][0], so[oi][1]], [so[oi][2], so[oi][3]]], speed: sp(s.speedInfill) });
        }
        if (so.length) p0 = [so[so.length - 1][2], so[so.length - 1][3]];
      }

      // Mindest-Schichtzeit -> Geschwindigkeit drosseln
      var lt = 0, pp = pos.slice();
      for (var m = 0; m < layerPaths.length; m++) {
        var lp = layerPaths[m];
        lt += Math.hypot(lp.pts[0][0] - pp[0], lp.pts[0][1] - pp[1]) / s.speedTravel;
        lt += pathLength(lp.pts) / lp.speed + lp.speed / s.accel;
        pp = lp.pts[lp.pts.length - 1];
      }
      if (i > 0 && lt > 0 && lt < s.minLayerTime) {
        var fac = lt / s.minLayerTime;
        for (m = 0; m < layerPaths.length; m++) layerPaths[m].speed = Math.max(Math.min(s.minSpeed, layerPaths[m].speed), layerPaths[m].speed * fac);
      }

      // ---- Ausgabe der Schicht
      out.push(';LAYER_CHANGE');
      out.push(';Z:' + fmt(z, 3));
      out.push(';HEIGHT:' + fmt(lh, 3));
      if (s.klipperLayerInfo) out.push('SET_PRINT_STATS_INFO CURRENT_LAYER=' + (i + 1));
      emitRetract();
      out.push('G1 Z' + fmt(z, 3) + ' F600'); lastF = 600; cz = z; hopped = false;

      if (i === 1 && s.nozzleTemp !== s.firstNozzleTemp) out.push('M104 S' + s.nozzleTemp);
      if (i === 1 && s.bedTemp !== s.firstBedTemp) out.push('M140 S' + s.bedTemp);
      if (i === s.fanStartLayer && s.fanSpeed > 0) out.push('M106 S' + Math.round(255 * s.fanSpeed / 100));
      if (i === 0) out.push('M107');

      var typeName = ['Skirt/Brim', 'Outer wall', 'Inner wall', 'Sparse infill', 'Solid infill'];
      var lastType = -1;
      for (m = 0; m < layerPaths.length; m++) {
        var P = layerPaths[m];
        if (P.type !== lastType) { out.push(';TYPE:' + typeName[P.type]); lastType = P.type; }
        var d = Math.hypot(P.pts[0][0] - cx, P.pts[0][1] - cy);
        if (d > 0.01 || m === 0) {
          if (d >= s.retractMinTravel) emitRetract();
          out.push('G0 X' + fmt(P.pts[0][0], 3) + ' Y' + fmt(P.pts[0][1], 3) + f(s.speedTravel));
          totalTime += d / s.speedTravel;
          cx = P.pts[0][0]; cy = P.pts[0][1];
        }
        emitUnretract(z);
        var Lp = 0;
        for (var n = 1; n < P.pts.length; n++) {
          var x = P.pts[n][0], y = P.pts[n][1];
          var len = Math.hypot(x - cx, y - cy);
          if (len < 0.001) continue;
          var e = len * epm;
          out.push('G1 X' + fmt(x, 3) + ' Y' + fmt(y, 3) + ' E' + fmt(e, 5) + f(P.speed));
          totalE += e; Lp += len;
          prevBuf.push(cx); prevBuf.push(cy); prevBuf.push(z);
          prevBuf.push(x); prevBuf.push(y); prevBuf.push(z);
          prevTypes.push(P.type);
          cx = x; cy = y;
        }
        totalTime += Lp / P.speed + P.speed / s.accel;
      }
      pos = [cx, cy];
      totalTime += 0.2;
      layerEnds[i] = prevTypes.n;
      if (i % 5 === 0) progress(0.65 + 0.33 * i / nLayers, 'G-Code Schicht ' + (i + 1) + '/' + nLayers);
    }

    emitRetract();
    out.push('; ---- Ende-G-Code ----');
    out.push(subst(s.endGcode).replace(/\n+$/, ''));
    var filLen = totalE;
    var filG = filLen * filArea / 1000 * s.filamentDensity;
    out.push('; filament used [mm] = ' + fmt(filLen, 2));
    out.push('; filament used [g] = ' + fmt(filG, 2));
    out.push('; estimated printing time (normal mode) = ' + fmtTime(totalTime));
    out.push('; total layer number = ' + nLayers);
    out.push('; max_z_height = ' + fmt(zTop[nLayers - 1], 3));

    progress(1, 'Fertig');
    return {
      gcode: out.join('\n') + '\n',
      stats: { layers: nLayers, height: zTop[nLayers - 1], filamentMm: filLen, filamentG: filG, timeSec: totalTime, timeText: fmtTime(totalTime), moves: prevTypes.n },
      preview: { pos: prevBuf.out(), types: prevTypes.out(), layerEnds: layerEnds, layerZ: Float32Array.from(zTop) }
    };
  }

  var api = { slice: slice, DEFAULTS: DEFAULTS, DEFAULT_START: DEFAULT_START, DEFAULT_END: DEFAULT_END };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Slicer = api;
})(typeof self !== 'undefined' ? self : globalThis);
