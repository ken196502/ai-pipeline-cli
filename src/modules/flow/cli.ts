#!/usr/bin/env node
/**
 * Flow Module CLI Script.
 * Supports login, quota inspection, prompt generation, batch synthesis, and --test mode.
 */
import { Command } from 'commander';
import pc from 'picocolors';
import { testFlowModule } from './index.js';
import { FlowClient } from '../../flow/client.js';

const program = new Command();
const client = new FlowClient();

program
  .name('module-flow')
  .description('Google Flow Video Generation Module Script')
  .version('1.0.0')
  .option('--test', 'Run standalone flow module self-test and exit');

program
  .command('login')
  .description('Authenticate with Google Flow in persistent profile')
  .option('--profile-dir <path>', 'Custom Chromium profile directory')
  .action(async (opts) => {
    await client.login({ profileDir: opts.profileDir });
  });

program
  .command('quota')
  .description('Read the live Google Flow credit balance (top-right avatar panel)')
  .option('--profile-dir <path>', 'Custom Chromium profile directory')
  .option('--headed', 'Launch browser headed for debugging')
  .action(async (opts) => {
    const quota = await client.checkQuota({
      profileDir: opts.profileDir,
      headed: Boolean(opts.headed),
    });
    console.log(pc.cyan('\n=== Google Flow Live Credit Balance ==='));
    console.log(`Flow Credits:      ${pc.bold(pc.green(String(quota.actualCredits)))} (live from flow.google.com)`);
    console.log(`Cost per Video:    ${quota.costPerVideo} credits`);
    console.log();
  });

program.action(async (options) => {
  if (options.test) {
    console.log(pc.bold(pc.cyan('=== Testing Flow Module Script in Isolation ===')));
    const result = await testFlowModule();
    if (result.success) {
      console.log(pc.green('✓ Live-credit quota helper test passed (snapshot + sufficiency gate)'));
      console.log(pc.green('✓ Flow video URL observer & demo filtering passed'));
      console.log(pc.bold(pc.green('=== Flow Module Script Test Passed ===')));
      process.exit(0);
    } else {
      console.error(pc.red(`✗ Flow module test failed: ${result.errors.join(', ')}`));
      process.exit(1);
    }
  }

  program.help();
});

program.parse(process.argv);
