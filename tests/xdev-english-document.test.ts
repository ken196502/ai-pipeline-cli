import test from 'node:test';
import assert from 'node:assert';
import { buildArticleDocument, validateDocument } from '../src/pipelines/xdev/article-document.js';
import { convertMarkdownToStandaloneHtml } from '../src/pipelines/xdev/html-exporter.js';
import { generateImageFromEnv } from '../src/pipelines/xdev/image-generator.js';

test('buildArticleDocument produces 100% English citation and reference bibliography', () => {
  const sampleMarkdown = `# Decentralized Agent Memory Orchestration

The proliferation of autonomous agents introduces significant state management challenges. As systems scale across multiple execution environments, maintaining a coherent view of state becomes increasingly complex.

## The State Disconnect

Distributed agent systems struggle with state consistency across long-running sessions. When agents operate without coordinated storage, context drifts rapidly.

## Architectural Solution

By unifying state management into a content-addressed DAG, agents achieve deterministic replayability and atomic traceability.

## Pragmatic Engineering Rollout

Engineering teams adopting this architecture must establish strict boundaries between ephemeral execution and durable memory stores.`;

  const sampleSource = {
    authorName: 'Alex Mercer',
    authorHandle: 'alexmercer',
    tweetUrl: 'https://x.com/alexmercer/status/1234567890',
    tweetText: 'We solved multi-agent state divergence with content-addressed DAGs and edge persistence.',
    links: [
      { url: 'https://example.com/blog/agent-dag', title: 'Deep Dive: Agent DAGs' },
    ],
  };

  const doc = buildArticleDocument(sampleMarkdown, sampleSource);

  // 1. Title must be English
  assert.strictEqual(doc.title, 'Decentralized Agent Memory Orchestration');

  // 2. Lead citation must use English tokens
  const leadQuoteMeta = doc.blocks.find(
    (b) => b.type === 'paragraph' && b.text.includes('Original Post:')
  );
  assert.ok(leadQuoteMeta, 'Citation paragraph must contain "Original Post:"');
  assert.strictEqual(/原推文/.test(leadQuoteMeta.text), false, 'Lead citation must not contain "原推文"');

  // 3. Bibliography section heading must be "Sources & Further Reading"
  const refHeading = doc.blocks.find(
    (b) => b.type === 'heading' && b.text === 'Sources & Further Reading'
  );
  assert.ok(refHeading, 'Bibliography heading must be "Sources & Further Reading"');
  assert.strictEqual(
    doc.blocks.some((b) => b.type === 'heading' && b.text.includes('信源与延伸阅读')),
    false,
    'Bibliography heading must not contain "信源与延伸阅读"'
  );

  // 4. Bibliography list items must use English tokens
  const refList = doc.blocks.find((b) => b.type === 'list');
  assert.ok(refList, 'Bibliography list must exist');
  assert.ok(
    refList.items.some((item) => item.startsWith('Original post (@alexmercer):')),
    'List item must start with "Original post"'
  );
  assert.strictEqual(
    refList.items.some((item) => /原推文/.test(item)),
    false,
    'List item must not contain "原推文"'
  );

  // 5. Overall document CJK verification
  const issues = validateDocument(doc, true);
  assert.deepStrictEqual(issues, [], 'Document should pass validation with 0 issues');
});

test('generateImageFromEnv rejects prompt with Chinese characters immediately', async () => {
  await assert.rejects(
    async () => {
      await generateImageFromEnv({
        prompt: 'Minimalist illustration: 上下文与代码变更的原子性绑定',
        outputPath: '/tmp/test.png',
      });
    },
    /Prompt contains Chinese characters/,
    'Must fail fast when prompt contains Chinese characters'
  );
});

test('convertMarkdownToStandaloneHtml produces English html tag and title', async () => {
  const md = '# High-Throughput Memory Bus for Multi-Agent Systems\n\nDetailed breakdown of memory buses.';
  const html = await convertMarkdownToStandaloneHtml(md, '/tmp');
  assert.ok(html.includes('<html lang="en">'), 'HTML lang must be en');
  assert.ok(
    html.includes('<title>High-Throughput Memory Bus for Multi-Agent Systems</title>'),
    'HTML title must match markdown H1 title'
  );
  assert.strictEqual(html.includes('架构演进与落地真谛'), false, 'HTML must not have hardcoded Chinese title');
});
