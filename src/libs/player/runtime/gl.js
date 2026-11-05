// WebGL renderer: shader transitions + GPU post-processing (halation, chromatic
// aberration, shoulder roll-off, contrast, vignette, grain, flash).
//
// Pipeline (per frame):
//   scene 2D canvas A (from) ─┐
//   scene 2D canvas B (to)   ─┤ texImage2D
//                             ▼
//   Pass 1  transition.frag (gl-transitions interface)  → FBO
//           (non-transition frames skip this pass entirely)
//   Pass 2  post.frag  → #stage
//
// Every shader is GLSL ES 1.00, so the same source works on WebGL1 and WebGL2
// and gl-transitions shaders can be dropped in verbatim.

import { env } from './env.js';
import { hexToRgb } from './util.js';

import directionalWarp from './transitions/directionalWarp.glsl';
import lumaGlitch from './transitions/lumaGlitch.glsl';
import radialBloom from './transitions/radialBloom.glsl';
import crossZoom from './transitions/crossZoom.glsl';
import dreamyZoom from './transitions/dreamyZoom.glsl';
import displacement from './transitions/displacement.glsl';
import emberBurn from './transitions/emberBurn.glsl';

export const TRANSITION_SOURCES = {
  directionalWarp,
  lumaGlitch,
  radialBloom,
  crossZoom,
  dreamyZoom,
  displacement,
  emberBurn,
};

export function listTransitions() {
  return Object.keys(TRANSITION_SOURCES);
}

const VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const TRANSITION_PREAMBLE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
// Aspect ratio (W/H), gl-transitions convention: a plain float so shaders can
// write vec2(ratio, 1.0) for aspect-correct noise/warp coordinates.
uniform float ratio;
uniform float uSeed;
uniform float uAmplitude;
uniform vec3 uAccent;
uniform float uDirection;

vec4 getFromColor(vec2 uv) { return texture2D(from, uv); }
vec4 getToColor(vec2 uv) { return texture2D(to, uv); }

// Bilinear-friendly edge clamp so warped UVs never sample outside the frame.
vec4 sampleFrom(vec2 uv) { return texture2D(from, clamp(uv, 0.0005, 0.9995)); }
vec4 sampleTo(vec2 uv) { return texture2D(to, clamp(uv, 0.0005, 0.9995)); }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float easeInOutCubic(float p) {
  return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0;
}
float easeOutCubic(float p) { return 1.0 - pow(1.0 - p, 3.0); }
`;

const POST_FRAG_SRC = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uFlash;
uniform float uFrame;
uniform float uGrain;
uniform float uCA;
uniform float uVignette;
uniform float uContrast;
uniform float uHalation;
uniform float uRatio;
uniform vec3 uBone;
uniform float uSeed;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float shoulder(float v) {
  float k = 0.72;
  if (v <= k) return v;
  return k + (1.0 - k) * (1.0 - exp(-(v - k) / (1.0 - k)));
}
float smoothstepRange(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  vec2 uv = vUv;
  vec2 centered = uv - 0.5;
  vec2 ax = vec2(centered.x * uRatio, centered.y);
  float m = min(1.0, length(ax));
  float shift = uCA * m / 1000.0;

  vec3 col;
  col.r = texture2D(uScene, clamp(uv + vec2(shift, 0.0), 0.0005, 0.9995)).r;
  col.g = texture2D(uScene, uv).g;
  col.b = texture2D(uScene, clamp(uv - vec2(shift, 0.0), 0.0005, 0.9995)).b;

  col.r = shoulder(col.r);
  col.g = shoulder(col.g);
  col.b = shoulder(col.b);
  col = (col - 0.5) * uContrast + 0.5;

  float vlen = length(vec2(ax.x, ax.y * 0.8));
  float v = smoothstepRange(0.95, 0.25, vlen);
  col *= 1.0 - uVignette * (1.0 - v);

  vec3 bloom = texture2D(uBloom, uv).rgb;
  col += bloom * uHalation;

  col += uBone * uFlash;

  float lm = dot(col, vec3(0.299, 0.587, 0.114));
  float amt = uGrain * (0.55 + 1.2 * lm * (1.0 - lm));
  float n = hash21(uv * 1024.0 + vec2(uFrame * 7.13 + uSeed, uFrame * 3.71));
  float n2 = hash21(uv * 512.0 + vec2(uFrame * 2.37, uFrame * 5.19 + uSeed));
  col += (n * 0.6 + n2 * 0.4 - 0.5) * amt;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown compile error';
    // Point at the offending source line — driver logs are 1-based.
    const lines = source.split('\n');
    const match = /ERROR:\s*\d+:(\d+)/.exec(log);
    const lineNo = match ? Number(match[1]) : 0;
    const excerpt = lineNo > 0 ? `\n  ${lineNo}| ${(lines[lineNo - 1] || '').trim()}` : '';
    gl.deleteShader(shader);
    throw new Error('shader compile failed: ' + log + excerpt);
  }
  return shader;
}

function createProgram(gl, fragmentSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('program link failed: ' + log);
  }
  return program;
}

function createTexture(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Creates the WebGL renderer for #stage. Returns null when WebGL is
 * unavailable so the caller can fall back to Canvas2D.
 */
export function createGLRenderer(canvas) {
  const attrs = {
    preserveDrawingBuffer: true,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  };
  let gl = canvas.getContext('webgl2', attrs);
  let contextName = 'webgl2';
  if (!gl) {
    gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    contextName = 'webgl';
  }
  if (!gl) return null;

  const W = env.W;
  const H = env.H;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (maxTex < Math.max(W, H)) {
    env.warnings.push(`WebGL MAX_TEXTURE_SIZE ${maxTex} < frame size ${W}x${H}; falling back to Canvas2D`);
    return null;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texFrom = createTexture(gl, W, H);
  const texTo = createTexture(gl, W, H);
  const texTrans = createTexture(gl, W, H);
  const transFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, transFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTrans, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    env.warnings.push('WebGL transition framebuffer incomplete; falling back to Canvas2D');
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const postProgram = createProgram(gl, POST_FRAG_SRC);
  const transitionPrograms = new Map();

  function getTransitionProgram(name) {
    const key = name || 'directionalWarp';
    const cached = transitionPrograms.get(key);
    if (cached) return cached;
    const body = TRANSITION_SOURCES[key];
    if (!body) throw new Error(`unknown transition shader "${key}" — available: ${listTransitions().join(', ')}`);
    const program = createProgram(gl, TRANSITION_PREAMBLE + '\n' + body + '\nvoid main() { gl_FragColor = transition(vUv); }\n');
    transitionPrograms.set(key, program);
    return program;
  }

  const uniformCache = new Map();
  function uniform(program, name) {
    let entry = uniformCache.get(program);
    if (!entry) {
      entry = new Map();
      uniformCache.set(program, entry);
    }
    let loc = entry.get(name);
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name);
      entry.set(name, loc);
    }
    return loc;
  }

  function upload(tex, source) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  const accent = hexToRgb(env.ACCENT);
  const bone = hexToRgb(env.PAL.bone);
  const ratio = W / H;

  /**
   * Renders one frame.
   *   fromCanvas   outgoing frame (or the only frame)
   *   toCanvas     incoming frame, null when not transitioning
   *   progress     0..1 transition progress
   *   transition   shader name (null = passthrough)
   *   params       { seed, amplitude, direction }
   *   flash        0..1 white flash amount
   *   frameIndex   integer frame number (deterministic grain)
   *   bloomCanvas  low-res halation source
   */
  function render(frame) {
    const post = env.post;
    upload(texFrom, frame.fromCanvas);
    if (frame.toCanvas) upload(texTo, frame.toCanvas);

    let sceneTex = texFrom;

    if (frame.transition && frame.toCanvas) {
      const program = getTransitionProgram(frame.transition);
      gl.bindFramebuffer(gl.FRAMEBUFFER, transFbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texFrom);
      gl.uniform1i(uniform(program, 'from'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texTo);
      gl.uniform1i(uniform(program, 'to'), 1);
      gl.uniform1f(uniform(program, 'progress'), frame.progress);
      gl.uniform1f(uniform(program, 'ratio'), ratio);
      gl.uniform1f(uniform(program, 'uSeed'), frame.params && frame.params.seed != null ? frame.params.seed : 7);
      gl.uniform1f(
        uniform(program, 'uAmplitude'),
        frame.params && frame.params.amplitude != null ? frame.params.amplitude : 1.0
      );
      gl.uniform3f(uniform(program, 'uAccent'), accent[0] / 255, accent[1] / 255, accent[2] / 255);
      gl.uniform1f(
        uniform(program, 'uDirection'),
        frame.params && frame.params.direction != null ? frame.params.direction : 1
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      sceneTex = texTrans;
    }

    // Bloom / halation source (already blurred + tinted by the 2D canvas).
    if (frame.bloomCanvas) upload(texTo, frame.bloomCanvas);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(postProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(uniform(postProgram, 'uScene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texTo);
    gl.uniform1i(uniform(postProgram, 'uBloom'), 1);
    gl.uniform1f(uniform(postProgram, 'uFlash'), frame.flash || 0);
    gl.uniform1f(uniform(postProgram, 'uFrame'), frame.frameIndex || 0);
    gl.uniform1f(uniform(postProgram, 'uGrain'), post.grain);
    gl.uniform1f(uniform(postProgram, 'uCA'), post.chromaticAberration * env.S);
    gl.uniform1f(uniform(postProgram, 'uVignette'), post.vignette);
    gl.uniform1f(uniform(postProgram, 'uContrast'), post.contrast);
    gl.uniform1f(uniform(postProgram, 'uHalation'), post.halation);
    gl.uniform1f(uniform(postProgram, 'uRatio'), ratio);
    gl.uniform3f(uniform(postProgram, 'uBone'), bone[0] / 255, bone[1] / 255, bone[2] / 255);
    gl.uniform1f(uniform(postProgram, 'uSeed'), 11);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
  }

  return {
    mode: 'webgl',
    contextName,
    render,
    rendererInfo: (() => {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })(),
  };
}
