/* worker.js — muta parsarea, geometria si scrierea arhivei pe un fir separat,
   ca interfata sa ramana fluida chiar si la seturi de mii de piese.
   Toata logica reala sta in engine.js / pack.js, folosite si de firul principal
   atunci cand Worker-ul nu e disponibil (de exemplu pe file://). */
/* global importScripts */
importScripts("zip.js", "colors.js", "engine.js", "pack.js");

var MODEL = null;

function progress(p) {
  var m = { type: "progress" };
  for (var k in p) m[k] = p[k];
  self.postMessage(m);
}

self.onmessage = async function (ev) {
  var msg = ev.data || {};
  try {
    if (msg.type === "load") {
      MODEL = await self.BrickEngine.loadModel(msg.buffer, msg.opts || {}, progress);
      progress({ phase: "preview", text: "Se pregateste previzualizarea..." });
      var pv = msg.withPreview === false
        ? { payload: null, transfer: [] }
        : self.BrickEngine.previewPayload(MODEL);
      self.postMessage(
        { type: "loaded", summary: self.BrickEngine.summarize(MODEL), preview: pv.payload },
        pv.transfer
      );

    } else if (msg.type === "export") {
      if (!MODEL) throw new Error("Nu este incarcat niciun model.");
      var res = await self.BrickPack.buildPackage(MODEL, msg.opts || {}, progress);
      self.postMessage({
        type: "exported", blob: res.blob, fileName: res.fileName,
        notes: res.notes, transform: res.transform
      });

    } else if (msg.type === "reset") {
      MODEL = null;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
