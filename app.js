'use strict';
/* Estúdio de Camisetas — motor WebGL2 + interface */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const SIDES = {
  frente: { src: 'assets/frente.jpg', label: 'Frente', def: { cx: 0.502, cy: 0.43, w: 0.30 } },
  costas: { src: 'assets/costas.jpg', label: 'Costas', def: { cx: 0.503, cy: 0.46, w: 0.38 } },
};
// Área ocupada pela camiseta nas fotos (união frente/costas), em fração da imagem.
const BBOX = { x0: 0.049, x1: 0.958, y0: 0.168, y1: 0.84 };

const FORMATS = [
  { id: 'feed', label: 'Feed 4:5', w: 1080, h: 1350 },
  { id: 'orig', label: '3:4', w: 1500, h: 2000 },
  { id: 'quad', label: '1:1', w: 1080, h: 1080 },
  { id: 'story', label: 'Story', w: 1080, h: 1920 },
];

const COLORS = [
  { name: 'Preto (foto original)', hex: null, show: '#141416' },
  { name: 'Off-white', hex: '#e9e4d8' },
  { name: 'Branco', hex: '#f4f4f2' },
  { name: 'Areia', hex: '#cbb996' },
  { name: 'Cinza', hex: '#8b8c8e' },
  { name: 'Chumbo', hex: '#3b3c40' },
  { name: 'Marrom', hex: '#4b3527' },
  { name: 'Verde militar', hex: '#414b35' },
  { name: 'Azul marinho', hex: '#1c2842' },
  { name: 'Vinho', hex: '#5b1f29' },
];

const state = {
  side: 'frente',
  color: null,            // null = foto original
  texture: 0.45, disp: 0.4, opacity: 0.97,
  format: FORMATS[0], quality: 1,
  sides: {
    frente: { art: null, ...SIDES.frente.def },
    costas: { art: null, ...SIDES.costas.def },
  },
};

/* ---------------------------------------------------------------- WebGL */

const canvas = $('gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });

const VS = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPhoto, uMap, uDispMap, uArt;
uniform vec4 uView;            // x0,y0,w,h do enquadramento, em uv da foto
uniform vec2 uDispTexel;
uniform vec3 uBg, uColor;
uniform float uRecolor, uNorm, uGamma, uInv;
uniform float uHasArt, uTexture, uDisp, uOpacity;
uniform vec2 uArtC, uArtS;

void main(){
  vec2 uv = uView.xy + vUv*uView.zw;
  vec2 cuv = clamp(uv, 0., 1.);
  float inside = step(0.,uv.x)*step(uv.x,1.)*step(0.,uv.y)*step(uv.y,1.);
  vec4 m = texture(uMap, cuv);
  float a = m.g*inside;          // cobertura do tecido
  float ratio = m.r*2.;          // luminância do tecido / média (relevo + lavagem)
  vec3 photo = texture(uPhoto, cuv).rgb;

  // No preto o relevo aparece como realce; em cores claras ele vira sombra (uInv).
  float rr = max(ratio, .2);
  float rel = mix(rr, 1./rr, uInv);
  vec3 dyed = min(uColor*pow(rel/uNorm, uGamma), 1.);
  vec3 shirt = mix(photo, dyed, uRecolor);
  float am = mix(smoothstep(0., .04, a), a, uRecolor);
  vec3 col = mix(uBg, shirt, am);

  if(uHasArt > .5){
    // A estampa acompanha as dobras: desloca pelo gradiente do relevo suavizado.
    float gx = texture(uDispMap, cuv+vec2(uDispTexel.x,0.)).r - texture(uDispMap, cuv-vec2(uDispTexel.x,0.)).r;
    float gy = texture(uDispMap, cuv+vec2(0.,uDispTexel.y)).r - texture(uDispMap, cuv-vec2(0.,uDispTexel.y)).r;
    vec2 d = vec2(gx,gy)*uDisp*uDispTexel;
    vec2 auv = (uv + d - uArtC)/uArtS + .5;
    vec2 fw = fwidth(auv);
    vec2 q = smoothstep(vec2(0.), fw, auv)*smoothstep(vec2(0.), fw, 1.-auv);
    vec4 art = texture(uArt, auv, -.5)*(q.x*q.y);   // alfa pré-multiplicado
    float low = texture(uDispMap, cuv).r;        // luz e sombra das dobras
    float f = clamp(pow(max(m.b*2.,1e-3), uTexture)*pow(max(low,1e-3), uTexture*.6), .5, 1.4);
    float k = uOpacity*a;
    col = col*(1.-art.a*k) + min(art.rgb*f, vec3(art.a))*k;
  }
  o = vec4(col, 1.);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

let prog, U = {}, aniso = null, maxTex = 4096;
const tex = { frente: {}, costas: {} };

function initGL() {
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(prog, i); U[u.name] = gl.getUniformLocation(prog, u.name); }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(U.uPhoto, 0); gl.uniform1i(U.uMap, 1); gl.uniform1i(U.uDispMap, 2); gl.uniform1i(U.uArt, 3);
  aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
}

function makeTex(source, { mip = true, premult = false } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premult);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  setParams(mip);
  return t;
}
function setParams(mip) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  if (mip) {
    gl.generateMipmap(gl.TEXTURE_2D);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
}

/* ------------------------------------------- pré-processamento da foto */

// Desfoque de caixa separável (soma corrida), in-place.
function boxBlur(src, w, h, r, passes = 1) {
  const tmp = new Float32Array(src.length), inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let i = -r; i <= r; i++) s += src[o + clamp(i, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s * inv;
        s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = s * inv;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return src;
}

// Extrai da foto: máscara do tecido, relevo (luz/sombra + lavagem) e mapa de dobras.
function analyzePhoto(img) {
  const w = img.naturalWidth, h = img.naturalHeight, n = w * h;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255;

  // Fundo: média dos quatro cantos.
  let bg = [0, 0, 0], bgL = 0, cnt = 0;
  for (const [x0, y0] of [[0, 0], [w - 24, 0], [0, h - 24], [w - 24, h - 24]])
    for (let y = y0; y < y0 + 24; y++) for (let x = x0; x < x0 + 24; x++) {
      const j = (y * w + x) * 4; bg[0] += px[j]; bg[1] += px[j + 1]; bg[2] += px[j + 2]; bgL += lum[y * w + x]; cnt++;
    }
  bg = bg.map((v) => v / cnt / 255); bgL /= cnt;

  // Estatística do tecido.
  const hist = new Uint32Array(256); let sum = 0, m = 0;
  const rough = bgL * 0.35;
  for (let i = 0; i < n; i++) if (lum[i] < rough) { hist[Math.min(255, (lum[i] * 255) | 0)]++; sum += lum[i]; m++; }
  const mean = sum / m;
  const pct = (p) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= m * p) return i / 255; } return 1; };
  const T = pct(0.99) * 1.3;           // acima disso já é borda misturada com o fundo
  const p95 = pct(0.95) / mean;

  // Nas bordas, o relevo vem do interior vizinho (evita halo ao recolorir).
  const S = new Float32Array(n), I = new Float32Array(n);
  for (let i = 0; i < n; i++) if (lum[i] < T) { S[i] = lum[i]; I[i] = 1; }
  boxBlur(S, w, h, 4, 2); boxBlur(I, w, h, 4, 2);
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) shade[i] = (lum[i] < T ? lum[i] : (I[i] > 1e-3 ? S[i] / I[i] : mean)) / mean;

  // Mapa de dobras: relevo em 1/4 da resolução, bem suavizado.
  const dw = Math.ceil(w / 4), dh = Math.ceil(h / 4), disp = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0, k = 0;
    for (let yy = y * 4; yy < Math.min(h, y * 4 + 4); yy++) for (let xx = x * 4; xx < Math.min(w, x * 4 + 4); xx++) { s += shade[yy * w + xx]; k++; }
    disp[y * dw + x] = s / k;
  }
  boxBlur(disp, dw, dh, 6, 3);

  // Textura fina: leve suavização para tirar o ruído do JPEG sem perder o grão.
  // Separa o grão da trama (alta frequência) das manchas da lavagem, que não afetam a tinta.
  const low = shade.slice(); boxBlur(low, w, h, 5, 2);
  boxBlur(shade, w, h, 1, 1);

  const map = new Uint8Array(n * 4), den = 1 / (bgL - T);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    map[j] = clamp(shade[i] * 127.5, 0, 255);
    map[j + 1] = clamp((bgL - lum[i]) * den, 0, 1) * 255;
    map[j + 2] = clamp(shade[i] / low[i] * 127.5, 0, 255);
    map[j + 3] = 255;
  }
  return { w, h, map, disp, dw, dh, bg, p95 };
}

// onload em vez de decode(): decode() pode ficar pendente com a aba em segundo plano.
const loadImage = (src) => new Promise((res, rej) => {
  const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('Falha ao carregar ' + src)); img.src = src;
});

async function loadSide(id) {
  const img = await loadImage(SIDES[id].src);
  const a = analyzePhoto(img);
  const t = tex[id];
  t.photo = makeTex(img);
  t.map = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t.map);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, a.w, a.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, a.map); setParams(true);
  t.disp = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t.disp);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, a.dw, a.dh, 0, gl.RED, gl.FLOAT, a.disp); setParams(false);
  Object.assign(t, { w: a.w, h: a.h, dw: a.dw, dh: a.dh, bg: a.bg, p95: a.p95 });
}

/* --------------------------------------------------------------- render */

function viewFor(fmt) {
  if (fmt.id === 'orig') return [0, 0, 1, 1];
  const W = 1500, H = 2000, A = fmt.w / fmt.h, pad = 1.16;
  const bw = (BBOX.x1 - BBOX.x0) * W * pad, bh = (BBOX.y1 - BBOX.y0) * H * pad;
  let vw = bw, vh = bw / A; if (vh < bh) { vh = bh; vw = bh * A; }
  const cx = (BBOX.x0 + BBOX.x1) / 2 * W, cy = (BBOX.y0 + BBOX.y1) / 2 * H;
  return [(cx - vw / 2) / W, (cy - vh / 2) / H, vw / W, vh / H];
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// Altura da arte em uv da foto, dado a largura.
const artH = (s, t) => s.w * (s.art.h / s.art.w) * (t.w / t.h);

function draw(sideId = state.side) {
  const t = tex[sideId], s = state.sides[sideId];
  if (!t.photo) return;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.photo);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.map);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t.disp);
  gl.uniform4fv(U.uView, viewFor(state.format));
  gl.uniform2f(U.uDispTexel, 1 / t.dw, 1 / t.dh);
  gl.uniform3fv(U.uBg, t.bg);
  if (state.color) {
    const c = hexToRgb(state.color), L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    gl.uniform3fv(U.uColor, c);
    gl.uniform1f(U.uRecolor, 1);
    gl.uniform1f(U.uNorm, 1 + (t.p95 - 1) * L);     // cores claras: realces não estouram
    gl.uniform1f(U.uGamma, 1 - 0.78 * Math.pow(L, 1.5));   // lavagem mais suave em cores claras
    gl.uniform1f(U.uInv, clamp((L - 0.6) / 0.25, 0, 1));
  } else gl.uniform1f(U.uRecolor, 0);
  gl.uniform1f(U.uHasArt, s.art ? 1 : 0);
  if (s.art) {
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, s.art.tex);
    gl.uniform2f(U.uArtC, s.cx, s.cy);
    gl.uniform2f(U.uArtS, s.w, artH(s, t));
    gl.uniform1f(U.uTexture, state.texture * 2.5);
    gl.uniform1f(U.uDisp, state.disp * 60);
    gl.uniform1f(U.uOpacity, state.opacity);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

let dirty = false;
function invalidate() {
  if (dirty) return; dirty = true;
  requestAnimationFrame(() => { dirty = false; draw(); layoutSel(); });
}

/* ------------------------------------------------------ palco e seleção */

const stage = $('stage'), wrap = $('stageWrap'), sel = $('sel'), guide = $('guide');
let cssW = 0, cssH = 0;

function fitStage() {
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const A = state.format.w / state.format.h;
  cssW = Math.max(50, Math.min(aw, ah * A)); cssH = cssW / A;
  stage.style.width = cssW + 'px'; stage.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  draw(); layoutSel();
}

function layoutSel() {
  const s = state.sides[state.side], t = tex[state.side];
  const has = !!s.art && !!t.photo;
  sel.hidden = !has; $('dropHint').hidden = has || !t.photo;
  if (!has) return;
  const v = viewFor(state.format), h = artH(s, t);
  sel.style.left = ((s.cx - s.w / 2 - v[0]) / v[2]) * cssW + 'px';
  sel.style.top = ((s.cy - h / 2 - v[1]) / v[3]) * cssH + 'px';
  sel.style.width = (s.w / v[2]) * cssW + 'px';
  sel.style.height = (h / v[3]) * cssH + 'px';
}

const centerX = () => SIDES[state.side].def.cx;
function setGuide(on) {
  guide.hidden = !on;
  if (on) { const v = viewFor(state.format); guide.style.left = ((centerX() - v[0]) / v[2]) * cssW + 'px'; }
}

// Gestos: arrastar move, alças/pinça/roda redimensionam.
const pts = new Map(); let gest = null;
const cur = () => state.sides[state.side];
const toUv = (e) => {
  const r = stage.getBoundingClientRect(), v = viewFor(state.format);
  return [v[0] + ((e.clientX - r.left) / r.width) * v[2], v[1] + ((e.clientY - r.top) / r.height) * v[3]];
};
const setW = (w) => { cur().w = clamp(w, 0.04, 1.2); };

stage.addEventListener('pointerdown', (e) => {
  if (!cur().art || e.target.closest('button')) return;
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ponteiro já liberado */ }
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  const s = cur(), uv = toUv(e);
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    gest = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), w0: s.w };
  } else if (e.target.dataset.h) {
    const t = tex[state.side], ar = t.w / t.h;
    gest = { type: 'size', d0: Math.hypot((uv[0] - s.cx) * ar, uv[1] - s.cy), w0: s.w };
  } else gest = { type: 'move', u0: uv, cx0: s.cx, cy0: s.cy };
});
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !gest) return;
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  const s = cur(), uv = toUv(e);
  if (gest.type === 'pinch' && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    setW(gest.w0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / gest.d0);
  } else if (gest.type === 'size') {
    const t = tex[state.side], ar = t.w / t.h;
    setW(gest.w0 * Math.hypot((uv[0] - s.cx) * ar, uv[1] - s.cy) / Math.max(gest.d0, 1e-4));
  } else if (gest.type === 'move') {
    let cx = gest.cx0 + uv[0] - gest.u0[0];
    const snap = Math.abs(cx - centerX()) < 0.008;
    if (snap) cx = centerX();
    setGuide(snap);
    s.cx = clamp(cx, 0, 1); s.cy = clamp(gest.cy0 + uv[1] - gest.u0[1], 0, 1);
  }
  syncUI(); invalidate();
});
const endPtr = (e) => { pts.delete(e.pointerId); if (pts.size === 0) { gest = null; setGuide(false); } else if (gest && gest.type === 'pinch') gest = null; };
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('wheel', (e) => {
  if (!cur().art) return; e.preventDefault();
  setW(cur().w * Math.exp(-e.deltaY * 0.0012)); syncUI(); invalidate();
}, { passive: false });
window.addEventListener('keydown', (e) => {
  const s = cur(); if (!s.art || e.target.tagName === 'INPUT') return;
  const step = (e.shiftKey ? 10 : 1) / 1500;
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!d) return; e.preventDefault();
  s.cx = clamp(s.cx + d[0] * step, 0, 1); s.cy = clamp(s.cy + d[1] * step * 0.75, 0, 1); invalidate();
});

/* ------------------------------------------------------- importar arte */

function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}

async function importArt(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Escolha um arquivo de imagem (PNG sem fundo).');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    let iw = img.naturalWidth, ih = img.naturalHeight;
    if (file.type === 'image/svg+xml' || iw < 8) { const k = 3000 / Math.max(iw || 300, ih || 300); iw = Math.round((iw || 300) * k); ih = Math.round((ih || 300) * k); }

    // Localiza a área útil (recorta margens transparentes) numa cópia reduzida.
    const k = Math.min(1, 640 / Math.max(iw, ih));
    const pw = Math.max(1, Math.round(iw * k)), ph = Math.max(1, Math.round(ih * k));
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph;
    const pctx = pc.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(img, 0, 0, pw, ph);
    const d = pctx.getImageData(0, 0, pw, ph).data;
    let x0 = pw, y0 = ph, x1 = -1, y1 = -1, opaque = 0;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const a = d[(y * pw + x) * 4 + 3];
      if (a > 6) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (a > 250) opaque++;
    }
    if (x1 < 0) return toast('Essa imagem está totalmente transparente.');
    if (opaque === pw * ph) toast('Atenção: essa arte não tem fundo transparente — o fundo dela vai aparecer na camiseta.', 6000);

    const sx = Math.max(0, Math.floor((x0 - 1) / k)), sy = Math.max(0, Math.floor((y0 - 1) / k));
    const sw = Math.min(iw, Math.ceil((x1 + 2) / k)) - sx, sh = Math.min(ih, Math.ceil((y1 + 2) / k)) - sy;
    const f = Math.min(1, maxTex / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * f)), ch = Math.max(1, Math.round(sh * f));
    const ac = document.createElement('canvas'); ac.width = cw; ac.height = ch;
    const actx = ac.getContext('2d');
    actx.imageSmoothingQuality = 'high';
    const r = iw / img.naturalWidth || 1;      // SVG: desenha já ampliado
    actx.drawImage(img, sx / r, sy / r, sw / r, sh / r, 0, 0, cw, ch);

    const s = cur();
    if (s.art) gl.deleteTexture(s.art.tex);
    s.art = { tex: makeTex(ac, { premult: true }), w: cw, h: ch, name: file.name };
    Object.assign(s, SIDES[state.side].def);
    syncUI(); invalidate();
  } catch (err) {
    console.error(err); toast('Não consegui abrir essa imagem.');
  } finally { URL.revokeObjectURL(url); }
}

$('file').addEventListener('change', (e) => { importArt(e.target.files[0]); e.target.value = ''; });
document.querySelectorAll('[data-act=import]').forEach((b) => b.addEventListener('click', () => $('file').click()));
['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove('over'); }));
window.addEventListener('drop', (e) => importArt(e.dataTransfer.files[0]));
window.addEventListener('paste', (e) => { const f = [...e.clipboardData.files][0]; if (f) importArt(f); });

/* ------------------------------------------------------------ controles */

function syncUI() {
  const s = cur(), has = !!s.art;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.side === state.side));
  $('tagFrente').textContent = state.sides.frente.art ? state.sides.frente.art.name : 'sem arte';
  $('tagCostas').textContent = state.sides.costas.art ? state.sides.costas.art.name : 'sem arte';
  for (const id of ['btnRemove', 'rngSize', 'btnCenter', 'btnReset']) $(id).disabled = !has;
  $('btnImport').textContent = has ? 'Trocar arte' : 'Importar arte';
  if (has) {
    $('rngSize').value = s.w * 100;
    // Largura real aproximada: o corpo da camiseta (~57% da foto) mede ~58 cm num oversized.
    $('outSize').textContent = `≈ ${Math.round(s.w / 0.57 * 58)} cm de largura`;
  } else $('outSize').textContent = '–';
  $('outTex').textContent = Math.round(state.texture * 100) + '%';
  $('outDisp').textContent = Math.round(state.disp * 100) + '%';
  $('outOp').textContent = Math.round(state.opacity * 100) + '%';
  const f = state.format, q = state.quality;
  $('outDims').textContent = `Saída: ${f.w * q} × ${f.h * q} px, em PNG (sem perda de qualidade).`;
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { state.side = b.dataset.side; syncUI(); invalidate(); }));
$('btnRemove').onclick = () => { const s = cur(); gl.deleteTexture(s.art.tex); s.art = null; syncUI(); invalidate(); };
$('btnCenter').onclick = () => { cur().cx = centerX(); invalidate(); };
$('btnReset').onclick = () => { Object.assign(cur(), SIDES[state.side].def); syncUI(); invalidate(); };
$('rngSize').oninput = (e) => { setW(e.target.value / 100); syncUI(); invalidate(); };
$('rngTex').oninput = (e) => { state.texture = e.target.value / 100; syncUI(); invalidate(); };
$('rngDisp').oninput = (e) => { state.disp = e.target.value / 100; syncUI(); invalidate(); };
$('rngOp').oninput = (e) => { state.opacity = e.target.value / 100; syncUI(); invalidate(); };

function buildSwatches() {
  const box = $('swatches');
  const mark = (el) => { box.querySelectorAll('.sw').forEach((x) => x.classList.remove('on')); el.classList.add('on'); };
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === 0 ? ' on' : ''); b.title = c.name; b.style.background = c.show || c.hex;
    b.onclick = () => { state.color = c.hex; mark(b); invalidate(); };
    box.appendChild(b);
  });
  const cu = document.createElement('label'); cu.className = 'sw custom'; cu.title = 'Outra cor';
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = '#2f5d50';
  inp.oninput = () => { state.color = inp.value; mark(cu); invalidate(); };
  cu.appendChild(inp); box.appendChild(cu);
}

function buildFormats() {
  const box = $('segFmt');
  FORMATS.forEach((f) => {
    const b = document.createElement('button'); b.textContent = f.label; b.classList.toggle('on', f === state.format);
    b.onclick = () => { state.format = f; box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); syncUI(); fitStage(); };
    box.appendChild(b);
  });
  $('segQ').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.quality = +b.dataset.q; $('segQ').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); syncUI();
  });
}

/* ------------------------------------------------------------- exportar */

async function renderBlob(sideId) {
  const f = state.format, q = state.quality;
  canvas.width = f.w * q; canvas.height = f.h * q;
  draw(sideId);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new File([blob], `camiseta-${sideId}-${f.w * q}x${f.h * q}.png`, { type: 'image/png' });
}
async function renderFiles(ids) {
  const out = [];
  try { for (const id of ids) out.push(await renderBlob(id)); }
  finally { fitStage(); }
  return out;
}
function download(file) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('btnExport').onclick = async () => { (await renderFiles([state.side])).forEach(download); toast('Imagem salva.'); };
$('btnExportBoth').onclick = async () => {
  const files = await renderFiles(['frente', 'costas']);
  download(files[0]); setTimeout(() => download(files[1]), 500); toast('Frente e costas salvas.');
};
if (navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] })) {
  $('btnShare').hidden = false;
  $('btnShare').onclick = async () => {
    const files = await renderFiles(['frente', 'costas']);
    try { await navigator.share({ files }); } catch (e) { /* cancelado */ }
  };
}

/* ----------------------------------------------------------------- init */

(async function init() {
  if (!gl) { $('loading').textContent = 'Este navegador não tem WebGL2. Atualize o navegador para usar o estúdio.'; return; }
  try {
    initGL(); buildSwatches(); buildFormats(); syncUI();
    await loadSide('frente');
    new ResizeObserver(fitStage).observe(wrap);
    fitStage(); $('loading').hidden = true;
    await loadSide('costas'); invalidate();
  } catch (err) {
    console.error(err); $('loading').hidden = false;
    $('loading').textContent = 'Erro ao iniciar: ' + err.message;
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
})();
