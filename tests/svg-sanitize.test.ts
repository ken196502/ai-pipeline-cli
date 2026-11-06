import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg, assertWellFormedSvg, SvgXmlError } from '../src/libs/svg/sanitize-svg.js';

const VALID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 460">
  <rect width="900" height="460" fill="#F8FAFC"/>
  <text x="20" y="40" font-size="18">Hello</text>
</svg>`;

test('valid SVG passes through untouched', () => {
  const { svg, repairs } = sanitizeSvg(VALID);
  assert.deepEqual(repairs, []);
  assert.equal(svg, VALID);
  assert.doesNotThrow(() => assertWellFormedSvg(svg));
});

test('unclosed <style> is closed and the document becomes renderable', () => {
  // Exactly the 2026-11-05 failure: `<style>` with CSS but no `</style>`,
  // which made librsvg report "Opening and ending tag mismatch: style … svg".
  const broken = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 460">
  <style>
    .t-title { font-size: 21px; }
  <rect width="900" height="460" fill="#F8FAFC"/>
  <text x="20" y="40" class="t-title">Hi</text>
</svg>`;

  assert.throws(() => assertWellFormedSvg(broken), SvgXmlError);

  const { svg, repairs } = sanitizeSvg(broken);
  assert.ok(repairs.some((r) => r.kind === 'unclosed' && r.detail.includes('<style>')));
  assert.doesNotThrow(() => assertWellFormedSvg(svg));
  assert.ok(svg.includes('</style>'));
  assert.ok(svg.includes('<rect'));
});

test('unclosed <g> is closed at end of document', () => {
  const broken = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><rect width="10" height="10"/></svg>`;
  const { svg, repairs } = sanitizeSvg(broken);
  assert.ok(repairs.some((r) => r.kind === 'implicit-close' && r.detail.includes('<g>')));
  assert.doesNotThrow(() => assertWellFormedSvg(svg));
  assert.ok(svg.includes('</g>'));
});

test('bare ampersands are escaped, existing entities are preserved', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>AT&T &amp; R&amp;D &#169;</text></svg>`;
  const { svg: fixed, repairs } = sanitizeSvg(svg);
  assert.ok(repairs.some((r) => r.kind === 'escape-ampersand'));
  assert.ok(fixed.includes('AT&amp;T'));
  assert.ok(fixed.includes('&amp; R&amp;D'));
  assert.ok(fixed.includes('&#169;'));
  assert.doesNotThrow(() => assertWellFormedSvg(fixed));
});

test('CDATA content keeps its literal ampersand', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style><![CDATA[ text { content: "a&b"; } ]]></style></svg>`;
  const { svg: fixed } = sanitizeSvg(svg);
  assert.ok(fixed.includes('a&b'));
  assert.doesNotThrow(() => assertWellFormedSvg(fixed));
});

test('script blocks and event handlers are stripped', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" onclick="x()"/></svg>`;
  const { svg: fixed, repairs } = sanitizeSvg(svg);
  assert.ok(!fixed.includes('<script'));
  assert.ok(!fixed.includes('onload='));
  assert.ok(!fixed.includes('onclick='));
  assert.ok(repairs.some((r) => r.kind === 'strip-script'));
  assert.ok(repairs.some((r) => r.kind === 'strip-event-handler'));
});

test('stray closing tag is dropped instead of poisoning the document', () => {
  const broken = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></span><rect width="10" height="10"/></svg>`;
  const { svg, repairs } = sanitizeSvg(broken);
  assert.ok(repairs.some((r) => r.kind === 'drop-stray-close' && r.detail.includes('</span>')));
  assert.ok(!svg.includes('</span>'));
  assert.doesNotThrow(() => assertWellFormedSvg(svg));
});

test('missing xmlns is added to the root element', () => {
  const svg = `<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
  const { svg: fixed, repairs } = sanitizeSvg(svg);
  assert.ok(repairs.some((r) => r.kind === 'add-xmlns'));
  assert.ok(fixed.includes('xmlns="http://www.w3.org/2000/svg"'));
});

test('XML prologue and DOCTYPE are stripped', () => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
  const { svg: fixed, repairs } = sanitizeSvg(svg);
  assert.ok(!fixed.includes('<?xml'));
  assert.ok(!fixed.includes('<!DOCTYPE'));
  assert.ok(repairs.some((r) => r.kind === 'strip-xml-prologue'));
  assert.ok(repairs.some((r) => r.kind === 'strip-doctype'));
});

test('validator rejects a non-svg root and an empty document', () => {
  assert.throws(() => assertWellFormedSvg('<html><body/></html>'), SvgXmlError);
  assert.throws(() => assertWellFormedSvg('   '), SvgXmlError);
});

test('validator reports the offending line in the message', () => {
  const broken = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <g>
  <rect width="10" height="10"/>
</svg>`;
  try {
    assertWellFormedSvg(broken, 'diagram');
    assert.fail('expected SvgXmlError');
  } catch (err) {
    assert.ok(err instanceof SvgXmlError);
    assert.match(err.message, /\[diagram\] invalid SVG XML/);
    assert.match(err.message, /line \d+/);
  }
});
