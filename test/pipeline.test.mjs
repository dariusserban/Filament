/* Test end-to-end pentru BRICKSPLIT, pe baza de date reala din data/.
   Verifica: parserul LDraw pe piese cu dimensiuni cunoscute, cautarea in
   catalog, incarcarea unui set intreg, aranjarea pe placi, si arhiva
   rezultata (structura, STL binar valid, inventar, 3MF).

   Rulare:  node test/pipeline.test.mjs [numar-set]
*/
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SET = process.argv[2] || "10300";

globalThis.self = globalThis;

/* Browserul aduce fisierele prin fetch; aici le citim de pe disc. */
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^.*?data\//, "data/");
  const file = path.join(ROOT, rel);
  try {
    const buf = fs.readFileSync(file);
    return { ok: true, text: async () => buf.toString("utf8"), json: async () => JSON.parse(buf.toString("utf8")) };
  } catch {
    return { ok: false, text: async () => "", json: async () => null };
  }
};

for (const f of ["zip.js", "mesh.js", "ldraw.js", "build.js"]) {
  (0, eval)(fs.readFileSync(path.join(ROOT, "js", f), "utf8"));
}
const { MBZip: Z, BrickMesh: M, LDraw: L, BrickBuild: B } = globalThis;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra !== undefined ? "   -> " + extra : ""));
  if (!cond) failures++;
}

if (!fs.existsSync(path.join(ROOT, "data", "meta.json"))) {
  console.log("data/ lipseste. Ruleaza intai workflow-ul 'Actualizeaza baza de date'.");
  process.exit(1);
}

// ------------------------------------------------------------- 1. baza de date
console.log("\n== 1. baza de date ==");
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "meta.json"), "utf8"));
console.log("  construita:", meta.built);
check("are seturi", meta.sets > 10000, meta.sets.toLocaleString());
check("are piese cu geometrie", meta.partsWithGeometry > 10000, meta.partsWithGeometry.toLocaleString());
check("are culori", meta.colors > 100, meta.colors);

// --------------------------------------------------------------- 2. LDraw
console.log("\n== 2. parserul LDraw, pe dimensiuni reale ==");
const loader = L.createLoader("data/ldraw/");
/* Masuri LEGO reale: pas 8 mm, caramida 9.6 mm inalta, stud 1.6 mm,
   placa 3.2 mm, tile fara stud 3.2 mm. */
const known = [
  ["3001", "Brick 2 x 4", [32, 16, 11.2]],
  ["3003", "Brick 2 x 2", [16, 16, 11.2]],
  ["3005", "Brick 1 x 1", [8, 8, 11.2]],
  ["3020", "Plate 2 x 4", [32, 16, 4.8]],
  ["3024", "Plate 1 x 1", [8, 8, 4.8]],
  ["3068b", "Tile 2 x 2", [16, 16, 3.2]]
];
const partsTable = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "parts.json"), "utf8"));
for (const [pn, label, want] of known) {
  const entry = partsTable[pn];
  if (!entry) { check(label + " exista", false, pn + " lipseste"); continue; }
  const mesh = await loader.partMesh(entry[1]);
  const ok = mesh && want.every((v, i) => Math.abs(mesh.size[i] - v) < 0.35);
  check(label + " = " + want.join(" x ") + " mm", ok,
    mesh ? mesh.size.map((n) => n.toFixed(1)).join(" x ") + " (" + mesh.triCount + " tri)" : "fara plasa");
}
const brick = await loader.partMesh("3001");
check("piesa e asezata pe pat (Zmin = 0)", Math.abs(minOf(brick.tris, 2)) < 1e-4, minOf(brick.tris, 2));
check("piesa e centrata pe XY",
  Math.abs(minOf(brick.tris, 0) + maxOf(brick.tris, 0)) < 1e-3 &&
  Math.abs(minOf(brick.tris, 1) + maxOf(brick.tris, 1)) < 1e-3);
check("volumul e pozitiv si plauzibil", brick.volume > 1000 && brick.volume < 6000,
  brick.volume.toFixed(0) + " mm3");

// ------------------------------------------------------------- 3. catalog
console.log("\n== 3. cautarea in catalog ==");
const cat = await B.loadCatalog("");
check("indexul s-a incarcat", Object.keys(cat.index).length > 10000);
check('"' + SET + '" se rezolva la varianta -1', B.resolveSetNum(cat.index, SET) === SET + "-1",
  B.resolveSetNum(cat.index, SET));
const found = B.searchSets(cat.index, "millennium", 5);
check("cautarea dupa nume gaseste ceva", found.length > 0,
  found.map((f) => f.setNum).join(", "));
check("cautarea dupa numar pune setul exact primul",
  B.searchSets(cat.index, SET, 5)[0].setNum.startsWith(SET));

// --------------------------------------------------------------- 4. set
console.log("\n== 4. incarcarea setului " + SET + " ==");
const t0 = Date.now();
const model = await B.loadSet("", SET, () => {});
console.log("  " + model.setNum + " — " + model.name + " (" + model.year + "), " + (Date.now() - t0) + " ms");
check("are piese", model.stats.pieces > 100, model.stats.pieces.toLocaleString());
check("are mai multe culori", model.stats.colors > 3, model.stats.colors);
check("aproape totul are geometrie",
  model.stats.missing / (model.stats.pieces + model.stats.missing) < 0.05,
  model.stats.missing + " lipsa din " + (model.stats.pieces + model.stats.missing));
check("fiecare culoare are cel putin o piesa",
  model.colorGroups.every((g) => g.total > 0 && g.unique > 0));
check("suma pe culori = totalul pieselor",
  model.colorGroups.reduce((a, g) => a + g.total, 0) === model.stats.pieces);
check("fiecare forma folosita are plasa",
  model.colorGroups.every((g) => Object.keys(g.shapes).every((k) => model.shapes[k] && model.shapes[k].triCount > 0)));

// ---------------------------------------------------------- 5. aranjare
console.log("\n== 5. aranjarea pe placi ==");
const opts = { sizeFactor: 1, plateW: 250, plateD: 250, gap: 3, infillPct: 20 };
const pv = B.previewPayload(model, opts);
check("previzualizarea are forme si grupuri",
  pv.payload.shapes.length > 0 && pv.payload.groups.length > 0,
  pv.payload.shapes.length + " forme, " + pv.payload.groups.length + " grupuri");
// grupurile cu colorId negativ sunt suporturile de placa desenate sub piese
const realGroups = pv.payload.groups.filter((g) => g.colorId >= 0);
check("numarul de instante = numarul de piese",
  realGroups.reduce((a, g) => a + g.count, 0) === model.stats.pieces,
  realGroups.reduce((a, g) => a + g.count, 0) + " / " + model.stats.pieces);
check("previzualizarea deseneaza si placile",
  pv.payload.groups.some((g) => g.colorId === -1 && g.count > 0),
  (pv.payload.groups.find((g) => g.colorId === -1) || {}).count + " placi");

const big = model.colorGroups[0];
const plates = M.packPlates(
  Object.keys(big.shapes).map((k) => ({ key: k, size: model.shapes[k].size, count: big.shapes[k] })),
  250, 250, 3);
const placed = plates.reduce((a, p) => a + p.placements.length, 0);
check("toate bucatile culorii dominante sunt asezate", placed === big.total,
  placed + " / " + big.total + " pe " + plates.length + " placi");
let outside = 0;
for (const p of plates) for (const pl of p.placements) {
  const sh = model.shapes[pl.key];
  if (!pl.oversize && (pl.x + sh.size[0] / 2 > 253 || pl.y + sh.size[1] / 2 > 253)) outside++;
}
check("nicio bucata nu iese din pat", outside === 0, outside + " in afara");

// ------------------------------------------------------------- 6. arhiva
console.log("\n== 6. arhiva ==");
const res = await B.buildPackage(model, { ...opts, perPiece: true, plates: true, mf3: true }, () => {});
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "bricksplit-test-"));
const zipPath = path.join(OUT, res.fileName);
fs.writeFileSync(zipPath, Buffer.from(await res.blob.arrayBuffer()));
console.log("  " + zipPath + "  (" + (res.blob.size / 1048576).toFixed(1) + " MB, " + res.plates + " placi)");

const files = await Z.readZip(fs.readFileSync(zipPath).buffer.slice(0));
const names = Object.keys(files);
const dir = model.setNum + "/";
check("contine CITESTE-MA.txt", names.includes(dir + "CITESTE-MA.txt"));
check("contine inventar.csv", names.includes(dir + "inventar.csv"));
check("contine ghid-culori.html", names.includes(dir + "ghid-culori.html"));
check("are un folder per culoare",
  new Set(names.filter((n) => n.startsWith(dir + "culori/")).map((n) => n.split("/")[2])).size === model.stats.colors);
check("are STL-uri de piese", names.some((n) => /\/piese\/.*\.stl$/.test(n)));
check("are STL-uri de placi", names.filter((n) => /\/placi\/placa-\d+\.stl$/.test(n)).length === res.plates);
check("are 3MF-uri de placi", names.filter((n) => /\/placi\/placa-\d+\.3mf$/.test(n)).length === res.plates);
check("cantitatea apare in numele fisierelor",
  names.some((n) => /_x\d+\.stl$/.test(n)));

console.log("\n== 7. STL binar valid ==");
const oneStl = names.find((n) => /\/piese\/.*_x\d+\.stl$/.test(n));
const stl = await files[oneStl].read();
const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
const nTri = dv.getUint32(80, true);
check("dimensiune = 84 + 50*nTri", stl.length === 84 + nTri * 50, path.basename(oneStl) + ": " + nTri + " tri");
let zmin = Infinity, degenerate = 0;
for (let i = 0; i < nTri; i++) {
  const o = 84 + i * 50 + 12;
  for (let v = 0; v < 3; v++) zmin = Math.min(zmin, dv.getFloat32(o + v * 12 + 8, true));
  const nx = dv.getFloat32(84 + i * 50, true), ny = dv.getFloat32(84 + i * 50 + 4, true), nz = dv.getFloat32(84 + i * 50 + 8, true);
  if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) degenerate++;
}
check("asezat pe pat", Math.abs(zmin) < 1e-3, zmin);
check("toate normalele sunt finite", degenerate === 0, degenerate + " gresite");

const plateStl = await files[names.find((n) => /placa-01\.stl$/.test(n))].read();
const pdv = new DataView(plateStl.buffer, plateStl.byteOffset, plateStl.byteLength);
let px = [Infinity, -Infinity], py = [Infinity, -Infinity];
const pn2 = pdv.getUint32(80, true);
for (let i = 0; i < pn2; i++) for (let v = 0; v < 3; v++) {
  const o = 84 + i * 50 + 12 + v * 12;
  px[0] = Math.min(px[0], pdv.getFloat32(o, true)); px[1] = Math.max(px[1], pdv.getFloat32(o, true));
  py[0] = Math.min(py[0], pdv.getFloat32(o + 4, true)); py[1] = Math.max(py[1], pdv.getFloat32(o + 4, true));
}
check("placa incape in 250 x 250 mm",
  px[0] > -1 && px[1] < 251 && py[0] > -1 && py[1] < 251,
  `X ${px[0].toFixed(0)}..${px[1].toFixed(0)}  Y ${py[0].toFixed(0)}..${py[1].toFixed(0)}`);

console.log("\n== 8. inventar si 3MF ==");
const csv = new TextDecoder().decode(await files[dir + "inventar.csv"].read()).trim().split("\n");
check("antet sep= pentru Excel", csv[0] === "sep=;");
const csvQty = csv.slice(2).reduce((a, l) => a + Number(l.split(";")[6]), 0);
check("suma din CSV = numarul de piese", csvQty === model.stats.pieces, csvQty);

const mf = await files[names.find((n) => /placa-01\.3mf$/.test(n))].read();
const inner = await Z.readZip(mf.buffer.slice(mf.byteOffset, mf.byteOffset + mf.byteLength));
check("3MF are [Content_Types].xml", !!inner["[Content_Types].xml"]);
const xml = new TextDecoder().decode(await inner["3D/3dmodel.model"].read());
check("3MF in milimetri", xml.includes('unit="millimeter"'));
check("3MF are obiecte si instante", /<object /.test(xml) && /<item /.test(xml));
check("3MF are o culoare", (xml.match(/<base /g) || []).length === 1);

console.log("\n" + (failures ? failures + " verificari au esuat" : "Toate verificarile au trecut."));
console.log("Fisiere de test in: " + OUT);
process.exit(failures ? 1 : 0);

function minOf(a, k) { let m = Infinity; for (let i = k; i < a.length; i += 3) if (a[i] < m) m = a[i]; return m; }
function maxOf(a, k) { let m = -Infinity; for (let i = k; i < a.length; i += 3) if (a[i] > m) m = a[i]; return m; }
