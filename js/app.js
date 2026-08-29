/* app.js — interfata: preia fisierul, porteste munca in worker, deseneaza
   previzualizarea 3D si construieste arhiva.
   Modulele zip/colors/engine/pack sunt incarcate ca scripturi clasice si sunt
   disponibile pe `window`, ca sa poata fi folosite si fara Worker. */

const $ = (id) => document.getElementById(id);
const E = window.BrickEngine;

const el = {
  setCode: $("setCode"), openMeca: $("openMeca"),
  drop: $("drop"), file: $("file"),
  loadProg: $("loadProg"), loadStatus: $("loadStatus"), loadMsg: $("loadMsg"),
  stats: $("stats"), clist: $("clist"), viewWrap: $("viewWrap"), view: $("view"),
  scale: $("scale"), scaleNote: $("scaleNote"), sizeFactor: $("sizeFactor"), infill: $("infill"),
  build: $("build"), dl: $("dl"),
  buildProg: $("buildProg"), buildBar: $("buildBar"), buildStatus: $("buildStatus"), buildMsg: $("buildMsg"),
  step1: $("step1"), step2: $("step2"), step3: $("step3"), step4: $("step4")
};

let summary = null;
let downloadUrl = null;
let lastLogos = false;   // optiunea de logo cu care a fost construita geometria curenta

// --------------------------------------------------------------- pasul 1: cod

function currentSetCode() {
  return (el.setCode.value || "").trim();
}

function refreshMecaLink() {
  const code = currentSetCode();
  el.openMeca.href = code
    ? "https://www.mecabricks.com/en/models?keywords=" + encodeURIComponent(code)
    : "https://www.mecabricks.com/en/models";
  el.openMeca.textContent = code ? `Cauta setul ${code} pe Mecabricks ↗` : "Cauta pe Mecabricks ↗";
}

el.setCode.addEventListener("input", () => {
  refreshMecaLink();
  try { localStorage.setItem("bricksplit.set", currentSetCode()); } catch (_) {}
});

try {
  const saved = localStorage.getItem("bricksplit.set");
  if (saved) el.setCode.value = saved;
} catch (_) {}
refreshMecaLink();

// ------------------------------------------------------- executor (worker sau nu)

class Runner {
  constructor() {
    this.worker = null;
    this.model = null;
    this.pending = null;
    this.workerFailed = false;
    try {
      this.worker = new Worker("js/worker.js");
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = (ev) => {
        if (this.pending) { this.pending.reject(new Error(ev.message || "Eroare in worker.")); this.pending = null; }
      };
    } catch (_) {
      this.worker = null;   // file:// sau browser fara Worker — mergem pe firul principal
    }
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === "progress") { if (this.pending) this.pending.onProgress(msg); return; }
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  _post(msg, transfer, onProgress) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, onProgress: onProgress || (() => {}) };
      this.worker.postMessage(msg, transfer || []);
    });
  }

  async load(buffer, opts, onProgress) {
    if (this.worker) {
      // buffer-ul e transferat catre worker, deci pastram o copie pentru
      // cazul in care worker-ul cade si trebuie sa reluam pe firul principal
      const backup = buffer.slice(0);
      try {
        return await this._post({ type: "load", buffer, opts }, [buffer], onProgress);
      } catch (err) {
        if (!this.workerFailed) {
          this.workerFailed = true;
          this.worker.terminate();
          this.worker = null;
          console.warn("Worker-ul nu a putut fi folosit, se continua pe firul principal:", err.message);
          return await this.load(backup, opts, onProgress);
        }
        throw err;
      }
    }
    this.model = await E.loadModel(buffer, opts, onProgress);
    onProgress({ phase: "preview", text: "Se pregateste previzualizarea..." });
    return { summary: E.summarize(this.model), preview: E.previewPayload(this.model).payload };
  }

  async build(opts, onProgress) {
    if (this.worker) return await this._post({ type: "export", opts }, [], onProgress);
    if (!this.model) throw new Error("Nu este incarcat niciun model.");
    return await window.BrickPack.buildPackage(this.model, opts, onProgress);
  }
}

const runner = new Runner();

// ------------------------------------------------------------- pasul 2: fisier

el.drop.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", () => { if (el.file.files[0]) handleFile(el.file.files[0]); });

["dragenter", "dragover"].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove("over"); }));
el.drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

function note(container, text, kind) {
  container.innerHTML = `<div class="msg${kind ? " " + kind : ""}">${text}</div>`;
}

async function handleFile(file) {
  if (!/\.(zmbx|mbx)$/i.test(file.name)) {
    note(el.loadMsg,
      `<b>${escapeHtml(file.name)}</b> nu pare a fi un export Mecabricks. Am nevoie de un fisier <code>.zmbx</code> (sau <code>.mbx</code>).`);
    return;
  }
  if (typeof CompressionStream === "undefined") {
    note(el.loadMsg, "Browserul tau nu suporta <code>CompressionStream</code>. Foloseste Chrome, Edge, Firefox 113+ sau Safari 16.4+.");
    return;
  }

  el.loadMsg.innerHTML = "";
  el.loadProg.classList.remove("hidden");
  el.loadStatus.textContent = "Se citeste fisierul...";
  el.step2.classList.add("active");

  try {
    const buffer = await file.arrayBuffer();
    const res = await runner.load(
      buffer,
      { includeLogos: $("optLogos").checked },
      (p) => { el.loadStatus.textContent = p.text + (p.total ? `  ${p.done}/${p.total}` : ""); }
    );

    summary = res.summary;
    lastLogos = $("optLogos").checked;
    el.loadProg.classList.add("hidden");
    el.step2.classList.remove("active");
    el.step2.classList.add("done");
    el.step1.classList.add("done");
    el.step1.classList.remove("active");

    renderSummary();
    el.step3.classList.remove("hidden");
    el.step4.classList.remove("hidden");
    el.step4.classList.add("active");
    buildPreview(res.preview);
    el.step3.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    el.loadProg.classList.add("hidden");
    note(el.loadMsg, `Nu am putut citi fisierul: <b>${escapeHtml(err.message)}</b>`);
    console.error(err);
  }
}

// ------------------------------------------------------- pasul 3: rezumat + culori

const hidden = new Set();

function renderSummary() {
  const s = summary.stats;
  const ds = summary.detectedScale;

  el.scale.value = Number(ds.scale.toFixed(4));
  el.scaleNote.textContent = ds.pitch
    ? `dedus automat din pasul stud-urilor (${ds.pitch.toFixed(4)} u = 8 mm)`
    : "nu am putut deduce scara — verific-o inainte de printare";

  el.stats.innerHTML = [
    [s.parts.toLocaleString("ro-RO"), "piese"],
    [s.uniqueShapes.toLocaleString("ro-RO"), "forme diferite"],
    [s.colors, "culori"],
    [s.triCount >= 1e6 ? (s.triCount / 1e6).toFixed(1) + "M" : s.triCount.toLocaleString("ro-RO"), "triunghiuri"]
  ].map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");

  if (s.skipped) {
    note(el.loadMsg,
      `${s.skipped} ${s.skipped === 1 ? "piesa nu a putut fi reconstruita" : "piese nu au putut fi reconstruite"} (geometrie lipsa in export) si ${s.skipped === 1 ? "a fost sarita" : "au fost sarite"}.`,
      "warn");
  }

  el.clist.innerHTML =
    `<div class="clist-hd"><span>Culori — ${s.colors}</span><span>${s.parts.toLocaleString("ro-RO")} piese</span></div>` +
    summary.colorGroups.map((g, i) => `
      <div class="crow" data-color="${g.colorId}">
        <div class="csw" style="background:${g.hex}"></div>
        <div class="cinfo">
          <div class="cname">${escapeHtml(g.name)}</div>
          <div class="cmeta">#${g.colorId} · ${g.type} · ${g.unique} ${g.unique === 1 ? "forma" : "forme"} · ${g.hex.toUpperCase()}</div>
        </div>
        <div class="cqty">${g.total}</div>
      </div>`).join("");

  el.clist.querySelectorAll(".crow").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.color);
      if (hidden.has(id)) { hidden.delete(id); row.classList.remove("off"); }
      else { hidden.add(id); row.classList.add("off"); }
      applyVisibility();
    });
  });

  updateSizeNote();
}

function updateSizeNote() {
  if (!summary) return;
  const s = Number(el.scale.value) * Number(el.sizeFactor.value);
  const w = summary.world;
  let d = [w.max[0] - w.min[0], w.max[1] - w.min[1], w.max[2] - w.min[2]];
  // Mecabricks are Y in sus; la export rotim in conventia imprimantei (Z sus),
  // deci afisam dimensiunile exact in orientarea in care ies fisierele.
  if ($("optZUp").checked) d = [d[0], d[2], d[1]];
  const dims = d.map((v) => (v * s).toFixed(0));
  const ds = summary.detectedScale;
  el.scaleNote.textContent =
    `model asamblat: ${dims[0]} x ${dims[1]} x ${dims[2]} mm` +
    (ds.pitch ? ` · scara dedusa din stud-uri (${ds.pitch.toFixed(4)} u = 8 mm)` : " · scara nedetectata, verific-o");
}
el.scale.addEventListener("input", updateSizeNote);
el.sizeFactor.addEventListener("change", updateSizeNote);
$("optZUp").addEventListener("change", updateSizeNote);

// ----------------------------------------------------------- previzualizare 3D

let viewer = null;

function buildPreview(preview) {
  if (!preview) return;
  try {
    if (!viewer) viewer = window.BrickViewer.create(el.view);
    viewer.setModel(preview, summary.world);
    applyVisibility();
  } catch (err) {
    el.viewWrap.innerHTML =
      '<div class="view-fallback">Previzualizarea 3D nu a putut fi initializata:<br/>' +
      escapeHtml(err.message) + '<br/><br/>Generarea arhivei functioneaza normal.</div>';
    viewer = null;
    console.error(err);
  }
}

function applyVisibility() {
  if (!viewer) return;
  for (const g of summary.colorGroups) viewer.setColorVisible(g.colorId, !hidden.has(g.colorId));
}

// ----------------------------------------------------------- pasul 4: arhiva

el.build.addEventListener("click", async () => {
  if (!summary) return;
  const perPiece = $("optPerPiece").checked;
  const merged = $("optMerged").checked;
  const threeMf = $("opt3mf").checked;

  if (!perPiece && !merged && !threeMf) {
    note(el.buildMsg, "Bifeaza cel putin un tip de fisier de generat.", "warn");
    return;
  }
  if ($("optLogos").checked !== !!lastLogos) {
    note(el.buildMsg,
      "Ai schimbat optiunea pentru logo-ul de pe stud-uri. Reincarca fisierul .zmbx ca sa aiba efect — geometria se construieste la incarcare.",
      "warn");
    return;
  }

  const opts = {
    setCode: currentSetCode() || "set-lego",
    scale: Number(el.scale.value) || 10,
    sizeFactor: Number(el.sizeFactor.value) || 1,
    infillPct: Number(el.infill.value) || 20,
    zUp: $("optZUp").checked,
    dropToBed: true,
    includeLogos: $("optLogos").checked,
    perPiece, perColorMerged: merged, full3mf: threeMf
  };

  el.build.disabled = true;
  el.dl.classList.add("hidden");
  el.buildMsg.innerHTML = "";
  el.buildProg.classList.remove("hidden");
  el.buildBar.style.width = "2%";
  el.buildStatus.textContent = "Se porneste...";

  try {
    const res = await runner.build(opts, (p) => {
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

    const t = res.transform;
    let html = `<b>Arhiva este gata.</b> ${summary.stats.parts.toLocaleString("ro-RO")} piese in ` +
      `${summary.stats.colors} foldere de culoare. Modelul asamblat masoara ` +
      `${t.sizeMm.map((d) => d.toFixed(0)).join(" x ")} mm.`;
    if (res.notes && res.notes.length) html += "<br/><br/>" + res.notes.map(escapeHtml).join("<br/>");
    note(el.buildMsg, html, "ok");

    try { el.dl.click(); } catch (_) {}
  } catch (err) {
    el.buildProg.classList.add("hidden");
    note(el.buildMsg, `Generarea a esuat: <b>${escapeHtml(err.message)}</b>`);
    console.error(err);
  } finally {
    el.build.disabled = false;
  }
});

/* Optiunea pentru logo schimba geometria pieselor, deci se aplica la incarcare,
   nu la export: daca a fost schimbata dupa incarcare, cerem o reincarcare. */
$("optLogos").addEventListener("change", (e) => {
  if (summary && e.target.checked !== lastLogos) {
    note(el.buildMsg,
      "Optiunea pentru logo se aplica la reconstruirea geometriei. Incarca din nou fisierul .zmbx pentru a o folosi.",
      "warn");
  } else if (summary) {
    el.buildMsg.innerHTML = "";
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
