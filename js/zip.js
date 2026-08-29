/* zip.js — citire si scriere ZIP fara nicio librarie externa.
   Foloseste CompressionStream/DecompressionStream native ("deflate-raw"),
   disponibile in toate browserele moderne. Suporta ZIP64 la scriere. */
(function (root) {
  "use strict";

  // ---------- CRC32 ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf, seed) {
    var c = (seed === undefined ? 0 : seed) ^ 0xffffffff;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- utilitare binare ----------
  function u8(str) {
    return new TextEncoder().encode(str);
  }

  function concat(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function hasNativeDeflate() {
    return typeof CompressionStream !== "undefined";
  }

  async function deflateRaw(bytes) {
    var cs = new CompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------- CITIRE ----------
  // Returneaza { "nume/fisier": {size, read()->Promise<Uint8Array>} }
  async function readZip(arrayBuffer) {
    var buf = new Uint8Array(arrayBuffer);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // cauta End Of Central Directory (0x06054b50) de la coada
    var eocd = -1;
    var minPos = Math.max(0, buf.length - 65557);
    for (var i = buf.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Fisierul nu pare a fi un ZIP valid (lipseste EOCD).");

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    // ZIP64: daca valorile sunt saturate, citeste EOCD64
    if (cdOffset === 0xffffffff || count === 0xffff) {
      for (var j = eocd - 20; j >= 0; j--) {
        if (dv.getUint32(j, true) === 0x07064b50) {           // locator ZIP64
          var eocd64 = Number(dv.getBigUint64(j + 8, true));
          if (dv.getUint32(eocd64, true) === 0x06064b50) {
            count = Number(dv.getBigUint64(eocd64 + 32, true));
            cdOffset = Number(dv.getBigUint64(eocd64 + 48, true));
          }
          break;
        }
      }
    }

    var files = {};
    var p = cdOffset;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var rawSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

      // camp extra ZIP64 (0x0001)
      if (rawSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
        var ep = p + 46 + nameLen, epEnd = ep + extraLen;
        while (ep + 4 <= epEnd) {
          var hid = dv.getUint16(ep, true), hsz = dv.getUint16(ep + 2, true), q = ep + 4;
          if (hid === 0x0001) {
            if (rawSize === 0xffffffff) { rawSize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (localOff === 0xffffffff) { localOff = Number(dv.getBigUint64(q, true)); q += 8; }
            break;
          }
          ep += 4 + hsz;
        }
      }

      files[name] = makeEntry(buf, dv, localOff, method, compSize, rawSize);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  function makeEntry(buf, dv, localOff, method, compSize, rawSize) {
    return {
      size: rawSize,
      compressedSize: compSize,
      read: async function () {
        if (dv.getUint32(localOff, true) !== 0x04034b50)
          throw new Error("Antet local de fisier invalid in ZIP.");
        var nameLen = dv.getUint16(localOff + 26, true);
        var extraLen = dv.getUint16(localOff + 28, true);
        var start = localOff + 30 + nameLen + extraLen;
        var data = buf.subarray(start, start + compSize);
        if (method === 0) return data;
        if (method === 8) {
          if (!hasNativeDeflate())
            throw new Error("Browserul nu suporta DecompressionStream. Foloseste Chrome/Edge/Firefox/Safari recent.");
          return await inflateRaw(data);
        }
        throw new Error("Metoda de compresie ZIP nesuportata: " + method);
      }
    };
  }

  // ---------- SCRIERE ----------
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  var COALESCE_BYTES = 32 * 1024 * 1024;

  function ZipWriter() {
    this.parts = [];      // bucati de Blob/Uint8Array pentru rezultat
    this.entries = [];    // metadate pentru directorul central
    this.offset = 0;
    this.pending = 0;     // octeti neconsolidati inca intr-un Blob
    this.coalesced = 0;   // indexul de dupa ultima consolidare
    this.date = new Date();
  }

  /* Strange bucatile acumulate intr-un singur Blob. Blob-urile pot fi tinute
     de browser in afara heap-ului, deci arhivele mari nu mai umplu memoria. */
  ZipWriter.prototype._coalesce = function () {
    if (this.parts.length - this.coalesced < 2) { this.pending = 0; return; }
    var tail = this.parts.splice(this.coalesced);
    this.parts.push(new Blob(tail));
    this.coalesced = this.parts.length;
    this.pending = 0;
  };

  /* name: cale in arhiva; data: Uint8Array sau string */
  ZipWriter.prototype.add = async function (name, data, opts) {
    opts = opts || {};
    if (typeof data === "string") data = u8(data);
    var nameBytes = u8(name);
    var crc = crc32(data);
    var rawSize = data.length;

    var method = 0, payload = data;
    var wantCompress = opts.compress !== false && rawSize > 64 && hasNativeDeflate();
    if (wantCompress) {
      var def = await deflateRaw(data);
      if (def.length < rawSize) { method = 8; payload = def; }
    }

    var needsZip64 = rawSize >= 0xffffffff || payload.length >= 0xffffffff || this.offset >= 0xffffffff;

    // antet local
    var extra = needsZip64 ? new Uint8Array(20) : new Uint8Array(0);
    if (needsZip64) {
      var edv = new DataView(extra.buffer);
      edv.setUint16(0, 0x0001, true);
      edv.setUint16(2, 16, true);
      edv.setBigUint64(4, BigInt(rawSize), true);
      edv.setBigUint64(12, BigInt(payload.length), true);
    }

    var lh = new Uint8Array(30);
    var ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, needsZip64 ? 45 : 20, true);
    ldv.setUint16(6, 0x0800, true);                       // UTF-8
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, dosTime(this.date), true);
    ldv.setUint16(12, dosDate(this.date), true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, needsZip64 ? 0xffffffff : payload.length, true);
    ldv.setUint32(22, needsZip64 ? 0xffffffff : rawSize, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, extra.length, true);

    this.parts.push(lh, nameBytes, extra, payload);
    this.entries.push({
      name: nameBytes, crc: crc, method: method,
      compSize: payload.length, rawSize: rawSize,
      offset: this.offset, zip64: needsZip64
    });
    var written = lh.length + nameBytes.length + extra.length + payload.length;
    this.offset += written;
    this.pending += written;
    if (this.pending >= COALESCE_BYTES) this._coalesce();
  };

  ZipWriter.prototype.finish = function (mimeType) {
    var cdParts = [], cdStart = this.offset, cdSize = 0, i;

    for (i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      var z64 = e.zip64 || e.offset >= 0xffffffff;
      var ex = new Uint8Array(z64 ? 28 : 0);
      if (z64) {
        var xdv = new DataView(ex.buffer);
        xdv.setUint16(0, 0x0001, true);
        xdv.setUint16(2, 24, true);
        xdv.setBigUint64(4, BigInt(e.rawSize), true);
        xdv.setBigUint64(12, BigInt(e.compSize), true);
        xdv.setBigUint64(20, BigInt(e.offset), true);
      }
      var ch = new Uint8Array(46);
      var cdv = new DataView(ch.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 45, true);
      cdv.setUint16(6, z64 ? 45 : 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, e.method, true);
      cdv.setUint16(12, dosTime(this.date), true);
      cdv.setUint16(14, dosDate(this.date), true);
      cdv.setUint32(16, e.crc, true);
      cdv.setUint32(20, z64 ? 0xffffffff : e.compSize, true);
      cdv.setUint32(24, z64 ? 0xffffffff : e.rawSize, true);
      cdv.setUint16(28, e.name.length, true);
      cdv.setUint16(30, ex.length, true);
      cdv.setUint32(42, z64 ? 0xffffffff : e.offset, true);
      cdParts.push(ch, e.name, ex);
      cdSize += 46 + e.name.length + ex.length;
    }

    var needZip64 = this.entries.length > 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (needZip64) {
      var z = new Uint8Array(56);
      var zdv = new DataView(z.buffer);
      zdv.setUint32(0, 0x06064b50, true);
      zdv.setBigUint64(4, 44n, true);
      zdv.setUint16(12, 45, true);
      zdv.setUint16(14, 45, true);
      zdv.setBigUint64(24, BigInt(this.entries.length), true);
      zdv.setBigUint64(32, BigInt(this.entries.length), true);
      zdv.setBigUint64(40, BigInt(cdSize), true);
      zdv.setBigUint64(48, BigInt(cdStart), true);
      // locator
      var loc = new Uint8Array(20);
      var ldv2 = new DataView(loc.buffer);
      ldv2.setUint32(0, 0x07064b50, true);
      ldv2.setBigUint64(8, BigInt(cdStart + cdSize), true);
      ldv2.setUint32(16, 1, true);
      cdParts.push(z, loc);
    }

    var eocd = new Uint8Array(22);
    var edv2 = new DataView(eocd.buffer);
    edv2.setUint32(0, 0x06054b50, true);
    edv2.setUint16(8, needZip64 ? 0xffff : this.entries.length, true);
    edv2.setUint16(10, needZip64 ? 0xffff : this.entries.length, true);
    edv2.setUint32(12, needZip64 ? 0xffffffff : cdSize, true);
    edv2.setUint32(16, needZip64 ? 0xffffffff : cdStart, true);
    cdParts.push(eocd);

    return new Blob(this.parts.concat(cdParts), { type: mimeType || "application/zip" });
  };

  root.MBZip = {
    readZip: readZip,
    ZipWriter: ZipWriter,
    crc32: crc32,
    concat: concat,
    hasNativeDeflate: hasNativeDeflate
  };
})(typeof self !== "undefined" ? self : this);
