importScripts('lib/clipper.js', 'slicer.js');
self.onmessage = function (e) {
  try {
    var r = self.Slicer.slice(e.data.tris, e.data.settings, function (p, t) { self.postMessage({ type: 'progress', p: p, text: t }); });
    var pv = r.preview;
    self.postMessage({ type: 'done', gcode: r.gcode, stats: r.stats, preview: pv },
      [pv.pos.buffer, pv.types.buffer, pv.layerEnds.buffer, pv.layerZ.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
