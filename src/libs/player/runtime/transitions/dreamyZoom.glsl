// Dreamy zoom: rotation + scale drift with a soft cross dissolve.
vec4 transition(vec2 uv) {
  float k = easeInOutCubic(progress);
  float angle = 0.12 * uAmplitude * k;
  float scale = 1.0 + 0.25 * k;

  vec2 centered = uv - 0.5;
  centered.x *= ratio;
  float cs = cos(angle);
  float sn = sin(angle);
  vec2 rotated = vec2(centered.x * cs - centered.y * sn, centered.x * sn + centered.y * cs);
  rotated.x /= ratio;
  vec2 uvFrom = rotated / scale + 0.5;

  float angle2 = -0.12 * uAmplitude * (1.0 - k);
  float scale2 = 1.25 - 0.25 * k;
  float cs2 = cos(angle2);
  float sn2 = sin(angle2);
  vec2 rotated2 = vec2(centered.x * cs2 - centered.y * sn2, centered.x * sn2 + centered.y * cs2);
  vec2 uvTo = rotated2 / scale2 + 0.5;

  vec4 from = sampleFrom(clamp(uvFrom, 0.001, 0.999));
  vec4 to = sampleTo(clamp(uvTo, 0.001, 0.999));
  return mix(from, to, smoothstep(0.15, 0.85, progress));
}
