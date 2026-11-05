import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaIdentityLedger, findCrossClipDuplicateKeyframes } from '../src/flow/media-ledger.js';

const CLIP5_START_URL =
  'https://flow-content.google/image/b2f44b14-d573-44f1-881e-178931c53bdf?Expires=1793745806&KeyName=k&Signature=s';
const CLIP5_END_URL =
  'https://flow-content.google/image/9325206b-4dd2-4993-89a7-0e38faaa0e0a?Expires=1793745858&KeyName=k&Signature=s';

/** Regression fixture: the exact script state from run flowTutor-1793720826350-iv53k8. */
const SCRIPT_CLIPS = [
  { clipIndex: 4, imageUrl: 'https://flow-content.google/image/e6dccd3c-0cf5-4547-8766-439eacdc7a59?a=1', endImageUrl: 'https://flow-content.google/image/a23ed7dc-bb59-4763-9986-af35ff424176?a=1' },
  { clipIndex: 5, imageUrl: CLIP5_START_URL, imageTileKey: 'b2f44b14-d573-44f1-881e-178931c53bdf', endImageUrl: CLIP5_END_URL, endImageTileKey: '9325206b-4dd2-4993-89a7-0e38faaa0e0a' },
  { clipIndex: 6 },
];

test('ledger seeds every clip so clip 6 can no longer re-consume clip 5 keyframes', async () => {
  const ledger = await MediaIdentityLedger.seedFromScriptClips(SCRIPT_CLIPS);

  // Both clip-5 keyframes are consumed media, including after a URL re-sign.
  assert.ok(ledger.has(CLIP5_START_URL));
  assert.ok(ledger.has(CLIP5_END_URL));
  assert.equal(ledger.ownerOf('https://flow-content.google/image/b2f44b14-d573-44f1-881e-178931c53bdf?Expires=999&Signature=other'), 'clip-005 start');
  assert.equal(ledger.ownerOf('b2f44b14-d573-44f1-881e-178931c53bdf'), 'clip-005 start');

  // The exclude set handed to BOTH clip-6 image generations contains clip-5 start AND end.
  const exclude = ledger.snapshot();
  assert.ok(exclude.includes('b2f44b14-d573-44f1-881e-178931c53bdf'));
  assert.ok(exclude.includes('9325206b-4dd2-4993-89a7-0e38faaa0e0a'));
});

test('ledger reports newly generated media as consumed and unknown media as fresh', async () => {
  const ledger = await MediaIdentityLedger.seedFromScriptClips([]);
  assert.equal(ledger.has('https://flow-content.google/image/11111111-1111-4111-8111-111111111111?x=1'), false);

  ledger.add('clip-001 start', ['https://flow-content.google/image/11111111-1111-4111-8111-111111111111?x=1']);
  assert.equal(ledger.ownerOf('https://flow-content.google/image/11111111-1111-4111-8111-111111111111?x=2'), 'clip-001 start');
  assert.equal(ledger.ownerOf('https://flow-content.google/image/22222222-2222-4222-8222-222222222222?x=1'), null);
});

test('cross-clip duplicate detection finds the clip-006 == clip-005 corruption', () => {
  const corrupted = [
    { clipIndex: 5, imageUrl: CLIP5_START_URL, imageTileKey: 'b2f44b14-d573-44f1-881e-178931c53bdf', endImageUrl: CLIP5_END_URL, endImageTileKey: '9325206b-4dd2-4993-89a7-0e38faaa0e0a' },
    { clipIndex: 6, imageUrl: CLIP5_START_URL, imageTileKey: 'b2f44b14-d573-44f1-881e-178931c53bdf', endImageUrl: CLIP5_END_URL, endImageTileKey: '9325206b-4dd2-4993-89a7-0e38faaa0e0a' },
  ];
  const findings = findCrossClipDuplicateKeyframes(corrupted);
  assert.deepEqual(
    findings.map((f) => `${f.clipIndex}:${f.field}<-${f.ownerClipIndex}`).sort(),
    ['6:end<-5', '6:start<-5']
  );

  // A healthy script has no findings.
  assert.deepEqual(findCrossClipDuplicateKeyframes(SCRIPT_CLIPS), []);
});

test('keyframe content hash backstop detects byte-identical re-downloads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-ledger-'));
  try {
    const first = path.join(dir, 'clip-005-start.jpg');
    const duplicate = path.join(dir, 'clip-006-start.jpg');
    const other = path.join(dir, 'clip-006-end.jpg');
    await writeFile(first, Buffer.from('same-bytes-payload'));
    await writeFile(duplicate, Buffer.from('same-bytes-payload'));
    await writeFile(other, Buffer.from('different-payload'));

    const ledger = await MediaIdentityLedger.seedFromScriptClips([{ clipIndex: 5, localImagePath: first }]);
    assert.equal(await ledger.registerKeyframe('clip-006 start', duplicate), 'clip-005 start');
    assert.equal(await ledger.registerKeyframe('clip-006 end', other), null);
    assert.equal(await ledger.registerKeyframe('clip-006 end', null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
