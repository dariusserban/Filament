/* app.js — interfata: cauta setul, cere worker-ului sa-l construiasca,
   deseneaza previzualizarea si ofera arhiva.
   zip/mesh/ldraw/build sunt incarcate ca scripturi clasice si stau pe window,
   ca sa poata fi folosite si cand Worker-ul nu e disponibil. */

const $ = (id) => document.getElementById(id);
const BASE = new URL(".", location.href).href;

const el = {
  setCode: $("setCode"), go: $("go"), sug: $("sug"),
  dbNote: $("dbNote"),
  loadProg: $("loadProg"), loadStatus: $("loadStatus"), loadMsg: $("loadMsg"),
  setTitle: $("setTitle"), stats: $("stats"), clist: $("clist"),
  viewWrap: $("viewWrap"), view: $("view"),
  sizeFactor: $("sizeFactor"), plate: $("plate"), infill: $("infill"),
  build: $("build"), dl: $("dl"),
  buildProg: $("buildProg"), buildBar: $("buildBar"), buildStatus: $("buildStatus"), buildMsg: $("buildMsg"),
  step1: $("step1"), step2: $("step2"), step3: $("step3")
};

let summary = null;
let downloadUrl = null;
const hiddenColors = new Set();

// ------------------------------------------------- executor (worker sau nu)

class Runner {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    try {
      this.worker = new Worker("js/worker.js");
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = () => this._failAll("Worker-ul nu a putut porni.");
    } catch (_) {
      this.worker = null;
    }
  }

  _onMessage(msg) {
    if (!msg || msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") { p.onProgress(msg); return; }
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  _failAll(text) {
    for (const p of this.pending.values()) p.reject(new Error(text));
    this.pending.clear();
    this.worker = null;
  }

  call(msg, onProgress) {
    if (this.worker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress: onProgress || (() => {}) });
        this.worker.postMessage({ ...msg, id });
      });
    }
    return this._local(msg, onProgress || (() => {}));
  }

  /* Aceleasi operatii, dar pe firul principal. */
  async _local(msg, onProgress) {
    const B = window.BrickBuild;
    if (msg.type === "init") {
      const cat = await B.loadCatalog(BASE);
      return { meta: cat.meta, sets: Object.keys(cat.index).length };
    }
    if (msg.type === "search") {
      const cat = await B.loadCatalog(BASE);
      return { list: B.searchSets(cat.index, msg.q, msg.limit || 10) };
    }
    if (msg.type === "load") {
      this.model = await B.loadSet(BASE, msg.setCode, onProgress);
      return { summary: localSummary(this.model), preview: B.previewPayload(this.model, msg.opts || {}).payload };
    }
    if (msg.type === "preview") {
      return { preview: B.previewPayload(this.model, msg.opts || {}).payload };
    }
    if (msg.type === "export") {
      return await B.buildPackage(this.model, msg.opts || {}, onProgress);
    }
    throw new Error("Operatie necunoscuta.");
  }
}

function localSummary(m) {
  const kinds = new Set(m.missing.map((x) => x.partNum));
  return {
    setNum: m.setNum, name: m.name, year: m.year, stats: m.stats,
    builtAt: m.builtAt, missingKinds: kinds.size,
    colorGroups: m.colorGroups.map((g) => ({
      colorId: g.colorId, name: g.name, hex: g.hex, trans: g.trans,
      total: g.total, unique: g.unique, triCount: g.triCount
    }))
  };
}

const runner = new Runner();

// ------------------------------------------------------------ pornire

(async function init() {
  try {
    const r = await runner.call({ type: "init", base: BASE });
    el.dbNote.textContent =
      `${r.sets.toLocaleString("ro-RO")} seturi in baza de date · actualizata ${(r.meta.built || "").slice(0, 10)}`;
    el.go.disabled = false;
    el.setCode.disabled = false;
    el.setCode.focus();
  } catch (err) {
    el.dbNote.innerHTML = "";
    note(el.loadMsg,
      "Baza de date nu s-a incarcat. Daca ai deschis pagina direct de pe disc, " +
      "porneste-o dintr-un server local sau foloseste varianta publicata online." +
      `<br><small>${escapeHtml(err.message)}</small>`);
  }
})();

// -------------------------------------------------------- cautarea setului

let sugTimer = null;

el.setCode.addEventListener("input", () => {
  clearTimeout(sugTimer);
  const q = el.setCode.value.trim();
  if (q.length < 2) { el.sug.innerHTML = ""; el.sug.classList.add("hidden"); return; }
  sugTimer = setTimeout(async () => {
    try {
      const r = await runner.call({ type: "search", q, limit: 8 });
      renderSuggestions(r.list);
    } catch (_) {}
  }, 140);
});

el.setCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); startLoad(el.setCode.value.trim()); }
  if (e.key === "Escape") el.sug.classList.add("hidden");
});

el.go.addEventListener("click", () => startLoad(el.setCode.value.trim()));

document.addEventListener("click", (e) => {
  if (!el.sug.contains(e.target) && e.target !== el.setCode) el.sug.classList.add("hidden");
});

function renderSuggestions(list) {
  if (!list.length) { el.sug.classList.add("hidden"); return; }
  el.sug.innerHTML = list.map((s) => `
    <button class="sug-row" data-set="${escapeHtml(s.setNum)}">
      <span class="sug-num">${escapeHtml(s.setNum)}</span>
      <span class="sug-name">${escapeHtml(s.name)}</span>
      <span class="sug-meta">${s.year || ""} · ${s.total.toLocaleString("ro-RO")} piese</span>
    </button>`).join("");
  el.sug.classList.remove("hidden");
  el.sug.querySelectorAll(".sug-row").forEach((b) => {
    b.addEventListener("click", () => {
      el.setCode.value = b.dataset.set;
      el.sug.classList.add("hidden");
      startLoad(b.dataset.set);
    });
  });
}

// ------------------------------------------------------------ incarcare set

async function startLoad(code) {
  if (!code) return;
  el.sug.classList.add("hidden");
  el.loadMsg.innerHTML = "";
  el.loadProg.classList.remove("hidden");
  el.loadStatus.textContent = "Se cauta setul...";
  el.go.disabled = true;
  el.step1.classList.add("active");

  try {
    const res = await runner.call(
      { type: "load", setCode: code, opts: currentOpts() },
      (p) => {
        el.loadStatus.textContent = p.text + (p.total ? `  ${p.done}/${p.total}` : "");
        if (p.total) el.loadStatus.textContent += `  (${Math.round(100 * p.done / p.total)}%)`;
      }
    );

    summary = res.summary;
    hiddenColors.clear();
    el.loadProg.classList.add("hidden");
    el.step1.classList.remove("active");
    el.step1.classList.add("done");
    el.step2.classList.remove("hidden");
    el.step3.classList.remove("hidden");
    el.step3.classList.add("active");
    renderSummary();
    drawPreview(res.preview);
    el.step2.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    el.loadProg.classList.add("hidden");
    note(el.loadMsg, escapeHtml(err.message));
  } finally {
    el.go.disabled = false;
  }
}

function currentOpts() {
  const plate = Number(el.plate.value) || 250;
  return {
    sizeFactor: Number(el.sizeFactor.value) || 1,
    plateW: plate, plateD: plate,
    infillPct: Number(el.infill.value) || 20,
    gap: 3
  };
}

// ------------------------------------------------------------ rezumat

function renderSummary() {
  const s = summary.stats;
  el.setTitle.innerHTML =
    `<b>${escapeHtml(summary.setNum)}</b> — ${escapeHtml(summary.name)}` +
    (summary.year ? ` <span>(${summary.year})</span>` : "");

  el.stats.innerHTML = [
    [s.pieces.toLocaleString("ro-RO"), "piese de printat"],
    [s.uniqueShapes.toLocaleString("ro-RO"), "forme diferite"],
    [s.colors, "culori"],
    [s.triCount >= 1e6 ? (s.triCount / 1e6).toFixed(1) + "M" : s.triCount.toLocaleString("ro-RO"), "triunghiuri"]
  ].map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");

  if (s.missing) {
    note(el.loadMsg,
      `${s.missing} ${s.missing === 1 ? "piesa nu are model 3D" : "piese nu au model 3D"} ` +
      `(${summary.missingKinds} tipuri): autocolante, piese textile, cabluri si imprimeuri unice. ` +
      `Lista completa e in arhiva.`, "warn");
  }

  el.clist.innerHTML =
    `<div class="clist-hd"><span>Culori — ${s.colors}</span><span>${s.pieces.toLocaleString("ro-RO")} piese</span></div>` +
    summary.colorGroups.map((g) => `
      <div class="crow" data-color="${g.colorId}">
        <div class="csw" style="background:${g.hex}"></div>
        <div class="cinfo">
          <div class="cname">${escapeHtml(g.name)}</div>
          <div class="cmeta">${g.hex.toUpperCase()} · ${g.unique} ${g.unique === 1 ? "forma" : "forme"}${g.trans ? " · transparent" : ""}</div>
        </div>
        <div class="cqty">${g.total}</div>
      </div>`).join("");

  el.clist.querySelectorAll(".crow").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.color);
      if (hiddenColors.has(id)) { hiddenColors.delete(id); row.classList.remove("off"); }
      else { hiddenColors.add(id); row.classList.add("off"); }
      applyVisibility();
    });
  });
}

// ------------------------------------------------------- previzualizare 3D

let viewer = null;

function drawPreview(preview) {
  if (!preview) return;
  try {
    if (!viewer) viewer = window.BrickViewer.create(el.view);
    viewer.setModel(preview, preview.world);
    applyVisibility();
  } catch (err) {
    el.viewWrap.innerHTML =
      '<div class="view-fallback">Previzualizarea 3D nu a pornit:<br>' +
      escapeHtml(err.message) + '<br><br>Generarea arhivei functioneaza normal.</div>';
    viewer = null;
  }
}

function applyVisibility() {
  if (!viewer || !summary) return;
  for (const g of summary.colorGroups) viewer.setColorVisible(g.colorId, !hiddenColors.has(g.colorId));
}

/* Scara si patul schimba aranjarea, deci si imaginea. */
let previewTimer = null;
[el.sizeFactor, el.plate].forEach((c) => c.addEventListener("change", () => {
  if (!summary) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await runner.call({ type: "preview", opts: currentOpts() });
      drawPreview(r.preview);
    } catch (_) {}
  }, 60);
}));

// ------------------------------------------------------------- arhiva

el.build.addEventListener("click", async () => {
  if (!summary) return;
  const opts = {
    ...currentOpts(),
    perPiece: $("optPieces").checked,
    plates: $("optPlates").checked,
    mf3: $("opt3mf").checked
  };
  if (!opts.perPiece && !opts.plates && !opts.mf3) {
    note(el.buildMsg, "Bifeaza cel putin un tip de fisier.", "warn");
    return;
  }

  el.build.disabled = true;
  el.dl.classList.add("hidden");
  el.buildMsg.innerHTML = "";
  el.buildProg.classList.remove("hidden");
  el.buildBar.style.width = "2%";
  el.buildStatus.textContent = "Se porneste...";

  try {
    const res = await runner.call({ type: "export", opts }, (p) => {
      el.buildStatus.textContent = p.text || "";
      if (p.total) el.buildBar.style.width = Math.round(5 + (p.done / p.total) * 90) + "%";
      else if (p.phase === "zip") el.buildBar.style.width = "97%";
    });

    el.buildBar.style.width = "100%";
    el.buildStatus.textContent = "Gata.";

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(res.blob);
    el.dl.href = downloadUrl;
    el.dl.download = res.fileName;
    const sz = res.blob.size >= 1048576
      ? (res.blob.size / 1048576).toFixed(1) + " MB"
      : Math.max(1, Math.round(res.blob.size / 1024)) + " KB";
    el.dl.textContent = `Descarca ${res.fileName} (${sz}) ↓`;
    el.dl.classList.remove("hidden");

    let html = `<b>Arhiva e gata.</b> ${summary.stats.pieces.toLocaleString("ro-RO")} piese in ` +
      `${summary.stats.colors} foldere de culoare` +
      (res.plates ? `, aranjate pe ${res.plates} ${res.plates === 1 ? "placa" : "placi"} de ${opts.plateW} mm.` : ".");
    if (res.notes && res.notes.length) html += "<br><br>" + res.notes.map(escapeHtml).join("<br>");
    note(el.buildMsg, html, "ok");

    try { el.dl.click(); } catch (_) {}
  } catch (err) {
    el.buildProg.classList.add("hidden");
    note(el.buildMsg, `Generarea a esuat: <b>${escapeHtml(err.message)}</b>`);
  } finally {
    el.build.disabled = false;
  }
});

// ------------------------------------------------------------- utilitare

function note(container, text, kind) {
  container.innerHTML = `<div class="msg${kind ? " " + kind : ""}">${text}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
