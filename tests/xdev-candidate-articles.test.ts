import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateList,
  hydrateArticleCandidates,
  type ArticleFetcher,
} from '../src/pipelines/xdev/analyzer.js';
import type { ExtractedTweet } from '../src/pipelines/xdev/contracts.js';

function tweet(overrides: Partial<ExtractedTweet>): ExtractedTweet {
  return {
    id: '1',
    url: 'https://x.com/someone/status/1',
    authorName: 'Someone',
    authorHandle: '@someone',
    text: 'hello',
    views: 1000,
    externalLinks: [],
    blogs: [],
    isMultiAgentRelated: true,
    ...overrides,
  };
}

test('candidate list marks X Articles and carries the pre-fetched body', () => {
  const list = buildCandidateList([
    tweet({
      id: '2116857257245987236',
      authorHandle: '@DeepSeekHarness',
      text: 'ArticleExploring Super-agent Design: Towards a More Autonomous Agent System',
      views: 3196230,
      isXArticle: true,
      articleUrl: 'https://x.com/DeepSeekHarness/article/2116857257245987236',
      blogs: [
        {
          url: 'https://x.com/DeepSeekHarness/article/2116857257245987236',
          title: 'Exploring Super-agent Design',
          content: 'Over the past year, coding agents have shown that models can use tools to solve long tasks. '.repeat(5),
          excerpt: 'Over the past year…',
        },
      ],
    }),
    tweet({ id: '2', authorHandle: '@plain', text: 'a plain tweet' }),
  ]);

  assert.match(list, /\[候选 #0\][\s\S]*类型: X 原生长文（Article），正文已预取/);
  assert.match(list, /长文正文（前 1500 字）:/);
  assert.match(list, /无（原生长文: https:\/\/x\.com\/DeepSeekHarness\/article\/2116857257245987236）/);
  assert.match(list, /\[候选 #1\][\s\S]*类型: 普通推文/);
  assert.doesNotMatch(list.split('[候选 #1]')[1], /长文正文/);
});

test('un-hydrated X Article is labelled as title-only (so the reviewer knows)', () => {
  const list = buildCandidateList([
    tweet({ isXArticle: true, articleUrl: 'https://x.com/a/article/9', text: 'ArticleTitle only' }),
  ]);
  assert.match(list, /正文未预取（仅标题）/);
});

test('hydration fetches Article bodies by views, respecting the budget', async () => {
  const fetched: string[] = [];
  const fetcher: ArticleFetcher = {
    async fetchArticleContent(url: string) {
      fetched.push(url);
      return { title: `title for ${url}`, content: 'x'.repeat(500), excerpt: 'excerpt' };
    },
  };

  const tweets = [
    tweet({ id: '1', views: 10, isXArticle: true, articleUrl: 'https://x.com/a/article/1' }),
    tweet({ id: '2', views: 5000, isXArticle: true, articleUrl: 'https://x.com/a/article/2' }),
    tweet({ id: '3', views: 100, isXArticle: true, articleUrl: 'https://x.com/a/article/3' }),
    tweet({ id: '4', views: 99999, isXArticle: false, externalLinks: ['https://blog.example.com/x'] }),
    tweet({
      id: '5',
      views: 99998,
      isXArticle: true,
      articleUrl: 'https://x.com/a/article/5',
      blogs: [{ url: 'https://x.com/a/article/5', content: 'already fetched', excerpt: '' }],
    }),
  ];

  const result = await hydrateArticleCandidates(tweets, fetcher, { limit: 2 });

  assert.deepEqual(fetched, ['https://x.com/a/article/2', 'https://x.com/a/article/3']);
  assert.equal(result.hydrated, 2);
  assert.equal(result.failed, 0);
  // article 5 already had a body, article 1 fell outside the budget
  assert.equal(result.skipped, 2);
  assert.equal(tweets[1].blogs[0].content.length, 500);
  assert.equal(tweets[2].blogs[0].url, 'https://x.com/a/article/3');
  assert.equal(tweets[0].blogs.length, 0);
});

test('a body too short to judge is reported as failed, not silently accepted', async () => {
  const fetcher: ArticleFetcher = {
    async fetchArticleContent() {
      return { title: 't', content: 'too short', excerpt: '' };
    },
  };
  const tweets = [tweet({ isXArticle: true, articleUrl: 'https://x.com/a/article/1' })];
  const result = await hydrateArticleCandidates(tweets, fetcher, { minChars: 200 });
  assert.equal(result.hydrated, 0);
  assert.equal(result.failed, 1);
  assert.equal(tweets[0].blogs.length, 0);
});

test('a fetch error does not abort the whole batch', async () => {
  const fetcher: ArticleFetcher = {
    async fetchArticleContent(url: string) {
      if (url.endsWith('/1')) throw new Error('boom');
      return { title: 't', content: 'y'.repeat(400), excerpt: '' };
    },
  };
  const tweets = [
    tweet({ id: '1', views: 200, isXArticle: true, articleUrl: 'https://x.com/a/article/1' }),
    tweet({ id: '2', views: 100, isXArticle: true, articleUrl: 'https://x.com/a/article/2' }),
  ];
  const result = await hydrateArticleCandidates(tweets, fetcher);
  assert.equal(result.failed, 1);
  assert.equal(result.hydrated, 1);
  assert.equal(tweets[1].blogs.length, 1);
});
