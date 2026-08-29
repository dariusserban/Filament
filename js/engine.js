/* engine.js — parseaza un export Mecabricks (.zmbx / .mbx), reconstruieste
   geometria pieselor, le grupeaza pe culori si scrie STL / 3MF / ZIP.
   Totul ruleaza local, in browser. Nu se face niciun apel catre Mecabricks.

   Structura formatului .mbx (JSON in interiorul .zmbx, la "scene.mbx"):
     parts[]            -> { id, version, configuration, matrix[16], material.base[0] }
     configurations[v]  -> { version, name, geometry:{ file, extras:{knobs,tubes,pins,logos} } }
     geometries[v][f]   -> { vertices[], faces[], normals[], uvs[][] }
     details.{logos,knobs,tubes,pins}[type] -> geometrie
   Descrierea campurilor urmeaza zmbx2gltf (MIT, (c) 2023 Ilia Pozdnyakov). */
(function (root) {
  "use strict";

  var FACE_QUAD = 0x01, FACE_MATERIAL = 0x02, FACE_UVS = 0x08,
      FACE_NORMALS = 0x20, FACE_COLORS = 0x80;

  var STUD_PITCH_MM = 8.0;   // pasul dintre doi stud-uri LEGO, in mm (constanta reala)
  var PLA_DENSITY = 1.24;    // g/cm3

  // ---------------------------------------------------------------- utilitare

  function noop() {}

  function slug(s) {
    return String(s).trim()
      .replace(/[‐-―]/g, "-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "fara-nume";
  }

  function pad(n, w) { return String(n).padStart(w, "0"); }

  function colorInfo(id) {
    var table = root.MB_COLORS || {};
    var c = table[String(id)];
    if (c) return { id: id, name: c[0], type: c[1], hex: c[2], alpha: c[3] };
    return { id: id, name: "Culoare " + id, type: "solid", hex: "#9e9e9e", alpha: 100 };
  }

  // ------------------------------------------------------- citirea fisierului

  async function readMbxJson(arrayBuffer) {
    var head = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength));
    var isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (!isZip) {
      var txt = new TextDecoder().decode(new Uint8Array(arrayBuffer));
      return JSON.parse(txt);
    }
    var files = await root.MBZip.readZip(arrayBuffer);
    var entry = files["scene.mbx"];
    if (!entry) {
      var names = Object.keys(files).filter(function (n) { return /\.mbx$/i.test(n); });
      if (!names.length) {
        throw new Error("Arhiva nu contine 'scene.mbx'. Asigura-te ca este un export .zmbx din Mecabricks.");
      }
      entry = files[names[0]];
    }
    return JSON.parse(new TextDecoder().decode(await entry.read()));
  }

  // --------------------------------------------------------- decodare geometrie

  /* Transforma lista de fete Mecabricks intr-un sir de triunghiuri (9 float/triunghi). */
  function decodeGeometry(geom) {
    var faces = geom.faces || [];
    var verts = geom.vertices || [];
    var uvLayers = geom.uvs ? geom.uvs.length : 0;

    // prima trecere: numara triunghiurile
    var off = 0, triCount = 0, flags, n;
    while (off < faces.length) {
      flags = faces[off++];
      n = (flags & FACE_QUAD) ? 4 : 3;
      triCount += (flags & FACE_QUAD) ? 2 : 1;
      off += n;
      if (flags & FACE_MATERIAL) off += 1;
      if (flags & FACE_UVS) off += n * uvLayers;
      if (flags & FACE_NORMALS) off += n;
      if (flags & FACE_COLORS) off += n;
    }

    var out = new Float32Array(triCount * 9);
    var w = 0;
    function put(vi) {
      var b = vi * 3;
      out[w++] = verts[b]; out[w++] = verts[b + 1]; out[w++] = verts[b + 2];
    }

    off = 0;
    while (off < faces.length) {
      flags = faces[off++];
      var quad = !!(flags & FACE_QUAD);
      n = quad ? 4 : 3;
      var a = faces[off], b2 = faces[off + 1], c = faces[off + 2], d = quad ? faces[off + 3] : 0;
      off += n;
      if (flags & FACE_MATERIAL) off += 1;
      if (flags & FACE_UVS) off += n * uvLayers;
      if (flags & FACE_NORMALS) off += n;
      if (flags & FACE_COLORS) off += n;

      put(a); put(b2); put(c);
      if (quad) { put(c); put(d); put(a); }
    }
    return out;
  }

  /* Compune o matrice 4x4 (row-major) dintr-o pozitie + quaternion [x,y,z,w]. */
  function trsMatrix(t) {
    var p = t.position || [0, 0, 0];
    var q = t.quaternion || [0, 0, 0, 1];
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      1 - (yy + zz), xy - wz, xz + wy, p[0],
      xy + wz, 1 - (xx + zz), yz - wx, p[1],
      xz - wy, yz + wx, 1 - (xx + yy), p[2],
      0, 0, 0, 1
    ];
  }

  function applyMatrixInPlace(tris, m) {
    for (var i = 0; i < tris.length; i += 3) {
      var x = tris[i], y = tris[i + 1], z = tris[i + 2];
      tris[i]     = m[0] * x + m[1] * y + m[2] * z + m[3];
      tris[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      tris[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
    return tris;
  }

  function concatF32(chunks) {
    if (chunks.length === 1) return chunks[0];
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function bboxOf(tris) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < tris.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var v = tris[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    if (!isFinite(mn[0])) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
    return { min: mn, max: mx };
  }

  /* Volum semnat al plasei (unitati^3). Piesele Mecabricks sunt inchise. */
  function meshVolume(tris) {
    var v = 0;
    for (var i = 0; i < tris.length; i += 9) {
      var ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      var bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      var cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx));
    }
    return Math.abs(v) / 6;
  }

  // ------------------------------------------- calibrarea scarii din stud-uri

  /* Distanta dintre doi stud-uri vecini este, in realitate, exact 8 mm.
     Cautam distanta cea mai frecventa intre knob-urile fiecarei configuratii
     si deducem cate mm reprezinta o unitate Mecabricks. */
  function detectScale(mbx) {
    var hist = Object.create(null), best = null, bestN = 0;
    var versions = Object.keys(mbx.configurations || {});
    for (var vi = 0; vi < versions.length; vi++) {
      var cfgs = mbx.configurations[versions[vi]];
      for (var name in cfgs) {
        var knobs = cfgs[name] && cfgs[name].geometry && cfgs[name].geometry.extras
          ? cfgs[name].geometry.extras.knobs : null;
        if (!knobs || knobs.length < 2) continue;
        for (var i = 0; i < knobs.length; i++) {
          var pi = knobs[i].transform.position, near = Infinity;
          for (var j = 0; j < knobs.length; j++) {
            if (i === j) continue;
            var pj = knobs[j].transform.position;
            var dx = pi[0] - pj[0], dy = pi[1] - pj[1], dz = pi[2] - pj[2];
            var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > 1e-6 && d < near) near = d;
          }
          if (!isFinite(near)) continue;
          var key = near.toFixed(3);
          hist[key] = (hist[key] || 0) + 1;
          if (hist[key] > bestN) { bestN = hist[key]; best = parseFloat(key); }
        }
      }
    }
    if (!best || best <= 0) return { scale: 10, confident: false, samples: 0, pitch: null };
    var scale = STUD_PITCH_MM / best;
    if (!(scale > 0.1 && scale < 1000)) return { scale: 10, confident: false, samples: bestN, pitch: best };
    return { scale: scale, confident: bestN >= 8, samples: bestN, pitch: best };
  }

  // ------------------------------------------------------------ incarcare model

  async function loadModel(arrayBuffer, opts, onProgress) {
    opts = opts || {};
    onProgress = onProgress || noop;

    onProgress({ phase: "unzip", text: "Se despacheteaza exportul Mecabricks..." });
    var mbx = await readMbxJson(arrayBuffer);

    if (!mbx || !Array.isArray(mbx.parts) || !mbx.configurations || !mbx.geometries) {
      throw new Error("JSON-ul .mbx nu are structura asteptata (lipsesc parts/configurations/geometries).");
    }

    var includeLogos = !!opts.includeLogos;
    var detected = detectScale(mbx);

    onProgress({ phase: "geometry", text: "Se reconstruiesc formele pieselor...", done: 0, total: mbx.parts.length });

    var detailCache = Object.create(null);
    function detailTris(kind, type) {
      var k = kind + ":" + type;
      if (detailCache[k]) return detailCache[k];
      var g = mbx.details && mbx.details[kind] ? mbx.details[kind][type] : null;
      var tris = g ? decodeGeometry(g) : new Float32Array(0);
      detailCache[k] = tris;
      return tris;
    }

    var shapes = Object.create(null);   // shapeKey -> shape
    var shapeList = [];

    function getShape(part) {
      var key = part.version + "|" + part.configuration;
      if (shapes[key]) return shapes[key];

      var cfgSet = mbx.configurations[part.version];
      var cfg = cfgSet ? cfgSet[part.configuration] : null;
      if (!cfg) return null;

      var geomSet = mbx.geometries[cfg.version];
      var main = geomSet ? geomSet[cfg.geometry.file] : null;
      if (!main) return null;

      var chunks = [decodeGeometry(main)];
      var extras = cfg.geometry.extras || {};
      var kinds = ["knobs", "tubes", "pins"];
      if (includeLogos) kinds.push("logos");
      for (var ki = 0; ki < kinds.length; ki++) {
        var kind = kinds[ki], list = extras[kind] || [];
        for (var ei = 0; ei < list.length; ei++) {
          var src = detailTris(kind, list[ei].type);
          if (!src.length) continue;
          chunks.push(applyMatrixInPlace(src.slice(), trsMatrix(list[ei].transform)));
        }
      }

      var tris = concatF32(chunks);
      var shape = {
        key: key,
        partId: part.id,
        name: cfg.name || String(part.id),
        tris: tris,
        triCount: tris.length / 9,
        bbox: bboxOf(tris),
        volume: meshVolume(tris)
      };
      shapes[key] = shape;
      shapeList.push(shape);
      return shape;
    }

    var instances = [];   // {shapeKey, colorId, matrix}
    var skipped = 0;
    var world = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

    for (var pi2 = 0; pi2 < mbx.parts.length; pi2++) {
      var part = mbx.parts[pi2];
      var shape = getShape(part);
      if (!shape || !shape.tris.length) { skipped++; continue; }

      var colorId = (part.material && part.material.base && part.material.base.length)
        ? part.material.base[0] : 0;
      var m = part.matrix;
      instances.push({ shapeKey: shape.key, colorId: colorId, matrix: m });

      // extinde bbox-ul global folosind cele 8 colturi ale bbox-ului local
      var bb = shape.bbox;
      for (var c8 = 0; c8 < 8; c8++) {
        var lx = (c8 & 1) ? bb.max[0] : bb.min[0];
        var ly = (c8 & 2) ? bb.max[1] : bb.min[1];
        var lz = (c8 & 4) ? bb.max[2] : bb.min[2];
        var wx = m[0] * lx + m[1] * ly + m[2] * lz + m[3];
        var wy = m[4] * lx + m[5] * ly + m[6] * lz + m[7];
        var wz = m[8] * lx + m[9] * ly + m[10] * lz + m[11];
        if (wx < world.min[0]) world.min[0] = wx; if (wx > world.max[0]) world.max[0] = wx;
        if (wy < world.min[1]) world.min[1] = wy; if (wy > world.max[1]) world.max[1] = wy;
        if (wz < world.min[2]) world.min[2] = wz; if (wz > world.max[2]) world.max[2] = wz;
      }

      if ((pi2 & 255) === 0) {
        onProgress({ phase: "geometry", text: "Se reconstruiesc formele pieselor...", done: pi2, total: mbx.parts.length });
      }
    }

    if (!instances.length) throw new Error("Nu s-a putut reconstrui nicio piesa din acest fisier.");
    if (!isFinite(world.min[0])) world = { min: [0, 0, 0], max: [0, 0, 0] };

    // grupare pe culoare -> forma
    var byColor = Object.create(null);
    for (var ii = 0; ii < instances.length; ii++) {
      var inst = instances[ii];
      var g = byColor[inst.colorId] || (byColor[inst.colorId] = { colorId: inst.colorId, total: 0, shapes: Object.create(null) });
      g.total++;
      g.shapes[inst.shapeKey] = (g.shapes[inst.shapeKey] || 0) + 1;
    }

    var colorGroups = Object.keys(byColor).map(function (k) {
      var g = byColor[k], info = colorInfo(g.colorId);
      var uniq = Object.keys(g.shapes).length, tri = 0, vol = 0;
      for (var sk in g.shapes) {
        var s = shapes[sk];
        tri += s.triCount * g.shapes[sk];
        vol += s.volume * g.shapes[sk];
      }
      return {
        colorId: g.colorId, name: info.name, hex: info.hex, type: info.type, alpha: info.alpha,
        total: g.total, unique: uniq, triCount: tri, volumeUnits3: vol, shapes: g.shapes
      };
    }).sort(function (a, b) { return b.total - a.total || a.colorId - b.colorId; });

    var totalTris = 0;
    for (var si = 0; si < colorGroups.length; si++) totalTris += colorGroups[si].triCount;

    return {
      mbxMeta: mbx.metadata || null,
      shapes: shapes,
      shapeList: shapeList,
      instances: instances,
      colorGroups: colorGroups,
      world: world,
      detectedScale: detected,
      stats: {
        parts: instances.length,
        skipped: skipped,
        uniqueShapes: shapeList.length,
        colors: colorGroups.length,
        triCount: totalTris
      }
    };
  }

  // ------------------------------------------------------------- scriere STL

  /* tris: Float32Array cu 9 float/triunghi, deja in mm si in sistemul final. */
  function writeStl(tris, headerText) {
    var n = Math.floor(tris.length / 9);
    var buf = new ArrayBuffer(84 + n * 50);
    var dv = new DataView(buf);
    var head = new TextEncoder().encode(("BRICKSPLIT " + (headerText || "")).slice(0, 79));
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

  // ------------------------------------------------------------- scriere 3MF

  function meshToXml(tris) {
    var map = new Map();
    var vx = [], idx = new Int32Array(tris.length / 3);
    var w = 0;
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
      if (idx[t] === idx[t + 1] || idx[t + 1] === idx[t + 2] || idx[t] === idx[t + 2]) continue; // triunghi degenerat
      ts.push('<triangle v1="' + idx[t] + '" v2="' + idx[t + 1] + '" v3="' + idx[t + 2] + '"/>');
    }
    return "<vertices>" + vs.join("") + "</vertices><triangles>" + ts.join("") + "</triangles>";
  }

  function build3mf(groups /* [{name,hex,alpha,tris}] */) {
    var mats = [], objs = [], items = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var a = Math.round((g.alpha === undefined ? 100 : g.alpha) * 2.55);
      mats.push('<base name="' + xmlEsc(g.name) + '" displaycolor="' + g.hex.toUpperCase() +
        (a >= 255 ? "FF" : pad(a.toString(16).toUpperCase(), 2)) + '"/>');
      var oid = i + 2;
      objs.push('<object id="' + oid + '" type="model" pid="1" pindex="' + i + '"><mesh>' + meshToXml(g.tris) + '</mesh></object>');
      items.push('<item objectid="' + oid + '"/>');
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="en-US" ' +
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n' +
      '<metadata name="Application">BRICKSPLIT</metadata>\n' +
      '<resources><basematerials id="1">' + mats.join("") + '</basematerials>' + objs.join("") + '</resources>\n' +
      '<build>' + items.join("") + '</build>\n</model>\n';
  }

  function xmlEsc(s) {
    return String(s).replace(/[<>&"']/g, function (c) {
      return ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c];
    });
  }

  async function add3mfTo(zip, path, xml) {
    // un fisier 3MF este el insusi un ZIP; il construim separat si il inseram
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
    await zip.add(path, new Uint8Array(await blob.arrayBuffer()), { compress: false });
  }

  // -------------------------------------------------- transformari pentru export

  /* Construieste matricea finala: unitati Mecabricks -> mm, optional Y-up -> Z-up,
     plus deplasarea globala care aseaza modelul pe planul de printare. */
  function makeWorldTransform(model, opt) {
    var s = opt.scale * (opt.sizeFactor || 1);
    var zUp = opt.zUp !== false;
    var w = model.world;

    // colturile modelului in mm, dupa scalare si eventuala rotatie
    function conv(x, y, z) {
      return zUp ? [x * s, -z * s, y * s] : [x * s, y * s, z * s];
    }
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < 8; i++) {
      var p = conv((i & 1) ? w.max[0] : w.min[0], (i & 2) ? w.max[1] : w.min[1], (i & 4) ? w.max[2] : w.min[2]);
      for (var k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
    }
    var off = opt.dropToBed === false ? [0, 0, 0]
      : [-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]];

    return {
      scale: s, zUp: zUp, offset: off,
      sizeMm: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
    };
  }

  /* Aplica matricea instantei + scalarea + conversia Z-up peste triunghiurile locale. */
  function bakeInstance(local, m, wt, out, outOff) {
    var s = wt.scale, zUp = wt.zUp, o = wt.offset;
    for (var i = 0; i < local.length; i += 3) {
      var x = local[i], y = local[i + 1], z = local[i + 2];
      var wx = m[0] * x + m[1] * y + m[2] * z + m[3];
      var wy = m[4] * x + m[5] * y + m[6] * z + m[7];
      var wz = m[8] * x + m[9] * y + m[10] * z + m[11];
      var ox, oy, oz;
      if (zUp) { ox = wx * s; oy = -wz * s; oz = wy * s; }
      else { ox = wx * s; oy = wy * s; oz = wz * s; }
      out[outOff++] = ox + o[0]; out[outOff++] = oy + o[1]; out[outOff++] = oz + o[2];
    }
    return outOff;
  }

  /* Piesa individuala: scalata, rotita Z-up, centrata pe XY si asezata pe pat. */
  function bakeSinglePiece(local, wt) {
    var s = wt.scale, zUp = wt.zUp;
    var out = new Float32Array(local.length);
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < local.length; i += 3) {
      var x = local[i], y = local[i + 1], z = local[i + 2];
      var ox, oy, oz;
      if (zUp) { ox = x * s; oy = -z * s; oz = y * s; }
      else { ox = x * s; oy = y * s; oz = z * s; }
      out[i] = ox; out[i + 1] = oy; out[i + 2] = oz;
      if (ox < mn[0]) mn[0] = ox; if (ox > mx[0]) mx[0] = ox;
      if (oy < mn[1]) mn[1] = oy; if (oy > mx[1]) mx[1] = oy;
      if (oz < mn[2]) mn[2] = oz; if (oz > mx[2]) mx[2] = oz;
    }
    var dx = -(mn[0] + mx[0]) / 2, dy = -(mn[1] + mx[1]) / 2, dz = -mn[2];
    for (var j = 0; j < out.length; j += 3) { out[j] += dx; out[j + 1] += dy; out[j + 2] += dz; }
    return { tris: out, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }


  // ------------------------------------------------- date pentru previzualizare

  function boxMesh(bb) {
    var x0 = bb.min[0], y0 = bb.min[1], z0 = bb.min[2];
    var x1 = bb.max[0], y1 = bb.max[1], z1 = bb.max[2];
    var v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
    ];
    var f = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
      [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]
    ];
    var out = new Float32Array(f.length * 9), w = 0;
    for (var i = 0; i < f.length; i++) {
      for (var c = 0; c < 3; c++) {
        var p = v[f[i][c]];
        out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2];
      }
    }
    return out;
  }

  /* Rezumat fara geometrie, pentru interfata. */
  function summarize(model) {
    return {
      stats: model.stats,
      detectedScale: model.detectedScale,
      mbxMeta: model.mbxMeta,
      world: model.world,
      colorGroups: model.colorGroups.map(function (g) {
        return {
          colorId: g.colorId, name: g.name, hex: g.hex, type: g.type, alpha: g.alpha,
          total: g.total, unique: g.unique, triCount: g.triCount, volumeUnits3: g.volumeUnits3
        };
      })
    };
  }

  /* Geometria fiecarei forme + matricile instantelor, grupate pe (forma, culoare)
     ca sa poata fi randate cu InstancedMesh. Formele cele mai grele primesc un
     inlocuitor tip cutie, ca sa nu explodeze memoria la seturile foarte mari. */
  function previewPayload(model, floatBudget) {
    var order = model.shapeList.slice().sort(function (a, b) { return a.triCount - b.triCount; });
    var budget = floatBudget || 8e6;
    var keep = Object.create(null), used = 0;
    for (var i = 0; i < order.length; i++) {
      if (used + order[i].tris.length > budget) break;
      keep[order[i].key] = true;
      used += order[i].tris.length;
    }

    var shapes = [], transfer = [];
    for (var j = 0; j < model.shapeList.length; j++) {
      var s = model.shapeList[j];
      var positions = keep[s.key] ? s.tris.slice() : boxMesh(s.bbox);
      shapes.push({ key: s.key, positions: positions, simplified: !keep[s.key] });
      transfer.push(positions.buffer);
    }

    var buckets = Object.create(null);
    for (var k = 0; k < model.instances.length; k++) {
      var inst = model.instances[k];
      var bk = inst.shapeKey + " " + inst.colorId;
      if (!buckets[bk]) buckets[bk] = { shapeKey: inst.shapeKey, colorId: inst.colorId, list: [] };
      buckets[bk].list.push(inst.matrix);
    }

    var groups = [];
    for (var bkey in buckets) {
      var b = buckets[bkey];
      var mats = new Float32Array(b.list.length * 16);
      for (var mi = 0; mi < b.list.length; mi++) mats.set(b.list[mi], mi * 16);
      var info = colorInfo(b.colorId);
      groups.push({
        shapeKey: b.shapeKey, colorId: b.colorId, count: b.list.length,
        hex: info.hex, alpha: info.alpha, type: info.type, matrices: mats
      });
      transfer.push(mats.buffer);
    }

    return { payload: { shapes: shapes, groups: groups }, transfer: transfer };
  }

  root.BrickEngine = {
    loadModel: loadModel,
    summarize: summarize,
    previewPayload: previewPayload,
    detectScale: detectScale,
    writeStl: writeStl,
    build3mf: build3mf,
    add3mfTo: add3mfTo,
    makeWorldTransform: makeWorldTransform,
    bakeInstance: bakeInstance,
    bakeSinglePiece: bakeSinglePiece,
    colorInfo: colorInfo,
    slug: slug,
    pad: pad,
    meshVolume: meshVolume,
    PLA_DENSITY: PLA_DENSITY,
    STUD_PITCH_MM: STUD_PITCH_MM
  };
})(typeof self !== "undefined" ? self : this);
