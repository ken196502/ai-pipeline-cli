#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import pc from 'picocolors';
import { transcribeAudio, checkPuterAsrReady } from './transcribe.js';
import { testAsrLib } from './index.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('asr')
    .description('Puter.js Speech-to-Text ASR CLI: transcribe audio/video files and URLs')
    .argument('[file-or-url]', 'Audio or video file path, or remote URL')
    .option('-m, --model <model>', 'Transcription model (gpt-4o-transcribe, whisper-1, etc.)', 'gpt-4o-transcribe')
    .option('-t, --translate', 'Translate non-English speech to English', false)
    .option('--token <token>', 'Puter auth token (overrides env PUTER_AUTH_TOKEN)')
    .option('--test', 'Run ASR self-test routine', false)
    .option('--test-mode', 'Invoke Puter in test mode without deducting user credits', false)
    .action(async (fileOrUrl, opts) => {
      if (opts.test) {
        console.log(pc.cyan('\n🔍 Running Puter ASR Self-Test...'));
        const testRes = await testAsrLib();
        console.log(`Puter API Reachable: ${testRes.apiReachable ? pc.green('YES') : pc.red('NO')}`);
        console.log(`FFmpeg Available:   ${testRes.ffmpegAvailable ? pc.green('YES') : pc.red('NO')}`);
        console.log(`Token Configured:   ${testRes.configured ? pc.green('YES') : pc.yellow('NO (set PUTER_AUTH_TOKEN)')}`);
        if (testRes.testModePassed !== undefined) {
          console.log(`Driver test-mode:   ${testRes.testModePassed ? pc.green('PASSED') : pc.red('FAILED')}`);
        }
        if (testRes.errors.length > 0) {
          console.error(pc.red(`Errors: ${testRes.errors.join(', ')}`));
          await exitAfterFlush(1, 'asr:test');
        }
        console.log(pc.green('✓ ASR Lib is working properly.'));
        await exitAfterFlush(0, 'asr:test');
      }

      if (!fileOrUrl) {
        console.log(pc.yellow('Please provide a file path or URL to transcribe, or run with --test'));
        const ready = await checkPuterAsrReady();
        console.log(`Puter ASR Token status: ${ready.configured ? pc.green('Configured') : pc.yellow('Not configured')}`);
        await exitAfterFlush(0, 'asr:help');
      }

      console.log(pc.cyan(`\n🎙️ Transcribing: ${fileOrUrl}...`));
      try {
        const result = await transcribeAudio(
          fileOrUrl,
          {
            model: opts.model,
            translate: opts.translate,
            authToken: opts.token,
            testMode: opts.testMode,
          },
          (stg, msg) => console.log(pc.dim(`[asr:${stg}] ${msg}`))
        );

        console.log(pc.green('\n✓ Transcription Complete:'));
        console.log(pc.white(result.text));
        if (result.durationSeconds) {
          console.log(pc.dim(`Duration: ${result.durationSeconds.toFixed(1)}s | Model: ${result.model || 'default'}`));
        }
        await exitAfterFlush(0, 'asr');
      } catch (err: any) {
        console.error(pc.red(`\n❌ Transcription failed: ${err.message}`));
        await exitAfterFlush(1, 'asr');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('asr/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
