// Noise displacement: both frames are pushed by a shared noise field whose
// amplitude peaks mid-transition.
vec4 transition(vec2 uv) {
  float k = sin(progress * 3.14159265);
  float amount = 0.045 * k * uAmplitude;
  vec2 disp = vec2(
    noise2(uv * vec2(ratio, 1.0) * 6.0 + vec2(uSeed, 0.0)),
    noise2(uv * vec2(ratio, 1.0) * 6.0 + vec2(0.0, uSeed + 3.7))
  ) - 0.5;

  vec4 from = sampleFrom(clamp(uv + disp * amount, 0.001, 0.999));
  vec4 to = sampleTo(clamp(uv - disp * amount, 0.001, 0.999));
  vec4 outColor = mix(from, to, smoothstep(0.2, 0.8, progress));

  // Ember accent riding the displacement ridges
  float ridge = smoothstep(0.45, 0.5, abs(disp.x) + abs(disp.y)) * k;
  outColor.rgb += uAccent * ridge * 0.35;
  return outColor;
}
