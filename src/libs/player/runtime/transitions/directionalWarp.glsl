// Directional warp + cross-zoom dissolve.
// Interface: gl-transitions style `vec4 transition(vec2 uv)`.
// The outgoing frame is pushed aside and slightly zoomed while the incoming
// frame settles in from the opposite side, with a subtle RGB split.
vec4 transition(vec2 uv) {
  float k = easeInOutCubic(progress);
  float dir = uDirection;

  // Outgoing: push away + zoom in
  vec2 uvFrom = uv + vec2(dir * 0.16 * k, 0.0);
  uvFrom = (uvFrom - 0.5) / (1.0 + 0.10 * k) + 0.5;
  vec4 from = sampleFrom(uvFrom);

  // Incoming: settle in from the other side
  vec2 uvTo = uv - vec2(dir * 0.16 * (1.0 - k), 0.0);
  uvTo = (uvTo - 0.5) / (0.94 + 0.06 * k) + 0.5;
  vec4 to = sampleTo(uvTo);

  // Chromatic split grows towards the middle of the transition
  float ca = 0.0035 * sin(progress * 3.14159265) * uAmplitude;
  vec4 fromR = sampleFrom(uvFrom + vec2(ca, 0.0));
  vec4 toR = sampleTo(uvTo + vec2(ca, 0.0));

  vec4 mixed = mix(from, to, k);
  mixed.r = mix(fromR.r, toR.r, k);
  return mixed;
}
