// Radial wipe with a noisy organic edge and a warm bloom ring.
vec4 transition(vec2 uv) {
  float k = easeOutCubic(progress);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  float angle = atan(p.y, p.x);
  float radius = length(p);

  float n = noise2(vec2(angle * 2.5, uSeed * 0.37)) * 0.12;
  float threshold = k * 0.95 + n;
  float reveal = smoothstep(threshold + 0.02, threshold - 0.02, radius);

  vec4 from = sampleFrom(uv);
  vec4 to = sampleTo(uv);
  vec4 outColor = mix(from, to, reveal);

  // Bloom ring riding the wipe edge
  float ring = smoothstep(0.05, 0.0, abs(radius - threshold));
  outColor.rgb += uAccent * ring * 0.55 * sin(progress * 3.14159265);
  return outColor;
}
