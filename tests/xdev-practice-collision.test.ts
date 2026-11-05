import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRACTICE_COLLISION_POINTS,
  getCollisionPoint,
  selectCollisionPointId,
  DEFAULT_COLLISION_POINT_ID,
} from '../src/pipelines/xdev/practice-collision.js';

test('collision pool has exactly the three required points with unique ids', () => {
  const ids = PRACTICE_COLLISION_POINTS.map((p) => p.id);
  assert.equal(ids.length, 3);
  assert.deepEqual([...new Set(ids)].sort(), ids.sort());
  for (const id of ['git-cli-repo', 'existing-infra', 'shared-workspace-not-memory']) {
    assert.ok(ids.includes(id), `missing collision point ${id}`);
  }
});

test('every collision point frames itself as the author personal experience, not a tweet claim', () => {
  for (const p of PRACTICE_COLLISION_POINTS) {
    assert.match(p.experienceStatementZh, /基于我的工程实践|我的经验|我的建议|我的判断/);
    assert.match(p.experienceStatementEn, /my own (engineering|production) practice|my (experience|lesson|judgment)/i);
    assert.match(p.experienceStatementEn, /not a claim (made )?by the source tweet/i);
    assert.ok(p.synthesisLensEn.includes('{{EXPERIENCE_EN}}'));
  }
});

test('selectCollisionPointId reads an explicit token from LLM output', () => {
  const llm = '契合度结论: [有契合点]\nselectedCollisionPointId: existing-infra\n## 1.';
  assert.equal(selectCollisionPointId(llm, 'some topic'), 'existing-infra');
});

test('selectCollisionPointId falls back to keyword relevance when no explicit token', () => {
  // Topic about memory/context => shared-workspace-not-memory should win.
  const topic = 'why agent memory and shared context window matter for RAG search';
  assert.equal(selectCollisionPointId('no token here', topic), 'shared-workspace-not-memory');
  // Topic about telegram/tmux/alerting => existing-infra should win.
  const topic2 = 'run long tasks in tmux and alert via telegram for observability';
  assert.equal(selectCollisionPointId('no token here', topic2), 'existing-infra');
});

test('selectCollisionPointId never returns an id outside the pool', () => {
  const llm = 'selectedCollisionPointId: not-a-real-id';
  const got = selectCollisionPointId(llm, 'multi-agent tool calling and regression replay');
  assert.ok(PRACTICE_COLLISION_POINTS.some((p) => p.id === got));
  // git-cli-repo hints (multi-agent/tool/regression/replay) dominate this topic.
  assert.equal(got, 'git-cli-repo');
});

test('getCollisionPoint resolves pool entries and DEFAULT points to git-cli-repo', () => {
  assert.equal(getCollisionPoint('git-cli-repo')?.id, 'git-cli-repo');
  assert.equal(getCollisionPoint('does-not-exist'), undefined);
  assert.equal(DEFAULT_COLLISION_POINT_ID, 'git-cli-repo');
});
