/* pack.js — construieste arhiva ZIP finala: STL-uri grupate pe culori,
   inventar CSV, ghid de culori HTML si (optional) un 3MF colorat. */
(function (root) {
  "use strict";

  var E = root.BrickEngine, Z = root.MBZip;

  function fmt(n, d) { return Number(n).toFixed(d === undefined ? 1 : d); }
  function nowStamp() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
           p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* Estimare grosiera de material: peretii+capacele consuma ~40% din volumul
     solid, restul se umple cu procentul de infill ales in slicer. */
  function materialFactor(infillPct) {
    var shell = 0.40;
    return shell + (1 - shell) * (Math.max(0, Math.min(100, infillPct)) / 100);
  }

  function grams(volMm3) { return (volMm3 / 1000) * E.PLA_DENSITY; }

  function uniqueName(used, base, ext) {
    var name = base + ext, i = 2;
    while (used[name]) { name = base + "__" + i + ext; i++; }
    used[name] = true;
    return name;
  }

  async function buildPackage(model, opt, onProgress) {
    onProgress = onProgress || function () {};
    var wt = E.makeWorldTransform(model, opt);
    var s3 = Math.pow(wt.scale, 3);
    var setId = E.slug(opt.setCode || "set-lego");
    var rootDir = setId + "/";
    var zip = new Z.ZipWriter();

    var infill = opt.infillPct === undefined ? 20 : opt.infillPct;
    var mf = materialFactor(infill);

    var csv = ["sep=;", "rang;id_culoare;nume_culoare;hex;id_piesa;nume_piesa;bucati;dimensiune_mm;volum_buc_cm3;fisier"];
    var guideRows = [];
    var mergedFor3mf = [];
    var totalVol = 0, totalPieces = 0, notes = [];

    for (var gi = 0; gi < model.colorGroups.length; gi++) {
      var g = model.colorGroups[gi];
      var rank = E.pad(gi + 1, 2);
      var dirName = rank + "_C" + g.colorId + "_" + E.slug(g.name);
      var dir = rootDir + "culori/" + dirName + "/";
      var used = Object.create(null);

      onProgress({
        phase: "export",
        text: "Se scriu piesele: " + g.name + " (" + g.total + " buc)",
        done: gi, total: model.colorGroups.length
      });

      var groupVol = 0, lines = [];
      var shapeKeys = Object.keys(g.shapes).sort(function (a, b) {
        return g.shapes[b] - g.shapes[a];
      });

      for (var si = 0; si < shapeKeys.length; si++) {
        var sk = shapeKeys[si];
        var shape = model.shapes[sk];
        var qty = g.shapes[sk];
        var volMm3 = shape.volume * s3;
        groupVol += volMm3 * qty;
        totalPieces += qty;

        var baked = E.bakeSinglePiece(shape.tris, wt);
        var dims = fmt(baked.size[0]) + "x" + fmt(baked.size[1]) + "x" + fmt(baked.size[2]);
        var base = shape.partId + "_" + E.slug(shape.name) + "_x" + qty;
        var file = uniqueName(used, base, ".stl");

        if (opt.perPiece !== false) {
          await zip.add(dir + file,
            E.writeStl(baked.tris, shape.partId + " x" + qty + " " + g.name),
            { compress: true });
        }

        csv.push([rank, g.colorId, g.name, g.hex, shape.partId, shape.name, qty,
                  dims, fmt(volMm3 / 1000, 3), "culori/" + dirName + "/" + file].join(";"));
        lines.push("  " + String(qty).padStart(4) + " x  piesa " + shape.partId +
                   "  (" + shape.name + ")  " + dims + " mm  ->  " + file);
      }

      totalVol += groupVol;

      // fisa culorii
      var solidG = grams(groupVol), estG = solidG * mf;
      await zip.add(dir + "_CULOARE.txt",
        "CULOARE MECABRICKS #" + g.colorId + " — " + g.name + "\n" +
        "=".repeat(60) + "\n" +
        "Cod HEX filament:     " + g.hex.toUpperCase() + "\n" +
        "Tip material LEGO:    " + g.type + (g.alpha < 100 ? " (transparent, " + g.alpha + "% opacitate)" : "") + "\n" +
        "Piese in aceasta culoare: " + g.total + (g.total === 1 ? " bucata, " : " bucati, ") +
          g.unique + (g.unique === 1 ? " forma diferita\n" : " forme diferite\n") +
        "Volum solid total:    " + fmt(groupVol / 1000, 2) + " cm3  (~" + fmt(solidG) + " g PLA la 100%)\n" +
        "Estimare la " + infill + "% umplere: ~" + fmt(estG) + " g PLA\n\n" +
        "PIESE (cantitatea este in numele fisierului, ex. _x12 = 12 bucati):\n" + lines.join("\n") + "\n");

      guideRows.push({
        rank: rank, id: g.colorId, name: g.name, hex: g.hex, type: g.type, alpha: g.alpha,
        total: g.total, unique: g.unique, dir: dirName,
        volCm3: groupVol / 1000, solidG: solidG, estG: estG
      });

      // STL unic pe culoare, cu piesele in pozitia lor din model
      if (opt.perColorMerged) {
        try {
          var floats = g.triCount * 9;
          var merged = new Float32Array(floats), off = 0;
          for (var ii = 0; ii < model.instances.length; ii++) {
            var inst = model.instances[ii];
            if (inst.colorId !== g.colorId) continue;
            off = E.bakeInstance(model.shapes[inst.shapeKey].tris, inst.matrix, wt, merged, off);
          }
          await zip.add(dir + "_TOATE_" + E.slug(g.name) + ".stl",
            E.writeStl(merged, "toate piesele " + g.name), { compress: true });
          if (opt.full3mf) mergedFor3mf.push({ name: g.name, hex: g.hex, alpha: g.alpha, tris: merged });
        } catch (err) {
          notes.push("Grupul de culoare '" + g.name + "' a fost prea mare pentru un STL unic (" +
                     g.triCount + " triunghiuri) si a fost sarit.");
        }
      }
    }

    // 3MF colorat cu tot modelul
    if (opt.full3mf) {
      onProgress({ phase: "export", text: "Se scrie 3MF-ul colorat...", done: model.colorGroups.length, total: model.colorGroups.length });
      try {
        if (!mergedFor3mf.length) {
          for (var ci = 0; ci < model.colorGroups.length; ci++) {
            var cg = model.colorGroups[ci];
            var m2 = new Float32Array(cg.triCount * 9), o2 = 0;
            for (var k2 = 0; k2 < model.instances.length; k2++) {
              var in2 = model.instances[k2];
              if (in2.colorId !== cg.colorId) continue;
              o2 = E.bakeInstance(model.shapes[in2.shapeKey].tris, in2.matrix, wt, m2, o2);
            }
            mergedFor3mf.push({ name: cg.name, hex: cg.hex, alpha: cg.alpha, tris: m2 });
          }
        }
        await E.add3mfTo(zip, rootDir + "model-complet.3mf", E.build3mf(mergedFor3mf));
      } catch (e3) {
        notes.push("3MF-ul complet nu a putut fi generat (model prea mare): " + e3.message);
      }
    }

    // ghidul de culori
    await zip.add(rootDir + "ghid-culori.html", colorGuideHtml(opt, model, guideRows, wt, infill, totalVol));
    await zip.add(rootDir + "inventar.csv", csv.join("\n") + "\n");
    await zip.add(rootDir + "CITESTE-MA.txt", readmeText(opt, model, wt, infill, totalVol, totalPieces, notes));

    onProgress({ phase: "zip", text: "Se finalizeaza arhiva..." });
    return { blob: zip.finish(), fileName: setId + "_piese-pe-culori.zip", notes: notes, transform: wt };
  }

  function readmeText(opt, model, wt, infill, totalVol, totalPieces, notes) {
    var st = model.stats;
    var d = model.detectedScale;
    return [
      "BRICKSPLIT — piese pentru printare 3D, grupate pe culori",
      "=".repeat(64), "",
      "Set:                " + (opt.setCode || "(fara cod)"),
      "Generat:            " + nowStamp(),
      "Sursa geometriei:   export Mecabricks (.zmbx) furnizat de tine",
      "",
      "CONTINUT",
      "-".repeat(64),
      "  culori/            un folder pentru fiecare culoare din set",
      "                     -> cate un .stl pentru fiecare forma de piesa;",
      "                        cantitatea este in nume, ex. 3001_..._x12.stl = 12 buc.",
      "                     -> _CULOARE.txt cu hex-ul filamentului si lista pieselor",
      (opt.perColorMerged ? "                     -> _TOATE_*.stl = toate piesele culorii, in pozitia din model\n" : "") +
      "  inventar.csv       tabel complet (deschide-l in Excel/LibreOffice)",
      "  ghid-culori.html   ghid vizual cu mostre de culoare si necesarul de filament" +
      (opt.full3mf ? "\n  model-complet.3mf  modelul intreg, colorat, pentru slicere multi-material" : ""),
      "",
      "STATISTICI",
      "-".repeat(64),
      "  Piese in model:     " + st.parts + (st.skipped ? "  (" + st.skipped + " sarite: geometrie lipsa in export)" : ""),
      "  Forme diferite:     " + st.uniqueShapes,
      "  Culori:             " + st.colors,
      "  Triunghiuri:        " + st.triCount.toLocaleString("ro-RO"),
      "  Volum solid total:  " + fmt(totalVol / 1000, 1) + " cm3  (~" + fmt(grams(totalVol)) + " g PLA la 100%)",
      "  Estimare la " + infill + "%: ~" + fmt(grams(totalVol) * materialFactor(infill)) + " g PLA",
      "",
      "SCARA",
      "-".repeat(64),
      "  1 unitate Mecabricks = " + fmt(wt.scale, 4) + " mm" +
        (d && d.pitch ? "  (dedus din pasul stud-urilor: " + fmt(d.pitch, 4) + " u = 8 mm)" : ""),
      "  Factor de marire:    x" + (opt.sizeFactor || 1),
      "  Modelul asamblat masoara " + fmt(wt.sizeMm[0]) + " x " + fmt(wt.sizeMm[1]) + " x " + fmt(wt.sizeMm[2]) + " mm",
      "  Toate fisierele sunt in milimetri, cu Z in sus.",
      "",
      "SFATURI DE PRINTARE",
      "-".repeat(64),
      "  - Piesele LEGO au tolerante foarte stranse. La scara 1:1 vei avea nevoie",
      "    de duza 0.2-0.25 mm, strat 0.08-0.12 mm si o imprimanta bine calibrata.",
      "    Daca piesele ies prea stramte, mareste 'horizontal expansion' negativ",
      "    (-0.05 .. -0.1 mm) in slicer.",
      "  - Pentru primele incercari, mareste modelul de 2-3x: e mult mai iertator.",
      "  - Printeaza cate un folder de culoare pe rand, cu filamentul respectiv.",
      "  - Cantitatile sunt in numele fisierului; multiplica obiectul in slicer.",
      "  - Logourile de pe stud-uri " + (opt.includeLogos ? "SUNT incluse" : "NU sunt incluse") +
        " in aceste fisiere.",
      "",
      "UTILIZARE",
      "-".repeat(64),
      "  Aceste fisiere sunt derivate din propriul tau export Mecabricks si sunt",
      "  destinate exclusiv uzului personal, necomercial. Nu le redistribui si nu",
      "  le vinde. LEGO(R) este marca inregistrata a Grupului LEGO, care nu",
      "  sponsorizeaza si nu autorizeaza acest instrument. Geometria pieselor",
      "  apartine Mecabricks si se supune conditiilor de export ale Mecabricks.",
      notes.length ? "\nOBSERVATII\n" + "-".repeat(64) + "\n  - " + notes.join("\n  - ") : ""
    ].join("\n") + "\n";
  }

  function colorGuideHtml(opt, model, rows, wt, infill, totalVol) {
    var cells = rows.map(function (r) {
      return '<tr>' +
        '<td class="sw"><span style="background:' + r.hex + '"></span></td>' +
        '<td><b>' + escapeHtml(r.name) + '</b><br><small>#' + r.id + ' · ' + r.type + '</small></td>' +
        '<td><code>' + r.hex.toUpperCase() + '</code></td>' +
        '<td class="n">' + r.total + '</td>' +
        '<td class="n">' + r.unique + '</td>' +
        '<td class="n">' + fmt(r.volCm3, 1) + '</td>' +
        '<td class="n">' + fmt(r.estG) + '</td>' +
        '<td><code>' + escapeHtml(r.dir) + '</code></td></tr>';
    }).join("\n");

    return '<!DOCTYPE html><html lang="ro"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Ghid culori — ' + escapeHtml(opt.setCode || "set") + '</title><style>' +
      'body{background:#0f0f0f;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:2rem}' +
      'h1{font-size:1.4rem;margin:0 0 .2rem}p.sub{color:#888;margin:0 0 1.5rem}' +
      'table{border-collapse:collapse;width:100%;max-width:1000px}' +
      'th,td{padding:.55rem .7rem;border-bottom:1px solid #262626;text-align:left;vertical-align:middle}' +
      'th{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#888}' +
      'td.n,th.n{text-align:right}small{color:#777}code{color:#bbb}' +
      '.sw span{display:block;width:34px;height:34px;border-radius:4px;border:1px solid #333}' +
      'tfoot td{font-weight:700;border-top:2px solid #333}' +
      '</style></head><body>' +
      '<h1>Ghid de culori — set ' + escapeHtml(opt.setCode || "?") + '</h1>' +
      '<p class="sub">' + model.stats.parts + ' piese · ' + model.stats.colors + ' culori · scara 1 u = ' +
      fmt(wt.scale, 3) + ' mm · estimarile de gramaj sunt pentru PLA la ' + infill + '% umplere</p>' +
      '<table><thead><tr><th></th><th>Culoare</th><th>HEX</th><th class="n">Buc.</th>' +
      '<th class="n">Forme</th><th class="n">cm³</th><th class="n">g PLA</th><th>Folder</th></tr></thead>' +
      '<tbody>' + cells + '</tbody><tfoot><tr><td></td><td>TOTAL</td><td></td>' +
      '<td class="n">' + rows.reduce(function (a, r) { return a + r.total; }, 0) + '</td>' +
      '<td class="n">' + rows.reduce(function (a, r) { return a + r.unique; }, 0) + '</td>' +
      '<td class="n">' + fmt(totalVol / 1000, 1) + '</td>' +
      '<td class="n">' + fmt(grams(totalVol) * materialFactor(infill)) + '</td><td></td></tr></tfoot></table>' +
      '</body></html>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  root.BrickPack = { buildPackage: buildPackage, materialFactor: materialFactor, grams: grams };
})(typeof self !== "undefined" ? self : this);
