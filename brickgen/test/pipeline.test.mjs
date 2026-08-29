/* Test end-to-end pentru BRICKSPLIT.
   Construieste un .zmbx sintetic (doua forme de piesa, trei culori), il trece
   prin engine.js + pack.js si verifica arhiva rezultata: numarul de piese,
   scara dedusa din stud-uri, geometria in milimetri, structura ZIP-ului,
   antetul STL binar, inventarul CSV si validitatea 3MF-ului.

   Rulare:  node brickgen/test/pipeline.test.mjs
   Optional, pentru o verificare cu un dezarhivator independent:
            unzip -t <arhiva raportata la final> */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.self = globalThis;
const BASE = path.join(HERE, "..", "js") + path.sep;
for (const f of ["zip.js", "colors.js", "engine.js", "pack.js"]) {
  (0, eval)(fs.readFileSync(BASE + f, "utf8"));
}
const { BrickEngine: E, BrickPack: P, MBZip: Z } = globalThis;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra !== undefined ? "   -> " + extra : ""));
  if (!cond) failures++;
}

// ---------------------------------------------------------------- geometrie test
/* Cutie ca geometrie in format Mecabricks: vertices plate + faces cu flags=0. */
function boxGeom(sx, sy, sz, cx = 0, cy = 0, cz = 0) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const v = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  const faces = [];
  for (const q of quads) faces.push(0x01, q[0], q[1], q[2], q[3]);   // flag QUAD
  return { vertices: v, faces, normals: [] };
}

const STUD = 0.8;                      // pasul dintre stud-uri, in unitati Mecabricks
const knobPositions = [];
for (const x of [0.4, 1.2, 2.0, 2.8]) for (const z of [0.4, 1.2]) knobPositions.push([x, 0.96, z]);

const mbx = {
  metadata: { version: [1, 0, 0], date: "2026-01-01", generator: "test" },
  parts: [],
  configurations: {
    1: {
      "3001": {
        type: "part", version: 1, name: "Brick 2x4",
        geometry: {
          file: "brick2x4.json",
          extras: {
            knobs: knobPositions.map((p) => ({ type: 0, transform: { position: p, quaternion: [0, 0, 0, 1] } })),
            tubes: [], pins: [], logos: [
              ...knobPositions.map((p) => ({ type: 0, transform: { position: [p[0], p[1] + 0.17, p[2]], quaternion: [0, 0, 0, 1] } }))
            ]
          }
        },
        points: []
      },
      "3005": {
        type: "part", version: 1, name: "Brick 1x1",
        geometry: {
          file: "brick1x1.json",
          extras: {
            knobs: [{ type: 0, transform: { position: [0.4, 0.96, 0.4], quaternion: [0, 0, 0, 1] } }],
            tubes: [], pins: [], logos: []
          }
        },
        points: []
      }
    }
  },
  geometries: {
    1: {
      "brick2x4.json": boxGeom(3.2, 0.96, 1.6, 1.6, 0.48, 0.8),
      "brick1x1.json": boxGeom(0.8, 0.96, 0.8, 0.4, 0.48, 0.4)
    }
  },
  details: {
    knobs: { 0: boxGeom(0.48, 0.17, 0.48, 0, 0.085, 0) },
    tubes: {}, pins: {},
    logos: { 0: boxGeom(0.3, 0.02, 0.3, 0, 0.01, 0) }
  },
  textures: {}
};

function mat(tx, ty, tz) {
  return [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
}
const layout = [
  ["3001", 21, 0, 0, 0], ["3001", 21, 0, 0.96, 0], ["3001", 21, 3.2, 0, 0],
  ["3001", 26, 0, 1.92, 0], ["3001", 26, 3.2, 0.96, 0],
  ["3005", 1, 0, 2.88, 0], ["3005", 1, 0.8, 2.88, 0], ["3005", 1, 1.6, 2.88, 0], ["3005", 1, 2.4, 2.88, 0]
];
for (const [cfg, color, x, y, z] of layout) {
  mbx.parts.push({
    type: "solid", version: 1, scope: "official", id: Number(cfg), configuration: cfg,
    matrix: mat(x, y, z), objectIndex: 0, material: { base: [color], decoration: {} }
  });
}

// ------------------------------------------------------------- construieste .zmbx
const inner = new Z.ZipWriter();
await inner.add("scene.mbx", JSON.stringify(mbx));
const zmbxBlob = inner.finish();
const zmbxBuf = await zmbxBlob.arrayBuffer();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "bricksplit-test-"));
fs.writeFileSync(path.join(OUT, "test.zmbx"), Buffer.from(zmbxBuf));

console.log("\n== 1. .zmbx scris de ZipWriter, recitit de readZip ==");
const back = await Z.readZip(zmbxBuf);
check("arhiva contine scene.mbx", !!back["scene.mbx"]);
const roundtrip = JSON.parse(new TextDecoder().decode(await back["scene.mbx"].read()));
check("JSON identic dupa dus-intors", JSON.stringify(roundtrip) === JSON.stringify(mbx));

console.log("\n== 2. loadModel ==");
const model = await E.loadModel(zmbxBuf, { includeLogos: false }, () => {});
check("9 piese", model.stats.parts === 9, model.stats.parts);
check("2 forme unice", model.stats.uniqueShapes === 2, model.stats.uniqueShapes);
check("3 culori", model.stats.colors === 3, model.stats.colors);
// layout: 4 placi albe, 3 caramizi rosii, 2 negre -> grupurile vin ordonate descrescator
check("culorile sunt ordonate dupa numarul de piese",
  model.colorGroups.map((g) => g.colorId + ":" + g.total).join(",") === "1:4,21:3,26:2",
  model.colorGroups.map((g) => g.name + " x" + g.total).join(", "));
check("formele unice per culoare",
  model.colorGroups.every((g) => g.unique === 1),
  model.colorGroups.map((g) => g.unique).join(","));
check("numele culorii vine din tabelul Mecabricks",
  model.colorGroups.find((g) => g.colorId === 26).name.toLowerCase().includes("black"),
  model.colorGroups.map((g) => g.colorId + "=" + g.name).join(", "));

console.log("\n== 3. detectarea scarii din pasul stud-urilor ==");
const ds = model.detectedScale;
check("pas detectat = 0.8 u", Math.abs(ds.pitch - STUD) < 1e-6, ds.pitch);
check("scara = 10 mm/unitate", Math.abs(ds.scale - 10) < 1e-9, ds.scale);

console.log("\n== 4. geometrie: volum si dimensiuni reale ==");
const brick = model.shapeList.find((s) => s.partId === 3001);
// 3.2 x 0.96 x 1.6 corp + 8 stud-uri de 0.48 x 0.17 x 0.48
const expected = 3.2 * 0.96 * 1.6 + 8 * (0.48 * 0.17 * 0.48);
check("volum 2x4 corect", Math.abs(brick.volume - expected) < 1e-6, brick.volume.toFixed(6) + " vs " + expected.toFixed(6));
const wt = E.makeWorldTransform(model, { scale: ds.scale, sizeFactor: 1, zUp: true, dropToBed: true });
const baked = E.bakeSinglePiece(brick.tris, wt);
check("2x4 masoara 32 x 16 x 11.3 mm (Z sus)",
  Math.abs(baked.size[0] - 32) < .01 && Math.abs(baked.size[1] - 16) < .01 && Math.abs(baked.size[2] - 11.3) < .01,
  baked.size.map((n) => n.toFixed(2)).join(" x "));

console.log("\n== 5. logo-urile schimba geometria doar cand sunt cerute ==");
const withLogos = await E.loadModel(zmbxBuf, { includeLogos: true }, () => {});
check("cu logo -> mai multe triunghiuri",
  withLogos.stats.triCount > model.stats.triCount,
  model.stats.triCount + " -> " + withLogos.stats.triCount);

console.log("\n== 6. buildPackage ==");
const res = await P.buildPackage(model, {
  setCode: "10300", scale: ds.scale, sizeFactor: 1, infillPct: 20,
  zUp: true, dropToBed: true, includeLogos: false,
  perPiece: true, perColorMerged: true, full3mf: true
}, () => {});
const zipPath = path.join(OUT, res.fileName);
fs.writeFileSync(zipPath, Buffer.from(await res.blob.arrayBuffer()));
check("nume arhiva", res.fileName === "10300_piese-pe-culori.zip", res.fileName);
check("fara observatii de eroare", res.notes.length === 0, JSON.stringify(res.notes));
console.log("  arhiva: " + zipPath + "  (" + (res.blob.size / 1024).toFixed(1) + " KB)");

console.log("\n== 7. arhiva recitita de propriul cititor ==");
const files = await Z.readZip(fs.readFileSync(zipPath).buffer.slice(0));
const names = Object.keys(files).sort();
check("contine CITESTE-MA.txt", names.includes("10300/CITESTE-MA.txt"));
check("contine inventar.csv", names.includes("10300/inventar.csv"));
check("contine ghid-culori.html", names.includes("10300/ghid-culori.html"));
check("contine model-complet.3mf", names.includes("10300/model-complet.3mf"));
check("3 foldere de culoare",
  new Set(names.filter((n) => n.startsWith("10300/culori/")).map((n) => n.split("/")[2])).size === 3);
const stlNames = names.filter((n) => /\.stl$/.test(n));
// 3 combinatii forma-culoare -> 3 STL de piesa, plus 3 STL "toate piesele culorii"
check("3 STL de piesa + 3 STL de culoare", stlNames.length === 6, stlNames.length);
check("cantitatea apare in numele fisierului",
  stlNames.some((n) => /3001_Brick-2x4_x3\.stl$/.test(n)),
  stlNames.map((n) => path.basename(n)).join(", "));

console.log("\n== 8. STL binar valid ==");
const stlPath = stlNames.find((n) => /3001_Brick-2x4_x3\.stl$/.test(n));
const stl = await files[stlPath].read();
const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
const nTri = dv.getUint32(80, true);
check("dimensiune = 84 + 50*nTri", stl.length === 84 + nTri * 50, stl.length + " / " + nTri + " triunghiuri");
check("nTri = corp(12) + 8 stud-uri(12)", nTri === 12 + 8 * 12, nTri);
// bounding box din STL
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nTri; i++) {
  for (let v = 0; v < 3; v++) {
    for (let k = 0; k < 3; k++) {
      const val = dv.getFloat32(84 + i * 50 + 12 + v * 12 + k * 4, true);
      if (val < mn[k]) mn[k] = val;
      if (val > mx[k]) mx[k] = val;
    }
  }
}
check("STL in mm, asezat pe pat (Zmin = 0)", Math.abs(mn[2]) < 1e-4, mn[2]);
check("STL centrat pe XY", Math.abs(mn[0] + mx[0]) < 1e-3 && Math.abs(mn[1] + mx[1]) < 1e-3);
check("STL 32 x 16 x 11.3 mm",
  Math.abs(mx[0] - mn[0] - 32) < .01 && Math.abs(mx[1] - mn[1] - 16) < .01 && Math.abs(mx[2] - mn[2] - 11.3) < .01,
  [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]].map((n) => n.toFixed(2)).join(" x "));

console.log("\n== 9. inventar CSV ==");
const csv = new TextDecoder().decode(await files["10300/inventar.csv"].read()).trim().split("\n");
check("antet sep= pentru Excel", csv[0] === "sep=;");
check("3 randuri de date (cate o combinatie forma-culoare)", csv.length === 5, csv.length - 2);
const totalBuc = csv.slice(2).reduce((a, l) => a + Number(l.split(";")[6]), 0);
check("suma cantitatilor = 9 piese", totalBuc === 9, totalBuc);

console.log("\n== 10. 3MF valid ==");
const mf = await files["10300/model-complet.3mf"].read();
const mfFiles = await Z.readZip(mf.buffer.slice(mf.byteOffset, mf.byteOffset + mf.byteLength));
check("3MF contine [Content_Types].xml", !!mfFiles["[Content_Types].xml"]);
check("3MF contine _rels/.rels", !!mfFiles["_rels/.rels"]);
const modelXml = new TextDecoder().decode(await mfFiles["3D/3dmodel.model"].read());
check("3MF in milimetri", modelXml.includes('unit="millimeter"'));
check("3MF are 3 materiale colorate", (modelXml.match(/<base /g) || []).length === 3);
check("3MF are 3 obiecte + 3 items",
  (modelXml.match(/<object /g) || []).length === 3 && (modelXml.match(/<item /g) || []).length === 3);
check("3MF contine varfuri si triunghiuri", modelXml.includes("<vertex ") && modelXml.includes("<triangle "));

console.log("\n== 11. optiuni: doar STL per piesa, marire 2x ==");
const res2 = await P.buildPackage(model, {
  setCode: "test-2x", scale: ds.scale, sizeFactor: 2, infillPct: 20,
  zUp: true, dropToBed: true, perPiece: true, perColorMerged: false, full3mf: false
}, () => {});
const f2 = await Z.readZip(await res2.blob.arrayBuffer());
const stl2 = Object.keys(f2).filter((n) => /\.stl$/.test(n));
check("doar cele 3 STL-uri de piesa", stl2.length === 3, stl2.length);
check("fara 3MF", !Object.keys(f2).some((n) => /\.3mf$/.test(n)));
const b2 = await f2[stl2.find((n) => /3001_Brick-2x4_x3\.stl$/.test(n))].read();
const dv2 = new DataView(b2.buffer, b2.byteOffset, b2.byteLength);
let xmin = Infinity, xmax = -Infinity;
const n2 = dv2.getUint32(80, true);
for (let i = 0; i < n2; i++) for (let v = 0; v < 3; v++) {
  const val = dv2.getFloat32(84 + i * 50 + 12 + v * 12, true);
  if (val < xmin) xmin = val; if (val > xmax) xmax = val;
}
check("la 2x, 2x4 are 64 mm", Math.abs(xmax - xmin - 64) < .01, (xmax - xmin).toFixed(2));

console.log("\n== 12. .mbx necomprimat (JSON brut) ==");
const rawModel = await E.loadModel(new TextEncoder().encode(JSON.stringify(mbx)).buffer, {}, () => {});
check("acelasi numar de piese", rawModel.stats.parts === 9, rawModel.stats.parts);

console.log("\nFisiere de test in: " + OUT);
console.log("\n" + (failures ? `${failures} verificari au esuat` : "Toate verificarile au trecut."));
process.exit(failures ? 1 : 0);
