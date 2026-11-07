/**
 * Local development launcher for the host render service.
 *
 * The production service is `host-render/server.mjs`, a generated, dependency-
 * minimal file that ships inside every explainer bundle (see host-script.ts).
 * This wrapper materialises those same templates under `.tmp/render-service/`
 * and spawns the generated server, so `npm run render-service` exercises exactly
 * the code the macOS host will run.
 *
 * Usage:
 *   npm run render-service -- --port 8790 --gpu metal --bind 192.168.64.1 --token <secret>
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import {
  HOST_RENDER_DIRNAME,
  HOST_RENDER_SERVER_FILENAME,
  writeHostRenderScript,
} from './host-script.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stagingDir = path.join(projectRoot, '.tmp', 'render-service');

const written = await writeHostRenderScript({ explainerDir: stagingDir });
console.log(pc.cyan(`[render-service] generated ${HOST_RENDER_DIRNAME}/${HOST_RENDER_SERVER_FILENAME} from templates`));
console.log(pc.dim(`[render-service] launching ${written.serverPath}`));

const child = spawn(process.execPath, [written.serverPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

const forward = (signal: NodeJS.Signals) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('error', (err) => {
  console.error(pc.red(`[render-service] failed to launch the service: ${err.message}`));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(pc.yellow(`[render-service] service exited on ${signal}`));
    process.exit(1);
  }
  process.exit(code ?? 1);
});
