// Cross zoom: the outgoing frame zooms in past the camera while the incoming
// frame zooms out into place.
vec4 transition(vec2 uv) {
  float k = easeInOutCubic(progress);
  float strength = 0.55 * uAmplitude;

  vec2 uvFrom = (uv - 0.5) / (1.0 - k * strength) + 0.5;
  vec2 uvTo = (uv - 0.5) / (1.0 - strength + k * strength) + 0.5;

  vec4 from = sampleFrom(uvFrom);
  vec4 to = sampleTo(uvTo);

  float blend = smoothstep(0.25, 0.75, progress);
  vec4 outColor = mix(from, to, blend);
  // Bright flash through the middle of the move
  outColor.rgb += vec3(1.0) * sin(progress * 3.14159265) * 0.12;
  return outColor;
}
