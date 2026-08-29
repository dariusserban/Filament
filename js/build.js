/* build.js — leaga totul: dintr-un numar de set scoate arhiva cu piese.
   Datele (inventare, culori, geometrie LDraw) sunt servite de acelasi site,
   din data/, deci nu se face nicio cerere catre alt domeniu. */
(function (root) {
  "use strict";

  var M = root.BrickMesh, Z = root.MBZip;
  var PARALLEL = 8;          // cate piese se aduc simultan

  function noop() {}

  // ------------------------------------------------------------------ catalog

  var catalog = null;

  async function loadCatalog(base) {
    if (catalog) return catalog;
    var got = await Promise.all([
      fetch(base + "data/sets-index.json").then(function (r) { return r.json(); }),
      fetch(base + "data/colors.json").then(function (r) { return r.json(); }),
      fetch(base + "data/parts.json").then(function (r) { return r.json(); }),
      fetch(base + "data/meta.json").then(function (r) { return r.json(); })
    ]);
    catalog = { index: got[0], colors: got[1], parts: got[2], meta: got[3] };
    return catalog;
  }

  /* Utilizatorul scrie "10300"; Rebrickable numeste setul "10300-1". */
  function resolveSetNum(index, input) {
    var q = String(input || "").trim();
    if (!q) return null;
    if (index[q]) return q;
    if (index[q + "-1"]) return q + "-1";
    var pre = q + "-", best = null;
    for (var k in index) {
      if (k.indexOf(pre) === 0) { if (!best || k < best) best = k; }
    }
    return best;
  }

  /* Cauta dupa nume sau numar, pentru sugestii in interfata. */
  function searchSets(index, query, limit) {
    var q = String(query || "").trim().toLowerCase();
    if (q.length < 2) return [];
    var out = [];
    for (var k in index) {
      var e = index[k];
      if (k.toLowerCase().indexOf(q) === 0 || e[0].toLowerCase().indexOf(q) >= 0) {
        out.push({ setNum: k, name: e[0], year: e[1], total: e[2], missing: e[3] });
        if (out.length > 400) break;
      }
    }
    out.sort(function (a, b) {
      var ax = a.setNum.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      var bx = b.setNum.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return ax - bx || b.total - a.total;
    });
    return out.slice(0, limit || 12);
  }

  // -------------------------------------------------------------- incarcare set

  async function loadSet(base, input, onProgress) {
    onProgress = onProgress || noop;
    onProgress({ phase: "catalog", text: "Se incarca lista de seturi..." });
    var cat = await loadCatalog(base);

    var setNum = resolveSetNum(cat.index, input);
    if (!setNum) {
      throw new Error("Nu gasesc setul \"" + input + "\". Verifica numarul sau cauta dupa nume.");
    }
    var meta = cat.index[setNum];

    onProgress({ phase: "inventory", text: "Se citeste inventarul setului " + setNum + "..." });
    var shard = await fetch(base + "data/sets/" + meta[4] + ".json").then(function (r) { return r.json(); });
    var rows = shard[setNum];
    if (!rows || !rows.length) throw new Error("Setul " + setNum + " nu are inventar utilizabil.");

    // piesele distincte de incarcat
    var need = [];
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var pn = rows[i][0];
      if (!seen[pn]) { seen[pn] = true; need.push(pn); }
    }

    var loader = root.LDraw.createLoader(base + "data/ldraw/");
    var shapes = Object.create(null);
    var failed = [];
    var done = 0;

    onProgress({ phase: "geometry", text: "Se construiesc piesele...", done: 0, total: need.length });

    // se aduc in valuri, ca sa nu deschidem sute de cereri deodata
    for (var s = 0; s < need.length; s += PARALLEL) {
      var batch = need.slice(s, s + PARALLEL);
      var got = await Promise.all(batch.map(async function (pn) {
        var entry = cat.parts[pn];
        if (!entry) return null;
        try {
          var mesh = await loader.partMesh(entry[1]);
          if (!mesh || !mesh.triCount) return null;
          mesh.key = pn;
          mesh.partNum = pn;
          mesh.name = entry[0];
          return mesh;
        } catch (e) { return null; }
      }));
      for (var g = 0; g < got.length; g++) {
        if (got[g]) shapes[got[g].key] = got[g];
        else failed.push(batch[g]);
        done++;
      }
      onProgress({ phase: "geometry", text: "Se construiesc piesele...", done: done, total: need.length });
    }

    // grupare pe culoare
    var byColor = Object.create(null), missing = [], totalPieces = 0, missingPieces = 0;
    for (var r = 0; r < rows.length; r++) {
      var partNum = rows[r][0], colorId = rows[r][1], qty = rows[r][2];
      totalPieces += qty;
      if (!shapes[partNum]) {
        missing.push({ partNum: partNum, colorId: colorId, qty: qty });
        missingPieces += qty;
        continue;
      }
      var grp = byColor[colorId] || (byColor[colorId] = { colorId: colorId, total: 0, shapes: Object.create(null) });
      grp.total += qty;
      grp.shapes[partNum] = (grp.shapes[partNum] || 0) + qty;
    }

    var colorGroups = Object.keys(byColor).map(function (k) {
      var g = byColor[k];
      var c = cat.colors[String(g.colorId)] || { name: "Culoare " + g.colorId, hex: "#9e9e9e", trans: false };
      var tri = 0, vol = 0, uniq = 0;
      for (var sk in g.shapes) {
        uniq++;
        tri += shapes[sk].triCount * g.shapes[sk];
        vol += shapes[sk].volume * g.shapes[sk];
      }
      return {
        colorId: Number(g.colorId), name: c.name, hex: c.hex, trans: !!c.trans,
        total: g.total, unique: uniq, triCount: tri, volume: vol, shapes: g.shapes
      };
    }).sort(function (a, b) { return b.total - a.total || a.colorId - b.colorId; });

    var triTotal = 0;
    for (var t = 0; t < colorGroups.length; t++) triTotal += colorGroups[t].triCount;

    return {
      setNum: setNum,
      name: meta[0], year: meta[1],
      shapes: shapes,
      colorGroups: colorGroups,
      missing: missing,
      colors: cat.colors,
      builtAt: cat.meta.built,
      stats: {
        pieces: totalPieces - missingPieces,
        missing: missingPieces,
        uniqueShapes: Object.keys(shapes).length,
        colors: colorGroups.length,
        triCount: triTotal
      }
    };
  }

  // ------------------------------------------------------------------ aranjare

  /* Placile fiecarei culori, la scara ceruta. */
  function layoutColor(model, group, opt) {
    var k = opt.sizeFactor || 1;
    var items = [];
    for (var key in group.shapes) {
      var sh = model.shapes[key];
      items.push({
        key: key,
        size: [sh.size[0] * k, sh.size[1] * k, sh.size[2] * k],
        count: group.shapes[key]
      });
    }
    return M.packPlates(items, opt.plateW || 250, opt.plateD || 250, opt.gap === undefined ? 3 : opt.gap);
  }

  // -------------------------------------------------------------- previzualizare

  /* Aceleasi date pe care le asteapta viewer.js: formele si matricile
     instantelor. Placile sunt asezate una langa alta, ca sa se vada tot. */
  function previewPayload(model, opt) {
    var k = opt.sizeFactor || 1;
    var plateW = opt.plateW || 250, plateD = opt.plateD || 250;
    var shapes = [], transfer = [], sent = Object.create(null);
    var groups = [];

    // asezam placile intr-o grila cat mai patrata, ca sa incapa bine in cadru
    var all = model.colorGroups.map(function (g) { return layoutColor(model, g, opt); });
    var plateCount = all.reduce(function (a, p) { return a + p.length; }, 0);
    var perRow = Math.max(1, Math.ceil(Math.sqrt(plateCount)));
    var plateIndex = 0, plateOrigins = [];
    var world = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

    for (var ci = 0; ci < model.colorGroups.length; ci++) {
      var g = model.colorGroups[ci];
      var plates = all[ci];
      var buckets = Object.create(null);

      for (var p = 0; p < plates.length; p++) {
        var ox = (plateIndex % perRow) * (plateW + 25);
        var oy = Math.floor(plateIndex / perRow) * (plateD + 25);
        plateIndex++;
        plateOrigins.push([ox, oy]);
        var pl = plates[p].placements;
        for (var i = 0; i < pl.length; i++) {
          (buckets[pl[i].key] || (buckets[pl[i].key] = [])).push([pl[i].x + ox, pl[i].y + oy]);
          if (pl[i].x + ox > world.max[0]) world.max[0] = pl[i].x + ox;
          if (pl[i].x + ox < world.min[0]) world.min[0] = pl[i].x + ox;
        }
        if (oy + plateD > world.max[2]) world.max[2] = oy + plateD;
        if (oy < world.min[2]) world.min[2] = oy;
      }

      for (var key in buckets) {
        if (!sent[key]) {
          sent[key] = true;
          var tris = M.scaled(model.shapes[key].tris, k);
          var copy = tris === model.shapes[key].tris ? tris.slice() : tris;
          shapes.push({ key: key, positions: copy });
          transfer.push(copy.buffer);
        }
        var list = buckets[key];
        var mats = new Float32Array(list.length * 16);
        for (var m = 0; m < list.length; m++) {
          // Z sus (mm) -> Y sus (ce asteapta viewer-ul), plus deplasarea pe pat
          mats.set([
            1, 0, 0, list[m][0],
            0, 0, 1, 0,
            0, -1, 0, -list[m][1],
            0, 0, 0, 1
          ], m * 16);
        }
        groups.push({
          shapeKey: key, colorId: g.colorId, count: list.length,
          hex: g.hex, alpha: g.trans ? 55 : 100, type: g.trans ? "transparent" : "solid",
          matrices: mats
        });
        transfer.push(mats.buffer);
      }
    }

    // un suport subtire sub fiecare placa, ca imaginea sa se citeasca drept
    // "piese asezate pe pat" si nu piese plutind in gol
    if (plateOrigins.length) {
      var slab = plateSlab(plateW, plateD);
      shapes.push({ key: "__placa", positions: slab });
      transfer.push(slab.buffer);
      var pm = new Float32Array(plateOrigins.length * 16);
      for (var s2 = 0; s2 < plateOrigins.length; s2++) {
        var o2 = plateOrigins[s2];
        pm.set([
          1, 0, 0, o2[0] + plateW / 2,
          0, 0, 1, 0,
          0, -1, 0, -(o2[1] + plateD / 2),
          0, 0, 0, 1
        ], s2 * 16);
      }
      groups.push({
        shapeKey: "__placa", colorId: -1, count: plateOrigins.length,
        hex: "#1b1b1b", alpha: 100, type: "solid", matrices: pm
      });
      transfer.push(pm.buffer);

      world.min[0] = 0; world.min[2] = 0;
      for (var o3 = 0; o3 < plateOrigins.length; o3++) {
        world.max[0] = Math.max(world.max[0], plateOrigins[o3][0] + plateW);
        world.max[2] = Math.max(world.max[2], plateOrigins[o3][1] + plateD);
      }
    }

    if (!isFinite(world.min[0])) world = { min: [0, 0, 0], max: [1, 1, 1] };
    world.min[1] = 0; world.max[1] = 40;
    // world foloseste conventia viewer-ului: Y sus, Z catre spate
    var tmp = { min: [world.min[0], 0, -world.max[2]], max: [world.max[0], 40, -world.min[2]] };

    return { payload: { shapes: shapes, groups: groups, world: tmp }, transfer: transfer };
  }

  /* O lespede subtire de marimea patului, folosita doar la previzualizare. */
  function plateSlab(w, d) {
    var h = 1.5, x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h, z1 = 0;
    var v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
    ];
    var f = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
      [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]
    ];
    var out = new Float32Array(f.length * 9), w2 = 0;
    for (var i = 0; i < f.length; i++) {
      for (var c = 0; c < 3; c++) {
        var pt = v[f[i][c]];
        out[w2++] = pt[0]; out[w2++] = pt[1]; out[w2++] = pt[2];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- arhiva

  async function buildPackage(model, opt, onProgress) {
    onProgress = onProgress || noop;
    var k = opt.sizeFactor || 1;
    var infill = opt.infillPct === undefined ? 20 : opt.infillPct;
    var mf = M.materialFactor(infill);
    var rootDir = M.slug(model.setNum) + "/";
    var zip = new Z.ZipWriter();

    var csv = ["sep=;",
      "rang;id_culoare;nume_culoare;hex;id_piesa;nume_piesa;bucati;dimensiune_mm;volum_buc_cm3;fisier"];
    var guide = [], notes = [], totalVol = 0, totalPieces = 0, totalPlates = 0;

    for (var gi = 0; gi < model.colorGroups.length; gi++) {
      var g = model.colorGroups[gi];
      var rank = M.pad(gi + 1, 2);
      var dirName = rank + "_C" + g.colorId + "_" + M.slug(g.name);
      var dir = rootDir + "culori/" + dirName + "/";

      onProgress({
        phase: "export", text: "Se scriu piesele: " + g.name + " (" + g.total + " buc)",
        done: gi, total: model.colorGroups.length
      });

      var groupVol = 0, lines = [], used = Object.create(null);
      var keys = Object.keys(g.shapes).sort(function (a, b) { return g.shapes[b] - g.shapes[a]; });

      for (var si = 0; si < keys.length; si++) {
        var key = keys[si], sh = model.shapes[key], qty = g.shapes[key];
        var vol = sh.volume * k * k * k;
        groupVol += vol * qty;
        totalPieces += qty;

        var dims = (sh.size[0] * k).toFixed(1) + "x" + (sh.size[1] * k).toFixed(1) +
                   "x" + (sh.size[2] * k).toFixed(1);
        var base = sh.partNum + "_" + M.slug(sh.name) + "_x" + qty;
        var file = base + ".stl", n = 2;
        while (used[file]) { file = base + "__" + n + ".stl"; n++; }
        used[file] = true;

        if (opt.perPiece !== false) {
          await zip.add(dir + "piese/" + file,
            M.writeStl(M.scaled(sh.tris, k), sh.partNum + " x" + qty + " " + g.name),
            { compress: true });
        }

        csv.push([rank, g.colorId, g.name, g.hex, sh.partNum, sh.name, qty, dims,
                  (vol / 1000).toFixed(3), "culori/" + dirName + "/piese/" + file].join(";"));
        lines.push("  " + String(qty).padStart(4) + " x  " + sh.partNum +
                   "  (" + sh.name + ")  " + dims + " mm  ->  " + file);
      }

      totalVol += groupVol;

      // placile gata de feliat
      var plates = [];
      if (opt.plates !== false || opt.mf3) {
        plates = layoutColor(model, g, opt);
        totalPlates += plates.length;
      }

      if (opt.plates !== false) {
        for (var pi = 0; pi < plates.length; pi++) {
          var chunks = [], pl = plates[pi].placements;
          for (var q = 0; q < pl.length; q++) {
            var t = M.scaled(model.shapes[pl[q].key].tris, k);
            chunks.push(M.translated(t, pl[q].x, pl[q].y, 0));
          }
          await zip.add(dir + "placi/placa-" + M.pad(plates[pi].index, 2) + ".stl",
            M.writeStl(root.LDraw.concat(chunks), g.name + " placa " + plates[pi].index),
            { compress: true });
          if (plates[pi].oversize) {
            notes.push("La culoarea " + g.name + " o piesa depaseste patul de " +
                       (opt.plateW || 250) + "x" + (opt.plateD || 250) + " mm si a primit o placa separata.");
          }
        }
      }

      if (opt.mf3) {
        var shapeList = keys.map(function (kk) {
          return { key: kk, tris: M.scaled(model.shapes[kk].tris, k) };
        });
        for (var p3 = 0; p3 < plates.length; p3++) {
          await M.add3mf(zip, dir + "placi/placa-" + M.pad(plates[p3].index, 2) + ".3mf",
            M.build3mf(g.name, g.hex, shapeList, plates[p3].placements));
        }
      }

      var solidG = M.grams(groupVol), estG = solidG * mf;
      await zip.add(dir + "_CULOARE.txt",
        "CULOARE " + g.name + "  (Rebrickable #" + g.colorId + ")\n" +
        "=".repeat(60) + "\n" +
        "Cod HEX filament:     " + g.hex.toUpperCase() + (g.trans ? "  (transparent)" : "") + "\n" +
        "Piese in aceasta culoare: " + g.total + (g.total === 1 ? " bucata, " : " bucati, ") +
          g.unique + (g.unique === 1 ? " forma diferita\n" : " forme diferite\n") +
        "Placi de printat:     " + plates.length + "\n" +
        "Volum solid total:    " + (groupVol / 1000).toFixed(2) + " cm3  (~" + solidG.toFixed(1) + " g PLA la 100%)\n" +
        "Estimare la " + infill + "% umplere: ~" + estG.toFixed(1) + " g PLA\n\n" +
        "PIESE (cantitatea e in numele fisierului, ex. _x12 = 12 bucati):\n" + lines.join("\n") + "\n");

      guide.push({
        rank: rank, id: g.colorId, name: g.name, hex: g.hex, trans: g.trans,
        total: g.total, unique: g.unique, dir: dirName, plates: plates.length,
        volCm3: groupVol / 1000, estG: estG
      });
    }

    if (model.missing.length) {
      var byPart = Object.create(null);
      for (var mi = 0; mi < model.missing.length; mi++) {
        var m2 = model.missing[mi];
        byPart[m2.partNum] = (byPart[m2.partNum] || 0) + m2.qty;
      }
      var ml = Object.keys(byPart).sort().map(function (pn) {
        return "  " + String(byPart[pn]).padStart(4) + " x  " + pn;
      });
      await zip.add(rootDir + "piese-fara-geometrie.txt",
        "Piese din set pentru care biblioteca LDraw nu are un model 3D\n" +
        "=".repeat(60) + "\n\n" +
        "Sunt in general autocolante, piese textile, cabluri, componente\n" +
        "electrice si piese de minifigurina cu imprimeu unic. Nu se pot printa\n" +
        "oricum din plastic obisnuit.\n\n" +
        model.stats.missing + " bucati, " + Object.keys(byPart).length + " tipuri:\n\n" +
        ml.join("\n") + "\n");
    }

    onProgress({ phase: "export", text: "Se scriu inventarul si ghidul...", done: model.colorGroups.length, total: model.colorGroups.length });

    await zip.add(rootDir + "inventar.csv", csv.join("\n") + "\n");
    await zip.add(rootDir + "ghid-culori.html", guideHtml(model, opt, guide, infill, totalVol));
    await zip.add(rootDir + "CITESTE-MA.txt",
      readme(model, opt, infill, totalVol, totalPieces, totalPlates, notes));

    onProgress({ phase: "zip", text: "Se finalizeaza arhiva..." });
    return {
      blob: zip.finish(),
      fileName: M.slug(model.setNum) + "_piese-pe-culori.zip",
      notes: notes, plates: totalPlates
    };
  }

  function readme(model, opt, infill, totalVol, totalPieces, totalPlates, notes) {
    var k = opt.sizeFactor || 1;
    return [
      "BRICKSPLIT — piesele setului " + model.setNum + ", pe culori",
      "=".repeat(64), "",
      "Set:        " + model.setNum + " — " + model.name + (model.year ? " (" + model.year + ")" : ""),
      "Generat:    " + new Date().toLocaleString("ro-RO"),
      "Baza de date: " + (model.builtAt || "").slice(0, 10),
      "",
      "CONTINUT",
      "-".repeat(64),
      "  culori/<NN>_<culoare>/",
      "     piese/     cate un .stl pentru fiecare forma; cantitatea e in nume",
      "                (3001_Brick-2-x-4_x12.stl = 12 bucati)",
      "     placi/     piesele deja asezate pe patul imprimantei, gata de feliat",
      "     _CULOARE.txt   hex-ul filamentului, lista pieselor, gramaj estimat",
      "  inventar.csv       tabelul complet (Excel / LibreOffice)",
      "  ghid-culori.html   ghid vizual cu mostre si necesarul de filament",
      (model.missing.length ? "  piese-fara-geometrie.txt   ce nu se poate printa si de ce" : ""),
      "",
      "CIFRE",
      "-".repeat(64),
      "  Piese de printat:   " + totalPieces.toLocaleString("ro-RO"),
      "  Forme diferite:     " + model.stats.uniqueShapes.toLocaleString("ro-RO"),
      "  Culori:             " + model.stats.colors,
      "  Placi de printat:   " + totalPlates,
      (model.stats.missing ? "  Fara geometrie:     " + model.stats.missing + " bucati (vezi fisierul separat)" : ""),
      "  Volum solid total:  " + (totalVol / 1000).toFixed(1) + " cm3  (~" + M.grams(totalVol).toFixed(0) + " g PLA la 100%)",
      "  Estimare la " + infill + "%:  ~" + (M.grams(totalVol) * M.materialFactor(infill)).toFixed(0) + " g PLA",
      "",
      "SCARA SI ORIENTARE",
      "-".repeat(64),
      "  Toate fisierele sunt in milimetri, la scara reala LEGO" +
        (k !== 1 ? ", marite de " + k + " ori" : "") + ".",
      "  O unitate LDraw = 0.4 mm; pasul dintre doi stud-uri = 8 mm.",
      "  Piesele au Z in sus si sunt asezate pe planul de printare.",
      "  Patul folosit la aranjare: " + (opt.plateW || 250) + " x " + (opt.plateD || 250) + " mm.",
      "",
      "SFATURI DE PRINTARE",
      "-".repeat(64),
      "  - Piesele LEGO au tolerante foarte stranse. La scara 1:1 ai nevoie de",
      "    duza 0.2-0.25 mm, strat 0.08-0.12 mm si o imprimanta bine calibrata.",
      "    Daca ies prea stramte, pune 'horizontal expansion' negativ",
      "    (-0.05 .. -0.1 mm) in slicer.",
      "  - Pentru primele incercari mareste de 2-3x: e mult mai iertator.",
      "  - Modelele LDraw sunt facute pentru randare, nu pentru printare. La",
      "    unele piese slicerul va repara automat mici erori in plasa; asta e",
      "    normal si nu strica rezultatul.",
      "",
      "SURSE",
      "-".repeat(64),
      "  Inventarele seturilor: Rebrickable (rebrickable.com).",
      "  Geometria pieselor: LDraw Parts Library (ldraw.org), CCAL 2.0.",
      "  Uz personal, necomercial. LEGO(R) este marca inregistrata a Grupului",
      "  LEGO, care nu sponsorizeaza si nu autorizeaza acest instrument.",
      notes.length ? "\nOBSERVATII\n" + "-".repeat(64) + "\n  - " + notes.join("\n  - ") : ""
    ].filter(function (l) { return l !== ""; }).join("\n") + "\n";
  }

  function guideHtml(model, opt, rows, infill, totalVol) {
    var cells = rows.map(function (r) {
      return '<tr><td class="sw"><span style="background:' + r.hex + '"></span></td>' +
        '<td><b>' + M.xmlEsc(r.name) + '</b><br><small>#' + r.id + (r.trans ? ' · transparent' : '') + '</small></td>' +
        '<td><code>' + r.hex.toUpperCase() + '</code></td>' +
        '<td class="n">' + r.total + '</td><td class="n">' + r.unique + '</td>' +
        '<td class="n">' + r.plates + '</td>' +
        '<td class="n">' + r.volCm3.toFixed(1) + '</td>' +
        '<td class="n">' + r.estG.toFixed(0) + '</td>' +
        '<td><code>' + M.xmlEsc(r.dir) + '</code></td></tr>';
    }).join("\n");

    return '<!DOCTYPE html><html lang="ro"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Ghid culori — ' + M.xmlEsc(model.setNum) + '</title><style>' +
      'body{background:#0f0f0f;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:2rem}' +
      'h1{font-size:1.4rem;margin:0 0 .2rem}p.sub{color:#888;margin:0 0 1.5rem}' +
      'table{border-collapse:collapse;width:100%;max-width:1100px}' +
      'th,td{padding:.55rem .7rem;border-bottom:1px solid #262626;text-align:left;vertical-align:middle}' +
      'th{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#888}' +
      'td.n,th.n{text-align:right}small{color:#777}code{color:#bbb}' +
      '.sw span{display:block;width:34px;height:34px;border-radius:4px;border:1px solid #333}' +
      'tfoot td{font-weight:700;border-top:2px solid #333}</style></head><body>' +
      '<h1>' + M.xmlEsc(model.setNum) + ' — ' + M.xmlEsc(model.name) + '</h1>' +
      '<p class="sub">' + model.stats.pieces.toLocaleString("ro-RO") + ' piese · ' +
      model.stats.colors + ' culori · gramaje pentru PLA la ' + infill + '% umplere</p>' +
      '<table><thead><tr><th></th><th>Culoare</th><th>HEX</th><th class="n">Buc.</th>' +
      '<th class="n">Forme</th><th class="n">Placi</th><th class="n">cm³</th>' +
      '<th class="n">g PLA</th><th>Folder</th></tr></thead><tbody>' + cells + '</tbody>' +
      '<tfoot><tr><td></td><td>TOTAL</td><td></td><td class="n">' +
      rows.reduce(function (a, r) { return a + r.total; }, 0) + '</td><td class="n">' +
      rows.reduce(function (a, r) { return a + r.unique; }, 0) + '</td><td class="n">' +
      rows.reduce(function (a, r) { return a + r.plates; }, 0) + '</td><td class="n">' +
      (totalVol / 1000).toFixed(1) + '</td><td class="n">' +
      (M.grams(totalVol) * M.materialFactor(infill)).toFixed(0) + '</td><td></td></tr></tfoot>' +
      '</table></body></html>';
  }

  root.BrickBuild = {
    loadCatalog: loadCatalog,
    loadSet: loadSet,
    buildPackage: buildPackage,
    previewPayload: previewPayload,
    searchSets: searchSets,
    resolveSetNum: resolveSetNum
  };
})(typeof self !== "undefined" ? self : this);
