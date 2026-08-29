/* mesh.js — ce se face cu plasele dupa ce le-a citit ldraw.js:
   aranjare pe patul imprimantei, scriere STL binar si 3MF, volume si nume de
   fisier. Nu stie nimic despre LDraw sau despre inventare. */
(function (root) {
  "use strict";

  var PLA_DENSITY = 1.24;    // g/cm3

  function slug(s) {
    return String(s).trim()
      .replace(/[‐-―]/g, "-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "piesa";
  }

  function pad(n, w) { return String(n).padStart(w, "0"); }

  // ---------------------------------------------------------------- STL binar

  function writeStl(tris, header) {
    var n = Math.floor(tris.length / 9);
    var buf = new ArrayBuffer(84 + n * 50);
    var dv = new DataView(buf);
    var head = new TextEncoder().encode(String(header || "").slice(0, 79));
    new Uint8Array(buf, 0, 80).set(head.subarray(0, 80));
    dv.setUint32(80, n, true);

    var o = 84;
    for (var i = 0; i < n; i++) {
      var b = i * 9;
      var ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
      var bx = tris[b + 3], by = tris[b + 4], bz = tris[b + 5];
      var cx = tris[b + 6], cy = tris[b + 7], cz = tris[b + 8];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      dv.setFloat32(o, nx / len, true); dv.setFloat32(o + 4, ny / len, true); dv.setFloat32(o + 8, nz / len, true);
      dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
      dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
      dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
      dv.setUint16(o + 48, 0, true);
      o += 50;
    }
    return new Uint8Array(buf);
  }

  function translated(tris, dx, dy, dz) {
    var out = new Float32Array(tris.length);
    for (var i = 0; i < tris.length; i += 3) {
      out[i] = tris[i] + dx; out[i + 1] = tris[i + 1] + dy; out[i + 2] = tris[i + 2] + dz;
    }
    return out;
  }

  function scaled(tris, k) {
    if (k === 1) return tris;
    var out = new Float32Array(tris.length);
    for (var i = 0; i < tris.length; i++) out[i] = tris[i] * k;
    return out;
  }

  // -------------------------------------------------- aranjare pe patul de print

  /* Asaza bucatile in randuri, ca la tipar: umple un rand pe latime, trece la
     randul urmator pe adancime, si incepe o placa noua cand nu mai incape.
     Bucatile vin sortate descrescator dupa adancime, ca randurile sa fie stranse.
     items: [{ key, size:[w,d,h], count }]  ->  [{ index, placements:[{key,x,y}] }] */
  function packPlates(items, plateW, plateD, gap) {
    var units = [];
    for (var i = 0; i < items.length; i++) {
      for (var c = 0; c < items[i].count; c++) {
        units.push({ key: items[i].key, w: items[i].size[0], d: items[i].size[1] });
      }
    }
    units.sort(function (a, b) { return b.d - a.d || b.w - a.w; });

    var plates = [], cur = null, x = gap, y = gap, rowD = 0;

    function newPlate() {
      cur = { index: plates.length + 1, placements: [], used: 0 };
      plates.push(cur);
      x = gap; y = gap; rowD = 0;
    }
    newPlate();

    for (var u = 0; u < units.length; u++) {
      var it = units[u];
      var w = it.w + gap, d = it.d + gap;

      // piesa mai mare decat patul: primeste placa ei si un avertisment
      if (it.w > plateW || it.d > plateD) {
        newPlate();
        cur.placements.push({ key: it.key, x: it.w / 2 + gap, y: it.d / 2 + gap, oversize: true });
        cur.oversize = true;
        newPlate();
        continue;
      }

      if (x + w > plateW + gap) { x = gap; y += rowD; rowD = 0; }   // rand nou
      if (y + d > plateD + gap) { newPlate(); }                      // placa noua

      cur.placements.push({ key: it.key, x: x + it.w / 2, y: y + it.d / 2 });
      cur.used++;
      x += w;
      if (d > rowD) rowD = d;
    }

    return plates.filter(function (p) { return p.placements.length; })
      .map(function (p, i) { p.index = i + 1; return p; });
  }

  // ---------------------------------------------------------------------- 3MF

  function xmlEsc(s) {
    return String(s).replace(/[<>&"']/g, function (c) {
      return ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c];
    });
  }

  function meshXml(tris) {
    var map = new Map(), vx = [], idx = new Int32Array(tris.length / 3), w = 0;
    for (var i = 0; i < tris.length; i += 3) {
      var x = tris[i], y = tris[i + 1], z = tris[i + 2];
      var key = x.toFixed(4) + "," + y.toFixed(4) + "," + z.toFixed(4);
      var id = map.get(key);
      if (id === undefined) { id = vx.length / 3; map.set(key, id); vx.push(x, y, z); }
      idx[w++] = id;
    }
    var vs = [];
    for (var v = 0; v < vx.length; v += 3) {
      vs.push('<vertex x="' + vx[v].toFixed(4) + '" y="' + vx[v + 1].toFixed(4) + '" z="' + vx[v + 2].toFixed(4) + '"/>');
    }
    var ts = [];
    for (var t = 0; t + 2 < idx.length; t += 3) {
      if (idx[t] === idx[t + 1] || idx[t + 1] === idx[t + 2] || idx[t] === idx[t + 2]) continue;
      ts.push('<triangle v1="' + idx[t] + '" v2="' + idx[t + 1] + '" v3="' + idx[t + 2] + '"/>');
    }
    return "<vertices>" + vs.join("") + "</vertices><triangles>" + ts.join("") + "</triangles>";
  }

  /* Un 3MF cu o singura culoare: fiecare forma este un obiect, iar bucatile
     sunt instante asezate pe pat. Geometria nu se dubleaza. */
  function build3mf(colorName, hex, shapes, placements) {
    var objs = [], items = [], objectId = {};
    var id = 2;
    for (var i = 0; i < shapes.length; i++) {
      objectId[shapes[i].key] = id;
      objs.push('<object id="' + id + '" type="model" pid="1" pindex="0"><mesh>' +
                meshXml(shapes[i].tris) + '</mesh></object>');
      id++;
    }
    for (var p = 0; p < placements.length; p++) {
      var pl = placements[p], oid = objectId[pl.key];
      if (!oid) continue;
      items.push('<item objectid="' + oid + '" transform="1 0 0 0 1 0 0 0 1 ' +
                 pl.x.toFixed(3) + " " + pl.y.toFixed(3) + ' 0"/>');
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="en-US" ' +
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      '<metadata name="Application">BRICKSPLIT</metadata>\n' +
      '<metadata name="Title">' + xmlEsc(colorName) + '</metadata>\n' +
      '<resources><basematerials id="1"><base name="' + xmlEsc(colorName) +
      '" displaycolor="' + hex.toUpperCase() + 'FF"/></basematerials>' +
      objs.join("") + '</resources>\n<build>' + items.join("") + '</build>\n</model>\n';
  }

  async function add3mf(zip, pathInZip, xml) {
    var inner = new root.MBZip.ZipWriter();
    await inner.add("[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    await inner.add("_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
    await inner.add("3D/3dmodel.model", xml);
    var blob = inner.finish("model/3mf");
    await zip.add(pathInZip, new Uint8Array(await blob.arrayBuffer()), { compress: false });
  }

  // ------------------------------------------------------------------ material

  /* Estimare grosiera: peretii si capacele consuma ~40% din volumul solid,
     restul se umple cu procentul de infill ales in slicer. */
  function materialFactor(infillPct) {
    var shell = 0.40;
    return shell + (1 - shell) * (Math.max(0, Math.min(100, infillPct)) / 100);
  }

  function grams(volMm3) { return (volMm3 / 1000) * PLA_DENSITY; }

  root.BrickMesh = {
    slug: slug, pad: pad,
    writeStl: writeStl, translated: translated, scaled: scaled,
    packPlates: packPlates,
    build3mf: build3mf, add3mf: add3mf, xmlEsc: xmlEsc,
    materialFactor: materialFactor, grams: grams,
    PLA_DENSITY: PLA_DENSITY
  };
})(typeof self !== "undefined" ? self : this);
