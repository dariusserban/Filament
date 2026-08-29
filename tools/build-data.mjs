/* build-data.mjs — construieste baza de date locala a site-ului.
   Ruleaza in GitHub Actions (are internet liber) si scrie totul in data/,
   ca site-ul sa citeasca doar de la propria adresa: fara CORS, fara cheie API.

   Surse:
     - Rebrickable: inventarele oficiale ale seturilor (ce piesa, ce culoare,
       cate bucati). Datele pot fi folosite in orice scop cu mentionarea sursei.
     - LDraw: geometria pieselor, .dat redistribuibile sub CCAL 2.0.

   Rulare:  node tools/build-data.mjs [--limit-sets N] [--no-ldraw]
*/
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const WORK = path.join(ROOT, ".databuild");

const RB = "https://cdn.rebrickable.com/media/downloads/";
const RB_FILES = ["sets", "colors", "inventories", "inventory_parts", "themes"];
const LDRAW_REPO = "https://github.com/gkjohnson/ldraw-parts-library.git";
const LDRAW_SUBDIR = "complete/ldraw";

const args = process.argv.slice(2);
const LIMIT_SETS = (() => {
  const i = args.indexOf("--limit-sets");
  return i >= 0 ? Number(args[i + 1]) : 0;
})();
const SKIP_LDRAW = args.includes("--no-ldraw");

const log = (...a) => console.log("[build-data]", ...a);
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

// ----------------------------------------------------------------- descarcare

async function fetchGz(name) {
  const url = RB + name + ".csv.gz";
  const dest = path.join(WORK, name + ".csv");
  if (fs.existsSync(dest)) { log("cache:", name); return dest; }
  log("descarc", url);
  const res = await fetch(url, { headers: { "user-agent": "bricksplit-build" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, zlib.gunzipSync(gz));
  log("  ", name + ".csv", mb(fs.statSync(dest).size));
  return dest;
}

/* Parser CSV minimal, dar corect pentru campuri cu ghilimele si virgule. */
function* csvRows(file) {
  const text = fs.readFileSync(file, "utf8");
  let i = 0, field = "", row = [], inQuotes = false, header = null;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    pushField();
    if (!header) header = row;
    else {
      const o = {};
      for (let k = 0; k < header.length; k++) o[header[k]] = row[k];
      pending.push(o);
    }
    row = [];
  };
  const pending = [];
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      pushRow(); i++;
      while (pending.length) yield pending.shift();
      continue;
    }
    field += c; i++;
  }
  if (field.length || row.length) { pushRow(); while (pending.length) yield pending.shift(); }
}

// ------------------------------------------------------------------- LDraw

function ensureLdraw() {
  const dir = path.join(WORK, "ldraw");
  if (fs.existsSync(path.join(dir, LDRAW_SUBDIR, "parts"))) { log("cache: LDraw"); return path.join(dir, LDRAW_SUBDIR); }
  log("clonez biblioteca LDraw...");
  execFileSync("git", ["clone", "--depth", "1", "--quiet", LDRAW_REPO, dir], { stdio: "inherit" });
  return path.join(dir, LDRAW_SUBDIR);
}

/* Pastreaza doar liniile care conteaza pentru geometrie: sub-fisiere (1),
   triunghiuri (3), patrulatere (4) si directivele BFC. Restul (anteturi,
   istoric, comentarii, muchii de tip 2 si 5) nu influenteaza plasa. */
function stripDat(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const t = line[0];
    if (t === "1" || t === "3" || t === "4") { out.push(line); continue; }
    if (t === "0" && /^0\s+BFC\b/i.test(line)) out.push(line);
  }
  return out.join("\n") + "\n";
}

/* Numele fisierelor referite (linii de tip 1), normalizate la cai LDraw. */
function refsOf(text) {
  const refs = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line[0] !== "1") continue;
    const parts = line.split(/\s+/);
    if (parts.length < 15) continue;
    refs.push(parts.slice(14).join(" ").replace(/\\/g, "/").toLowerCase());
  }
  return refs;
}

function resolveLdrawFile(ldrawDir, name) {
  const n = name.replace(/\\/g, "/").toLowerCase();
  for (const base of ["parts", "p", "models"]) {
    const p = path.join(ldrawDir, base, n);
    if (fs.existsSync(p)) return { abs: p, rel: base + "/" + n };
  }
  // primitivele de rezolutie mare stau in p/48 sau p/8
  for (const base of ["p/48", "p/8"]) {
    const p = path.join(ldrawDir, base, path.basename(n));
    if (fs.existsSync(p)) return { abs: p, rel: base + "/" + path.basename(n) };
  }
  return null;
}

// ---------------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, "sets"), { recursive: true });

  // --- 1. Rebrickable
  const files = {};
  for (const f of RB_FILES) files[f] = await fetchGz(f);

  log("citesc culorile...");
  const colors = {};
  for (const r of csvRows(files.colors)) {
    colors[r.id] = {
      name: r.name,
      hex: "#" + (r.rgb || "9E9E9E").toLowerCase(),
      trans: r.is_trans === "t"
    };
  }
  log("  ", Object.keys(colors).length, "culori");

  log("citesc temele...");
  const themes = {};
  for (const r of csvRows(files.themes)) themes[r.id] = r.name;

  log("citesc seturile...");
  const sets = {};
  for (const r of csvRows(files.sets)) {
    sets[r.set_num] = {
      name: r.name, year: Number(r.year) || 0,
      parts: Number(r.num_parts) || 0,
      theme: themes[r.theme_id] || ""
    };
  }
  log("  ", Object.keys(sets).length, "seturi");

  // inventarul principal (version 1) al fiecarui set
  log("citesc inventarele...");
  const invOfSet = {}, setOfInv = {};
  for (const r of csvRows(files.inventories)) {
    const v = Number(r.version) || 1;
    const cur = invOfSet[r.set_num];
    if (!cur || v < cur.v) { invOfSet[r.set_num] = { id: r.id, v }; }
  }
  for (const [setNum, o] of Object.entries(invOfSet)) setOfInv[o.id] = setNum;

  log("citesc piesele din inventare (fisierul mare)...");
  const bySet = {};          // set_num -> { partNum: { colorId: qty } }
  let rows = 0, spares = 0;
  for (const r of csvRows(files.inventory_parts)) {
    rows++;
    const setNum = setOfInv[r.inventory_id];
    if (!setNum) continue;
    if (r.is_spare === "t") { spares++; continue; }
    const s = bySet[setNum] || (bySet[setNum] = {});
    const p = s[r.part_num] || (s[r.part_num] = {});
    p[r.color_id] = (p[r.color_id] || 0) + (Number(r.quantity) || 0);
  }
  log("  ", rows.toLocaleString(), "randuri,", spares.toLocaleString(), "piese de rezerva ignorate");
  log("  ", Object.keys(bySet).length.toLocaleString(), "seturi cu inventar");

  // --- 2. LDraw: ce piese au geometrie
  let ldrawDir = null, haveGeom = new Set(), needFiles = new Set();
  if (!SKIP_LDRAW) {
    ldrawDir = ensureLdraw();
    const used = new Set();
    for (const s of Object.values(bySet)) for (const p of Object.keys(s)) used.add(p);
    log(used.size.toLocaleString(), "numere de piesa distincte apar in seturi");

    const queue = [];
    for (const partNum of used) {
      const f = resolveLdrawFile(ldrawDir, "parts/" + partNum + ".dat")
        || resolveLdrawFile(ldrawDir, partNum + ".dat");
      if (f) { haveGeom.add(partNum); needFiles.add(f.rel); queue.push(f.rel); }
    }
    log(haveGeom.size.toLocaleString(), "au geometrie LDraw",
        `(${(100 * haveGeom.size / used.size).toFixed(0)}%)`);

    log("rezolv dependentele (sub-piese si primitive)...");
    while (queue.length) {
      const rel = queue.pop();
      const abs = path.join(ldrawDir, rel);
      let text;
      try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
      for (const ref of refsOf(text)) {
        const f = resolveLdrawFile(ldrawDir, ref);
        if (f && !needFiles.has(f.rel)) { needFiles.add(f.rel); queue.push(f.rel); }
      }
    }
    log(needFiles.size.toLocaleString(), "fisiere LDraw necesare in total");

    log("scriu biblioteca redusa...");
    let raw = 0, stripped = 0;
    for (const rel of needFiles) {
      const src = fs.readFileSync(path.join(ldrawDir, rel), "utf8");
      const out = stripDat(src);
      raw += src.length; stripped += out.length;
      const dest = path.join(DATA, "ldraw", rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out);
    }
    log("  ", mb(raw), "->", mb(stripped), "dupa curatare");
  }

  // --- 3. seturile: doar cele care au macar o piesa cu geometrie
  log("scriu inventarele...");
  const index = {};
  let written = 0, shards = {};
  const setNums = Object.keys(bySet).sort();

  for (const setNum of setNums) {
    if (LIMIT_SETS && written >= LIMIT_SETS) break;
    const meta = sets[setNum];
    if (!meta) continue;

    const parts = [];
    let total = 0, missing = 0;
    for (const [partNum, byColor] of Object.entries(bySet[setNum])) {
      const known = SKIP_LDRAW || haveGeom.has(partNum);
      for (const [colorId, qty] of Object.entries(byColor)) {
        total += qty;
        if (!known) { missing += qty; continue; }
        parts.push([partNum, Number(colorId), qty]);
      }
    }
    if (!parts.length) continue;

    const shard = shardOf(setNum);
    (shards[shard] || (shards[shard] = {}))[setNum] = parts;
    index[setNum] = [meta.name, meta.year, total, missing, shard];
    written++;
  }

  for (const [shard, obj] of Object.entries(shards)) {
    fs.writeFileSync(path.join(DATA, "sets", shard + ".json"), JSON.stringify(obj));
  }
  fs.writeFileSync(path.join(DATA, "sets-index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(DATA, "colors.json"), JSON.stringify(colors));
  fs.writeFileSync(path.join(DATA, "meta.json"), JSON.stringify({
    built: new Date().toISOString(),
    sets: written,
    colors: Object.keys(colors).length,
    ldrawFiles: needFiles.size,
    partsWithGeometry: haveGeom.size,
    sources: {
      inventories: "Rebrickable (rebrickable.com) — LEGO catalog database",
      geometry: "LDraw Parts Library (ldraw.org) — CCAL 2.0"
    }
  }, null, 2));

  log("gata:", written.toLocaleString(), "seturi in",
      Object.keys(shards).length, "fragmente");
  log("dimensiune data/:", mb(dirSize(DATA)));
}

/* Fragmentul in care intra un set: browserul descarca un singur fisier mic. */
function shardOf(setNum) {
  let h = 0;
  for (let i = 0; i < setNum.length; i++) h = (h * 31 + setNum.charCodeAt(i)) >>> 0;
  return String(h % 256).padStart(3, "0");
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

main().catch((e) => { console.error(e); process.exit(1); });
