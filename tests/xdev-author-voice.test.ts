import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateArticleBody } from '../src/pipelines/xdev/analyzer.js';

describe('validateArticleBody basic checks', () => {
  it('validates good English article with proper sections and intro', () => {
    const markdown = `# Building Autonomous CLI Agent Bedrocks

In this analysis, I examine the breakdown of autonomous agent workflows when context is kept ephemeral, referencing recent findings by [Alex (@alex)](https://x.com/alex/123). I argue that anchoring multi-agent coordination in a deterministic Git repository is the decisive pattern for production reliability.

## The Cognitive Ceiling of Session-Bound Context
A single agent session degrades when long tasks span multiple hours. In my engineering practice, I found that maintaining state outside the prompt is essential.

## Decoupling via Shared Repositories
Rather than stuffing memory into context, I place artifacts in a Git worktree.

## Architectural Takeaways and Pragmatic Rollout
In conclusion, adopting a Git-backed CLI execution bedrock transforms probabilistic LLM loops into auditable systems. The first step is to mandate deterministic commits for every state change.
`;
    const issues = validateArticleBody(markdown, 'agent context failure git commit');
    assert.deepEqual(issues, []);
  });
});
