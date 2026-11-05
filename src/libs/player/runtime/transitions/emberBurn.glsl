// Ember burn: the outgoing frame burns away from a noisy front with an orange
// glow; the incoming frame is revealed underneath.
vec4 transition(vec2 uv) {
  float n = noise2(uv * vec2(ratio, 1.0) * 4.0 + vec2(uSeed * 0.11, uSeed * 0.07));
  float front = mix(-0.15, 1.15, progress) + (n - 0.5) * 0.22;
  float burned = smoothstep(front - 0.04, front + 0.04, uv.y);

  vec4 from = sampleFrom(uv);
  vec4 to = sampleTo(uv);
  vec4 outColor = mix(from, to, burned);

  // Burning edge glow (ember orange, fades with the accent colour)
  float edge = smoothstep(0.07, 0.0, abs(uv.y - front));
  vec3 burnColor = mix(uAccent, vec3(1.0, 0.55, 0.15), 0.45);
  outColor.rgb += burnColor * edge * 1.1;

  // Charred darkening just above the front
  float charred = smoothstep(front + 0.10, front, uv.y) * (1.0 - burned);
  outColor.rgb *= 1.0 - charred * 0.45;
  return outColor;
}
