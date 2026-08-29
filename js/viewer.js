/* viewer.js — previzualizare 3D in WebGL2 pur, fara librarii externe.
   Fiecare pereche (forma, culoare) e desenata cu instantiere hardware, deci
   un set de zeci de mii de piese ramane fluid.
   Normalele sunt calculate in fragment shader din derivate, asa ca nu trebuie
   sa transportam si sa stocam vectori normali — si iese exact umbrirea plata
   care se potriveste pieselor LEGO. */
(function (root) {
  "use strict";

  var VERT = [
    "#version 300 es",
    "in vec3 aPos;",
    "in vec4 aM0; in vec4 aM1; in vec4 aM2; in vec4 aM3;",
    "uniform mat4 uView; uniform mat4 uProj; uniform vec3 uCenter;",
    "out vec3 vViewPos;",
    "void main(){",
    "  mat4 m = mat4(aM0, aM1, aM2, aM3);",
    "  vec4 wp = m * vec4(aPos, 1.0);",
    "  wp.xyz -= uCenter;",
    "  vec4 vp = uView * wp;",
    "  vViewPos = vp.xyz;",
    "  gl_Position = uProj * vp;",
    "}"
  ].join("\n");

  var FRAG = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 vViewPos;",
    "uniform vec3 uColor; uniform float uAlpha; uniform float uMetal;",
    "out vec4 frag;",
    "void main(){",
    "  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));",
    "  vec3 V = normalize(-vViewPos);",
    "  if (dot(n, V) < 0.0) n = -n;",
    "  vec3 L1 = normalize(vec3(0.45, 0.80, 0.75));",
    "  vec3 L2 = normalize(vec3(-0.65, 0.15, -0.35));",
    "  float d = max(dot(n, L1), 0.0) * 0.80 + max(dot(n, L2), 0.0) * 0.22;",
    "  float amb = 0.34 + 0.16 * n.y;",
    // podea de luminozitate + reflexie pe muchii, altfel negrul iese silueta plata
    "  vec3 col = max(uColor, vec3(0.022));",
    "  vec3 base = col * (amb + d);",
    "  vec3 H = normalize(L1 + V);",
    "  float s = pow(max(dot(n, H), 0.0), mix(26.0, 90.0, uMetal)) * mix(0.22, 0.85, uMetal);",
    "  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.16;",
    // culorile intra linearizate, deci trebuie recodificate in sRGB la iesire
    "  vec3 lin = base + vec3(s + fres);",
    "  frag = vec4(pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2)), uAlpha);",
    "}"
  ].join("\n");

  var FOV = Math.PI / 4.5;   // unghiul vertical al camerei

  // ------------------------------------------------------------- matrici 4x4

  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function lookAt(eye, target, up) {
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
    ]);
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    // corectie gamma aproximativa, ca sa nu iasa culorile spalacite
    return [
      Math.pow(((n >> 16) & 255) / 255, 2.2),
      Math.pow(((n >> 8) & 255) / 255, 2.2),
      Math.pow((n & 255) / 255, 2.2)
    ];
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("Shader: " + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  // ------------------------------------------------------------------ viewer

  function createViewer(canvas) {
    var gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 nu este disponibil in acest browser.");

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Program WebGL: " + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    var loc = {
      pos: gl.getAttribLocation(prog, "aPos"),
      m0: gl.getAttribLocation(prog, "aM0"),
      view: gl.getUniformLocation(prog, "uView"),
      proj: gl.getUniformLocation(prog, "uProj"),
      center: gl.getUniformLocation(prog, "uCenter"),
      color: gl.getUniformLocation(prog, "uColor"),
      alpha: gl.getUniformLocation(prog, "uAlpha"),
      metal: gl.getUniformLocation(prog, "uMetal")
    };

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.031, 0.031, 0.031, 1);

    var state = {
      groups: [], byColor: new Map(), center: [0, 0, 0], radius: 10,
      yaw: 0.75, pitch: 0.55, dist: 30, target: [0, 0, 0],
      hidden: new Set(), dirty: true, disposed: false
    };

    // -------------------------------------------------------------- geometrie

    function setModel(preview, world) {
      dispose(false);

      var buffers = new Map();
      for (var i = 0; i < preview.shapes.length; i++) {
        var s = preview.shapes[i];
        var vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, s.positions, gl.STATIC_DRAW);
        buffers.set(s.key, { vbo: vbo, count: s.positions.length / 3 });
      }

      var groups = preview.groups.slice()
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 4000);

      state.groups = [];
      state.byColor = new Map();

      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var geo = buffers.get(grp.shapeKey);
        if (!geo) continue;

        // matricile din .mbx sunt pe linii; WebGL le vrea pe coloane
        var src = grp.matrices, n = grp.count;
        var cols = new Float32Array(n * 16);
        for (var k = 0; k < n; k++) {
          var o = k * 16;
          for (var r = 0; r < 4; r++) {
            for (var c = 0; c < 4; c++) cols[o + c * 4 + r] = src[o + r * 4 + c];
          }
        }

        var ibo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ARRAY_BUFFER, cols, gl.STATIC_DRAW);

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, geo.vbo);
        gl.enableVertexAttribArray(loc.pos);
        gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
        for (var a = 0; a < 4; a++) {
          gl.enableVertexAttribArray(loc.m0 + a);
          gl.vertexAttribPointer(loc.m0 + a, 4, gl.FLOAT, false, 64, a * 16);
          gl.vertexAttribDivisor(loc.m0 + a, 1);
        }
        gl.bindVertexArray(null);

        var metal = grp.type === "chrome" || grp.type === "metallic" ? 1
          : grp.type === "pearl" ? 0.5 : 0;
        var entry = {
          vao: vao, ibo: ibo, count: geo.count, instances: n,
          rgb: hexToRgb(grp.hex), alpha: grp.alpha / 100, metal: metal,
          colorId: grp.colorId, transparent: grp.alpha < 100
        };
        state.groups.push(entry);
        if (!state.byColor.has(grp.colorId)) state.byColor.set(grp.colorId, []);
        state.byColor.get(grp.colorId).push(entry);
      }

      state.buffers = buffers;

      state.center = [
        (world.min[0] + world.max[0]) / 2,
        (world.min[1] + world.max[1]) / 2,
        (world.min[2] + world.max[2]) / 2
      ];
      // raza sferei care cuprinde modelul, ca sa nu iasa nimic din cadru
      state.radius = 0.5 * Math.hypot(
        world.max[0] - world.min[0],
        world.max[1] - world.min[1],
        world.max[2] - world.min[2]) || 5;
      state.dist = state.radius / Math.sin(FOV / 2) * 1.15;
      state.yaw = 0.8; state.pitch = 0.5;
      state.dirty = true;
    }

    function setColorVisible(colorId, visible) {
      if (visible) state.hidden.delete(colorId);
      else state.hidden.add(colorId);
      state.dirty = true;
    }

    // ------------------------------------------------------------- randare

    function render() {
      var w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);

      var cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
      var eye = [
        state.target[0] + state.dist * cp * Math.sin(state.yaw),
        state.target[1] + state.dist * sp,
        state.target[2] + state.dist * cp * Math.cos(state.yaw)
      ];
      gl.uniformMatrix4fv(loc.view, false, lookAt(eye, state.target, [0, 1, 0]));
      gl.uniformMatrix4fv(loc.proj, false,
        perspective(FOV, w / h, Math.max(0.01, state.radius / 100), state.radius * 60));
      gl.uniform3fv(loc.center, state.center);

      drawPass(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      drawPass(true);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    function drawPass(transparent) {
      for (var i = 0; i < state.groups.length; i++) {
        var g = state.groups[i];
        if (g.transparent !== transparent) continue;
        if (state.hidden.has(g.colorId)) continue;
        gl.bindVertexArray(g.vao);
        gl.uniform3fv(loc.color, g.rgb);
        gl.uniform1f(loc.alpha, g.alpha);
        gl.uniform1f(loc.metal, g.metal);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, g.count, g.instances);
      }
      gl.bindVertexArray(null);
    }

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width * dpr));
      var h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        state.dirty = true;
      }
    }

    // ----------------------------------------------------------- interactiune

    var drag = null;
    canvas.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      state.yaw -= (e.clientX - drag.x) * 0.008;
      state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch + (e.clientY - drag.y) * 0.008));
      drag.x = e.clientX; drag.y = e.clientY;
      state.dirty = true;
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
      canvas.addEventListener(t, function () { drag = null; });
    });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      state.dist = Math.max(state.radius * 0.25,
        Math.min(state.radius * 25, state.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      state.dirty = true;
    }, { passive: false });

    var raf = 0;
    (function tick() {
      if (state.disposed) return;
      raf = requestAnimationFrame(tick);
      resize();
      if (state.dirty) { state.dirty = false; render(); }
    })();

    function dispose(full) {
      for (var i = 0; i < state.groups.length; i++) {
        gl.deleteVertexArray(state.groups[i].vao);
        gl.deleteBuffer(state.groups[i].ibo);
      }
      if (state.buffers) state.buffers.forEach(function (b) { gl.deleteBuffer(b.vbo); });
      state.groups = []; state.byColor = new Map(); state.buffers = null;
      if (full) { state.disposed = true; cancelAnimationFrame(raf); }
    }

    return {
      setModel: setModel,
      setColorVisible: setColorVisible,
      invalidate: function () { state.dirty = true; },
      dispose: function () { dispose(true); }
    };
  }

  root.BrickViewer = { create: createViewer };
})(typeof self !== "undefined" ? self : this);
