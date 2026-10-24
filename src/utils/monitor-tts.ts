import { synthesizeQwen3Tts } from '../libs/player/tts.js';

async function monitor() {
  console.log('Testing ZeroGPU availability with HF_TOKEN...');
  for (let i = 1; i <= 30; i++) {
    try {
      console.log(`[Attempt ${i}] Requesting TTS at ${new Date().toLocaleTimeString()}...`);
      const res = await synthesizeQwen3Tts('你好，测试。', { timeoutMs: 40000, maxRetries: 1 });
      console.log(`[SUCCESS at Attempt ${i}] Generated ${res.durationSec}s audio!`);
      return;
    } catch (e: any) {
      console.log(`[Attempt ${i} Failed]: ${e.message.slice(0, 110)}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

monitor().catch(console.error);
