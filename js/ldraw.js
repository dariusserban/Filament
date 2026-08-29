/* ldraw.js — citeste fisierele .dat din biblioteca LDraw si le transforma in
   plase de triunghiuri gata de printat.

   Format LDraw, doar liniile care produc geometrie:
     1 <culoare> x y z  a b c  d e f  g h i  <fisier>   referinta catre alt fisier
     3 <culoare> x1 y1 z1  x2 y2 z2  x3 y3 z3           triunghi
     4 <culoare> ... 4 varfuri                          patrulater
   Matricea liniei 1 este   | a b c x |
                            | d e f y |
                            | g h i z |
   Culorile sunt ignorate: culoarea vine din inventarul setului, nu din geometrie.

   BFC (Back Face Culling) da sensul de parcurgere a varfurilor. Il respectam
   pentru ca STL-ul sa aiba normalele spre exterior, ceea ce conteaza la feliere.

   O unitate LDraw (LDU) = 0.4 mm exact: pasul dintre doi stud-uri este 20 LDU
   = 8 mm. Nu e nevoie sa ghicim scara.

   Fisierele au fost pregatite de tools/build-data.mjs: comentariile sunt scoase
   si referintele sunt rescrise ca. cai explicite, deci aici nu mai cautam nimic. */
(function (root) {
  "use strict";

  var LDU_MM = 0.4;

  function createLoader(basePath, onProgress) {
    var texts = new Map();     // cale -> Promise<string|null>
    var meshes = new Map();    // cale -> Promise<Float32Array>
    var fetched = 0;

    function loadText(rel) {
      var hit = texts.get(rel);
      if (hit) return hit;
      var p = fetch(basePath + rel)
        .then(function (r) { return r.ok ? r.text() : null; })
        .catch(function () { return null; })
        .then(function (t) {
          fetched++;
          if (onProgress && (fetched & 31) === 0) onProgress(fetched);
          return t;
        });
      texts.set(rel, p);
      return p;
    }

    /* Plasa unui fisier, in coordonate proprii, cu sensul de parcurgere normalizat. */
    function loadMesh(rel, depth) {
      var hit = meshes.get(rel);
      if (hit) return hit;
      var p = buildMesh(rel, depth || 0);
      meshes.set(rel, p);
      return p;
    }

    async function buildMesh(rel, depth) {
      if (depth > 24) return new Float32Array(0);      // referinte circulare
      var text = await loadText(rel);
      if (!text) return new Float32Array(0);

      var chunks = [], childJobs = [];
      var ccw = true;              // BFC CERTIFY CCW este implicit in practica
      var invertNext = false;

      var lines = text.split("\n");
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;
        var t = line.charCodeAt(0);

        if (t === 48 /* '0' */) {
          if (/^0\s+BFC\b/i.test(line)) {
            if (/\bINVERTNEXT\b/i.test(line)) invertNext = true;
            if (/\bCW\b/i.test(line)) ccw = false;
            else if (/\bCCW\b/i.test(line)) ccw = true;
          }
          continue;
        }

        var f = line.split(/\s+/);

        if (t === 49 /* '1' */) {
          if (f.length < 15) { invertNext = false; continue; }
          var m = [
            +f[5], +f[6], +f[7], +f[2],
            +f[8], +f[9], +f[10], +f[3],
            +f[11], +f[12], +f[13], +f[4]
          ];
          var child = f.slice(14).join(" ");
          var flip = invertNext !== (det3(m) < 0);   // XOR
          invertNext = false;
          childJobs.push({ file: child, matrix: m, flip: flip });
          continue;
        }

        if (t === 51 /* '3' */) {
          if (f.length < 11) continue;
          pushTri(chunks, +f[2], +f[3], +f[4], +f[5], +f[6], +f[7], +f[8], +f[9], +f[10], !ccw);
          continue;
        }

        if (t === 52 /* '4' */) {
          if (f.length < 14) continue;
          var ax = +f[2], ay = +f[3], az = +f[4];
          var bx = +f[5], by = +f[6], bz = +f[7];
          var cx = +f[8], cy = +f[9], cz = +f[10];
          var dx = +f[11], dy = +f[12], dz = +f[13];
          pushTri(chunks, ax, ay, az, bx, by, bz, cx, cy, cz, !ccw);
          pushTri(chunks, ax, ay, az, cx, cy, cz, dx, dy, dz, !ccw);
        }
      }

      // copiii se incarca in paralel; fiecare isi are propria plasa in cache
      var kids = await Promise.all(childJobs.map(function (j) {
        return loadMesh(j.file, depth + 1);
      }));
      for (var k = 0; k < kids.length; k++) {
        var job = childJobs[k];
        chunks.push(transformTris(kids[k], job.matrix, job.flip));
      }

      return concat(chunks);
    }

    /* Plasa unei piese, in milimetri, cu Z in sus si asezata pe pat. */
    async function partMesh(partNum) {
      var raw = await loadMesh("parts/" + partNum + ".dat", 0);
      if (!raw.length) return null;
      return toPrintable(raw);
    }

    return {
      partMesh: partMesh,
      loadMesh: loadMesh,
      get fetched() { return fetched; }
    };
  }

  // ------------------------------------------------------------- geometrie

  function pushTri(out, ax, ay, az, bx, by, bz, cx, cy, cz, flip) {
    if (flip) out.push(new Float32Array([ax, ay, az, cx, cy, cz, bx, by, bz]));
    else out.push(new Float32Array([ax, ay, az, bx, by, bz, cx, cy, cz]));
  }

  function det3(m) {
    return m[0] * (m[5] * m[10] - m[6] * m[9])
         - m[1] * (m[4] * m[10] - m[6] * m[8])
         + m[2] * (m[4] * m[9] - m[5] * m[8]);
  }

  function transformTris(src, m, flip) {
    var out = new Float32Array(src.length);
    for (var i = 0; i < src.length; i += 3) {
      var x = src[i], y = src[i + 1], z = src[i + 2];
      out[i]     = m[0] * x + m[1] * y + m[2] * z + m[3];
      out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
    if (flip) {
      // schimba doua varfuri din fiecare triunghi ca sa refaca sensul
      for (var t = 0; t + 8 < out.length; t += 9) {
        for (var k = 0; k < 3; k++) {
          var tmp = out[t + 3 + k]; out[t + 3 + k] = out[t + 6 + k]; out[t + 6 + k] = tmp;
        }
      }
    }
    return out;
  }

  function concat(chunks) {
    if (!chunks.length) return new Float32Array(0);
    if (chunks.length === 1) return chunks[0];
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  /* LDraw are Y in jos si lucreaza in LDU. Trecem in milimetri, cu Z in sus,
     si asezam piesa centrata pe XY, cu baza la zero. */
  function toPrintable(tris) {
    var out = new Float32Array(tris.length);
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < tris.length; i += 3) {
      var x = tris[i] * LDU_MM;
      var y = tris[i + 2] * LDU_MM;      // Z-ul LDraw devine Y
      var z = -tris[i + 1] * LDU_MM;     // Y-ul LDraw e in jos, deci se inverseaza
      out[i] = x; out[i + 1] = y; out[i + 2] = z;
      if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
      if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
      if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
    }
    var dx = -(mn[0] + mx[0]) / 2, dy = -(mn[1] + mx[1]) / 2, dz = -mn[2];
    for (var j = 0; j < out.length; j += 3) {
      out[j] += dx; out[j + 1] += dy; out[j + 2] += dz;
    }
    return {
      tris: out,
      triCount: out.length / 9,
      size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
      volume: meshVolume(out)
    };
  }

  function meshVolume(tris) {
    var v = 0;
    for (var i = 0; i < tris.length; i += 9) {
      var ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      var bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      var cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return Math.abs(v) / 6;
  }

  root.LDraw = {
    createLoader: createLoader,
    LDU_MM: LDU_MM,
    meshVolume: meshVolume,
    concat: concat
  };
})(typeof self !== "undefined" ? self : this);
