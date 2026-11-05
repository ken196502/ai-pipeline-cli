// Luma scanline glitch wipe: horizontal bands sweep down, with RGB offset and
// random band jitter driven by a deterministic hash of the band index.
vec4 transition(vec2 uv) {
  float k = easeInOutCubic(progress);

  // Sweep boundary with a noisy edge
  float band = floor(uv.y * 48.0);
  float jitter = (hash21(vec2(band, uSeed)) - 0.5) * 0.06;
  float edge = k + jitter * (1.0 - abs(k - 0.5) * 2.0);
  float reveal = step(uv.y, edge);

  // RGB split during the sweep
  float ca = 0.006 * sin(progress * 3.14159265) * uAmplitude;
  vec4 from = sampleFrom(uv);
  vec4 fromR = sampleFrom(uv + vec2(ca, 0.0));
  vec4 fromB = sampleFrom(uv - vec2(ca, 0.0));
  from.r = fromR.r;
  from.b = fromB.b;

  vec4 to = sampleTo(uv);
  vec4 toR = sampleTo(uv + vec2(ca, 0.0));
  vec4 toB = sampleTo(uv - vec2(ca, 0.0));
  to.r = toR.r;
  to.b = toB.b;

  // Glowing scan beam at the boundary
  float beam = smoothstep(0.06, 0.0, abs(uv.y - edge)) * sin(progress * 3.14159265);
  vec3 beamColor = uAccent * beam * 0.85;

  vec4 outColor = mix(from, to, reveal);
  outColor.rgb += beamColor;
  return outColor;
}
