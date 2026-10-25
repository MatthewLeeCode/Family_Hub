/* The animated showpiece at the top of Home: the Scope, a thin-line chart display with four modes
   (Orbit, Warp, Scatter, Loops), drawn from the Minimalist Family Hub design. It stops by itself when
   its canvas leaves the page, and draws a single still frame on devices set to reduce motion. */
'use strict';

const SetPieces = (() => {
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LABELS = {
    orbit: 'planets on tilted orbits around a sun', warp: 'a sheet of grid lines dented by a moving mass',
    scatter: 'squares drifting around grid blocks', loops: 'a looping curve slowly changing shape',
  };
  // The few glyphs from the design's sheet that the Scope draws, in the theme's colours.
  const GLYPH = {
    pinwheel: "<path d=\"M14.6 12Q19.84 13.59 18.53 20.22M13.3 14.25Q14.54 19.58 8.14 21.76M10.7 14.25Q6.7 18 1.61 13.54M9.4 12Q4.16 10.41 5.47 3.78M10.7 9.75Q9.46 4.42 15.86 2.24M13.3 9.75Q17.3 6 22.39 10.46\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
    plusgrid: "<path d=\"M5 2.1Q5.45 4.55 7.9 5Q5.45 5.45 5 7.9Q4.55 5.45 2.1 5Q4.55 4.55 5 2.1ZM12 2.1Q12.45 4.55 14.9 5Q12.45 5.45 12 7.9Q11.55 5.45 9.1 5Q11.55 4.55 12 2.1ZM19 2.1Q19.45 4.55 21.9 5Q19.45 5.45 19 7.9Q18.55 5.45 16.1 5Q18.55 4.55 19 2.1ZM5 9.1Q5.45 11.55 7.9 12Q5.45 12.45 5 14.9Q4.55 12.45 2.1 12Q4.55 11.55 5 9.1ZM12 9.1Q12.45 11.55 14.9 12Q12.45 12.45 12 14.9Q11.55 12.45 9.1 12Q11.55 11.55 12 9.1ZM19 9.1Q19.45 11.55 21.9 12Q19.45 12.45 19 14.9Q18.55 12.45 16.1 12Q18.55 11.55 19 9.1ZM5 16.1Q5.45 18.55 7.9 19Q5.45 19.45 5 21.9Q4.55 19.45 2.1 19Q4.55 18.55 5 16.1ZM12 16.1Q12.45 18.55 14.9 19Q12.45 19.45 12 21.9Q11.55 19.45 9.1 19Q11.55 18.55 12 16.1ZM19 16.1Q19.45 18.55 21.9 19Q19.45 19.45 19 21.9Q18.55 19.45 16.1 19Q18.55 18.55 19 16.1Z\" fill=\"currentColor\"/>",
    steps: "<path d=\"M3 3h9v9H3zM12 12h9v9h-9z\" fill=\"currentColor\"/><path d=\"M12.75 3.75h7.5v7.5h-7.5z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
    atom: "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\"><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4\"/><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4\" transform=\"rotate(60 12 12)\"/><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4\" transform=\"rotate(120 12 12)\"/></g><path d=\"M10.1 12a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0Z\" fill=\"currentColor\"/>",
    flower: "<path d=\"M7 6.6a5 5 0 1 0 10 0a5 5 0 1 0 -10 0ZM7 17.4a5 5 0 1 0 10 0a5 5 0 1 0 -10 0ZM1.6 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0ZM12.4 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0Z\" fill=\"currentColor\"/>",
    dots: "<path d=\"M10.6 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0ZM15.3 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM13.68 15.36a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM10.04 16.19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM7.13 13.87a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM7.13 10.13a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM10.04 7.81a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM13.68 8.64a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM18.55 12a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM17.55 15.75a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM14.8 18.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM11.05 19.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM7.3 18.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM4.55 15.75a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM3.55 12a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM4.55 8.25a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM7.3 5.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM11.05 4.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM14.8 5.5a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM17.55 8.25a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0 -1.9 0ZM21.75 12a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM21.11 15.63a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM19.27 18.81a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM16.45 21.18a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM12.99 22.44a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM9.31 22.44a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM5.85 21.18a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM3.03 18.81a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM1.19 15.63a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM0.55 12a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM1.19 8.37a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM3.03 5.19a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM5.85 2.82a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM9.31 1.56a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM12.99 1.56a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM16.45 2.82a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM19.27 5.19a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0ZM21.11 8.37a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0Z\" fill=\"currentColor\"/>",
    burst: "<path d=\"M12 0.6L13.82 4.01L16.95 1.73L17.11 5.59L20.91 4.89L19.39 8.44L23.11 9.46L20.2 12L23.11 14.54L19.39 15.56L20.91 19.11L17.11 18.41L16.95 22.27L13.82 19.99L12 23.4L10.18 19.99L7.05 22.27L6.89 18.41L3.09 19.11L4.61 15.56L0.89 14.54L3.8 12L0.89 9.46L4.61 8.44L3.09 4.89L6.89 5.59L7.05 1.73L10.18 4.01Z\" fill=\"currentColor\"/>",
    lens: "<path d=\"M1 12Q12 0.5 23 12Q12 23.5 1 12ZM4.2 12Q12 4.6 19.8 12Q12 19.4 4.2 12ZM8.1 12a3.9 3.9 0 1 0 7.8 0a3.9 3.9 0 1 0 -7.8 0Z\" fill=\"currentColor\" fill-rule=\"evenodd\"/>"
  };

  function scope(cv, kind) {
    const c = cv.getContext('2d'), W = cv.width, H = cv.height, cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
    const INK = v('--ink'), D = v('--line2'), L = v('--line'), A = v('--accent'), BG = v('--bg'), G = v('--grid') || L, LABEL = v('--font-label') || 'sans-serif';
    const quiet = still();
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ln = (x0, y0, x1, y1, col, w) => { c.beginPath(); c.strokeStyle = col; c.lineWidth = w || 1; c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); };
    const ring = (x, y, rx, ry, rot, col, w) => { c.beginPath(); c.strokeStyle = col; c.lineWidth = w || 1; c.ellipse(x, y, rx, ry, rot || 0, 0, 6.2832); c.stroke(); };
    const dot = (x, y, r, col, hollow) => { c.beginPath(); c.arc(x, y, r, 0, 6.2832); if (hollow) { c.fillStyle = BG; c.fill(); c.strokeStyle = col; c.lineWidth = 1; c.stroke(); } else { c.fillStyle = col; c.fill(); } };
    // Glyphs are drawn as images in the theme colour; a still frame is drawn again once they load.
    const GI = {};
    const gimg = (id, col) => {
      const k = id + col;
      if (!GI[k]) { const i = new Image(); i.onload = () => { if (quiet) frame(4000); }; i.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="' + col + '">' + GLYPH[id] + '</svg>'); GI[k] = i; }
      return GI[k];
    };
    const glyph = (id, x, y, s, col, rot) => { const i = gimg(id, col); if (!i.complete || !i.naturalWidth) return; c.save(); c.translate(x, y); if (rot) c.rotate(rot); c.drawImage(i, -s / 2, -s / 2, s, s); c.restore(); };
    const label = (t, x, y, col) => { c.fillStyle = col; c.font = '600 14px ' + LABEL; c.fillText(t, x, y); };
    // The scatter mode keeps its drifting squares between frames.
    const sq = [];
    for (let i = 0; i < 150; i++) { const cl = i % 3; sq.push([cl === 0 ? 60 + rnd() * 220 : cl === 1 ? 480 + rnd() * 290 : 300 + rnd() * 160, cl === 2 ? 200 + rnd() * 110 : 48 + rnd() * 262, rnd() * 6.28, rnd() < 0.25]); }
    function frame(t) {
      const T = quiet ? 4000 : t;
      c.fillStyle = BG; c.fillRect(0, 0, W, H);
      c.fillStyle = G; for (let x = 0; x <= W; x += 20) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 20) c.fillRect(0, y, W, 1);
      c.fillStyle = L; for (let x = 0; x <= W; x += 100) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 100) c.fillRect(0, y, W, 1);
      if (kind === 'warp') {
        // A sheet of space dented by a moving mass.
        const mx = W / 2 + Math.cos(T * 0.0004) * 160, my = H / 2 + Math.sin(T * 0.0006) * 40;
        const pt = (x, y) => { const dx = x - mx, dy = y - my, f = 70 * Math.exp(-(dx * dx + dy * dy) / 9000), d = Math.hypot(dx, dy) || 1; return [x - dx / d * f * 0.6, y - dy / d * f * 0.6 + f * 0.5]; };
        c.strokeStyle = D; c.lineWidth = 1;
        for (let y = 30; y <= H - 30; y += 20) { c.beginPath(); for (let x = 40; x <= W - 40; x += 8) { const p = pt(x, y); x === 40 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1]); } c.stroke(); }
        for (let x = 40; x <= W - 40; x += 20) { c.beginPath(); for (let y = 30; y <= H - 30; y += 8) { const p = pt(x, y); y === 30 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1]); } c.stroke(); }
        dot(mx, my + 30, 22, INK); ring(mx, my + 30, 48, 12, 0, A, 1.5);
        label('WARP', 28, 28, INK); glyph('pinwheel', W - 44, 40, 30, INK, T * 0.001);
      } else if (kind === 'scatter') {
        // Grid blocks with node squares, and a drift of hollow squares.
        for (const b of [[90, 60, 180, 180, 12], [520, 40, 200, 120, 20], [330, 180, 140, 140, 10]]) {
          c.strokeStyle = D; c.lineWidth = 1; c.strokeRect(b[0] + 0.5, b[1] + 0.5, b[2], b[3]);
          for (let x = b[0]; x < b[0] + b[2]; x += b[4]) ln(x + 0.5, b[1], x + 0.5, b[1] + b[3], L);
          for (let y = b[1]; y < b[1] + b[3]; y += b[4]) ln(b[0], y + 0.5, b[0] + b[2], y + 0.5, L);
          c.fillStyle = A; for (const [u, w] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1]]) c.fillRect(b[0] + u * b[2] - 3, b[1] + w * b[3] - 3, 7, 7);
        }
        ring(620, 230, 70, 70, 0, D, 1);
        for (const s of sq) {
          const a = s[2] + T * 0.0003, x = s[0] + Math.cos(a) * 14, y = s[1] + Math.sin(a * 1.3) * 10;
          if (s[3]) { c.fillStyle = INK; c.fillRect(x, y, 3, 3); } else { c.strokeStyle = INK; c.lineWidth = 1; c.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, 5, 5); }
        }
        label('SCATTER', 28, 28, INK); glyph('plusgrid', W - 60, H - 44, 40, INK); glyph('steps', 250, 286, 22, A);
      } else if (kind === 'loops') {
        // A Lissajous figure slowly changing phase, beside its key.
        const cx = W * 0.36, cy = H / 2, ph = T * 0.0003;
        for (const [k, col] of [[0.9, D], [0.45, D], [0, INK]]) {
          c.strokeStyle = col; c.lineWidth = 1; c.beginPath();
          for (let i = 0; i <= 900; i++) { const u = i / 900 * 6.2832, x = cx + Math.sin(3 * u + ph + k) * 150, y = cy + Math.sin(2 * u) * 130; i ? c.lineTo(x, y) : c.moveTo(x, y); }
          c.stroke();
        }
        const u = T * 0.001; dot(cx + Math.sin(3 * u + ph) * 150, cy + Math.sin(2 * u) * 130, 6, A);
        for (let k = 0; k < 7; k++) ring(W * 0.72, 36 + k * 40, 10, 18, 0, D, 1);
        ln(W * 0.72, 18, W * 0.72, H - 18, D); glyph('atom', W * 0.86, H * 0.32, 58, INK, T * 0.0002); glyph('flower', W * 0.93, H * 0.14, 18, A); glyph('dots', W * 0.86, H * 0.78, 44, D);
        label('LOOPS  3 : 2', 28, 28, INK);
      } else {
        // A small system: tilted orbits, a sun, planets and a dotted transfer.
        const cx = W * 0.42, cy = H / 2;
        dot(cx, cy, 16, INK); ring(cx, cy, 40, 40, 0, D, 1);
        const orbs = [[90, 34, -0.3, 0.0011, 4, INK], [150, 60, 0.25, 0.0007, 7, A], [230, 92, -0.12, 0.0004, 5, INK], [300, 120, 0.08, 0.00025, 9, INK]];
        for (const o of orbs) {
          ring(cx, cy, o[0], o[1], o[2], D, 1);
          const a = T * o[3] + o[0], x = Math.cos(a) * o[0], y = Math.sin(a) * o[1], r = o[2];
          dot(cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r), o[4], o[5], o === orbs[2]);
        }
        c.fillStyle = D; for (let i = 0; i < 30; i++) { const a = -1.2 + i * 0.05; c.fillRect(W * 0.82 + Math.cos(a) * 120 - 1, H * 0.5 + Math.sin(a) * 120 - 1, 2, 2); }
        ln(W * 0.86, 30, W * 0.94, 30, INK); ln(W * 0.94, 30, W * 0.94, H - 30, INK); glyph('burst', W * 0.9, H * 0.72, 26, A, T * 0.0005); glyph('lens', W * 0.13, H * 0.78, 30, INK);
        for (let i = 0; i < 5; i++) { c.strokeStyle = INK; c.strokeRect(W * 0.88 + 0.5, 60 + i * 26 + 0.5, 16, 16); if (i < 2) { c.fillStyle = INK; c.fillRect(W * 0.88 + 4, 64 + i * 26, 9, 9); } }
        label('ORBIT', 28, 28, INK);
      }
    }
    return frame;
  }

  // A canvas showing the Scope in the given mode. It animates until it is taken off the page.
  // Colours are read when it starts, so a new colour scheme or accent needs a new canvas.
  function canvas(design, scene) {
    const cv = document.createElement('canvas');
    cv.id = 'holo'; cv.width = 800; cv.height = 340; cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'A thin-line scope display: ' + (LABELS[scene] || LABELS.orbit));
    requestAnimationFrame(() => {
      const frame = scope(cv, scene);
      const tick = (t) => { if (!cv.isConnected) return; frame(t); if (!still()) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    return cv;
  }

  // The screen-change scan: a sheet of grid paper with an accent edge passes down the page. The stylesheet draws it.
  function transition() {
    const app = document.getElementById('app'), crt = document.getElementById('crt');
    if (!app || !crt) return;
    app.classList.remove('glitch'); crt.classList.remove('run');
    void app.offsetWidth;
    app.classList.add('glitch'); crt.classList.add('run');
    // Tidy up afterwards, so nothing is left parked over or under the page.
    // Only their own animations count: ones inside the page bubble up too.
    const done = (node, cls) => { const off = (e) => { if (e.target !== node) return; node.classList.remove(cls); node.removeEventListener('animationend', off); }; node.addEventListener('animationend', off); };
    done(crt, 'run'); done(app, 'glitch');
  }

  return { canvas, transition };
})();
