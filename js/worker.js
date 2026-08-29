/* worker.js — tine modelul si face munca grea pe un fir separat: cautare in
   catalog, incarcarea geometriei, aranjarea pe placi si scrierea arhivei.
   Logica reala e in build.js, folosit si de firul principal cand Worker-ul
   nu e disponibil (de exemplu pe file://). */
/* global importScripts */
importScripts("zip.js", "mesh.js", "ldraw.js", "build.js");

var MODEL = null;
var BASE = "";

function reply(id, msg, transfer) {
  msg.id = id;
  self.postMessage(msg, transfer || []);
}

function progressFor(id) {
  return function (p) {
    var m = { type: "progress", id: id };
    for (var k in p) m[k] = p[k];
    self.postMessage(m);
  };
}

/* Rezumat pentru interfata: fara geometrie, doar cifre si culori. */
function summarize(model) {
  return {
    setNum: model.setNum, name: model.name, year: model.year,
    stats: model.stats, builtAt: model.builtAt,
    missingKinds: countKinds(model.missing),
    colorGroups: model.colorGroups.map(function (g) {
      return {
        colorId: g.colorId, name: g.name, hex: g.hex, trans: g.trans,
        total: g.total, unique: g.unique, triCount: g.triCount
      };
    })
  };
}

function countKinds(missing) {
  var seen = Object.create(null), n = 0;
  for (var i = 0; i < missing.length; i++) {
    if (!seen[missing[i].partNum]) { seen[missing[i].partNum] = 1; n++; }
  }
  return n;
}

self.onmessage = async function (ev) {
  var msg = ev.data || {};
  var id = msg.id;
  try {
    if (msg.type === "init") {
      BASE = msg.base;
      var cat = await self.BrickBuild.loadCatalog(BASE);
      reply(id, { type: "ready", meta: cat.meta, sets: Object.keys(cat.index).length });

    } else if (msg.type === "search") {
      var c = await self.BrickBuild.loadCatalog(BASE);
      reply(id, { type: "results", list: self.BrickBuild.searchSets(c.index, msg.q, msg.limit || 10) });

    } else if (msg.type === "load") {
      MODEL = await self.BrickBuild.loadSet(BASE, msg.setCode, progressFor(id));
      var pv = self.BrickBuild.previewPayload(MODEL, msg.opts || {});
      reply(id, { type: "loaded", summary: summarize(MODEL), preview: pv.payload }, pv.transfer);

    } else if (msg.type === "preview") {
      if (!MODEL) throw new Error("Niciun set incarcat.");
      var pv2 = self.BrickBuild.previewPayload(MODEL, msg.opts || {});
      reply(id, { type: "preview", preview: pv2.payload }, pv2.transfer);

    } else if (msg.type === "export") {
      if (!MODEL) throw new Error("Niciun set incarcat.");
      var res = await self.BrickBuild.buildPackage(MODEL, msg.opts || {}, progressFor(id));
      reply(id, {
        type: "exported", blob: res.blob, fileName: res.fileName,
        notes: res.notes, plates: res.plates
      });
    }
  } catch (err) {
    reply(id, { type: "error", message: (err && err.message) || String(err) });
  }
};
