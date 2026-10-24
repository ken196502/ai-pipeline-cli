delete process.env.HF_TOKEN;
import { synthesizeQwen3Tts } from '../libs/player/tts.js';

async function testNoToken() {
  try {
    delete process.env.HF_TOKEN;
    console.log('Testing WITHOUT token on current IP...');
    const res = await synthesizeQwen3Tts('测试不带Token。', { timeoutMs: 40000, maxRetries: 1 });
    console.log(`[NO TOKEN SUCCESS] Generated ${res.durationSec}s audio!`);
  } catch (e: any) {
    console.log(`[NO TOKEN FAILED]:`, e.message);
  }
}

testNoToken().catch(console.error);
