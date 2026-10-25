import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import {
  acquirePipelineLock,
  findRunningPipelineProcesses,
  isProcessAlive,
  parsePipelineIdFromCommandLine,
  readPipelineLock,
  PipelineConflictError,
  PIPELINE_CONFLICT_CODE,
} from '../src/pipelines/core/lock.js';

const PIPELINE_IDS = ['xhot', 'flowTutor'];
const PROJECT_ROOT = '/mnt/share/VM/AIGC-pipeline';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-lock-test-'));
}

/** A pid that is guaranteed alive on Linux (init) — used to fake a foreign holder. */
const LIVE_FOREIGN_PID = 1;
const DEAD_PID = 999_999;

test('parsePipelineIdFromCommandLine recognizes real pipeline CLI invocations', () => {
  assert.equal(
    parsePipelineIdFromCommandLine(
      `node ${PROJECT_ROOT}/node_modules/.bin/tsx src/cli.ts flowTutor "AI make viral anime" --cookie-path /tmp/c.txt`,
      PIPELINE_IDS,
      { projectRoot: PROJECT_ROOT, cwd: PROJECT_ROOT }
    ),
    'flowTutor'
  );
  assert.equal(
    parsePipelineIdFromCommandLine(`node ${PROJECT_ROOT}/dist/cli.js xhot --24h`, PIPELINE_IDS, {
      projectRoot: PROJECT_ROOT,
    }),
    'xhot'
  );
  // Relative entry + unknown cwd still works when the absolute path is in the cmdline.
  assert.equal(
    parsePipelineIdFromCommandLine(
      `node ${PROJECT_ROOT}/node_modules/.bin/tsx src/cli.ts xhot "q"`,
      PIPELINE_IDS,
      { projectRoot: PROJECT_ROOT }
    ),
    'xhot'
  );

  // Not pipeline CLIs
  assert.equal(parsePipelineIdFromCommandLine('node src/modules/auth/cli.ts', PIPELINE_IDS), null);
  assert.equal(parsePipelineIdFromCommandLine('node src/cli.ts --help', PIPELINE_IDS), null);
  assert.equal(parsePipelineIdFromCommandLine('node src/cli.ts unknownpipeline', PIPELINE_IDS), null);
  assert.equal(parsePipelineIdFromCommandLine('bash -lc "sleep 10"', PIPELINE_IDS), null);

  // Regression: a shell / tmux / npm wrapper that merely MENTIONS a pipeline command
  // must never be mistaken for a running pipeline (this produced a false conflict).
  const wrapper =
    `/bin/bash -c cd ${PROJECT_ROOT} && tmux send-keys -t locktest 'npx tsx src/cli.ts xhot "conflict guard test" --dry-run' C-m`;
  assert.equal(parsePipelineIdFromCommandLine(wrapper, PIPELINE_IDS, { projectRoot: PROJECT_ROOT }), null);
  assert.equal(
    parsePipelineIdFromCommandLine('npm exec tsx src/cli.ts xhot --24h', PIPELINE_IDS, { projectRoot: PROJECT_ROOT }),
    null
  );
  // A node process running another project's CLI is not our pipeline.
  assert.equal(
    parsePipelineIdFromCommandLine('node /mnt/share/VM/OTHER-PROJECT/src/cli.ts xhot', PIPELINE_IDS, {
      projectRoot: PROJECT_ROOT,
    }),
    null
  );
});

test('findRunningPipelineProcesses filters by project root, pipeline id and excluded pids', async () => {
  const projectRoot = PROJECT_ROOT;
  const table = [
    `  100 node ${projectRoot}/node_modules/.bin/tsx src/cli.ts flowTutor "AI make viral anime"`,
    '   99 npm exec tsx src/cli.ts flowTutor "AI make viral anime"',
    `  200 node ${projectRoot}/node_modules/.bin/tsx src/cli.ts xhot "new model"`,
    '  300 node /mnt/share/VM/OTHER-PROJECT/node_modules/.bin/tsx src/cli.ts flowTutor "other project"',
    `  400 node ${projectRoot}/node_modules/.bin/tsx src/modules/auth/cli.ts`,
    `  500 /bin/bash -c cd ${projectRoot} && npx tsx src/cli.ts flowTutor "wrapper"`,
  ].join('\n');

  const found = await findRunningPipelineProcesses({
    projectRoot,
    pipelineIds: PIPELINE_IDS,
    readProcessTable: async () => table,
  });

  // One entry per pipeline id, node process preferred over its npx wrapper.
  assert.deepEqual(
    found.map((p) => ({ pid: p.pid, pipelineId: p.pipelineId })),
    [
      { pid: 100, pipelineId: 'flowTutor' },
      { pid: 200, pipelineId: 'xhot' },
    ]
  );

  // Excluded pids (current process + ancestors) are never reported.
  const filtered = await findRunningPipelineProcesses({
    projectRoot,
    pipelineIds: PIPELINE_IDS,
    excludePids: new Set([100, 200]),
    readProcessTable: async () => table,
  });
  assert.deepEqual(filtered, []);
});

test('findRunningPipelineProcesses never reports the current process itself', async () => {
  const projectRoot = '/proj';
  const table = `  ${process.pid} node ${projectRoot}/src/cli.ts xhot "self"`;
  const found = await findRunningPipelineProcesses({
    projectRoot,
    pipelineIds: PIPELINE_IDS,
    readProcessTable: async () => table,
  });
  assert.deepEqual(found, []);
});

test('acquirePipelineLock rejects a second run while a live lock is held', async () => {
  const dir = await makeTmpDir();
  const lockPath = path.join(dir, 'pipeline.lock');
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: LIVE_FOREIGN_PID,
      pipelineId: 'xhot',
      startedAt: '2026-01-01T00:00:00.000Z',
      command: 'node src/cli.ts xhot "new model"',
      token: 'foreign',
    })
  );

  await assert.rejects(
    () =>
      acquirePipelineLock({
        pipelineId: 'flowTutor',
        lockPath,
        projectRoot: dir,
        skipProcessScan: true,
      }),
    (err: any) => {
      assert.ok(err instanceof PipelineConflictError);
      assert.equal(err.code, PIPELINE_CONFLICT_CODE);
      assert.equal(err.holder.source, 'lock');
      assert.equal(err.holder.pipelineId, 'xhot');
      assert.equal(err.holder.pid, LIVE_FOREIGN_PID);
      assert.match(err.message, /Pipeline conflict detected/);
      assert.match(err.message, /xhot/);
      return true;
    }
  );

  // The foreign lock must be left untouched.
  const stillThere = await readPipelineLock(lockPath);
  assert.equal(stillThere?.token, 'foreign');
});

test('acquirePipelineLock reclaims a stale lock left by a dead process', async () => {
  const dir = await makeTmpDir();
  const lockPath = path.join(dir, 'pipeline.lock');
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: DEAD_PID, pipelineId: 'xhot', startedAt: '2026-01-01T00:00:00.000Z', token: 'stale' })
  );
  assert.equal(isProcessAlive(DEAD_PID), false);

  const lock = await acquirePipelineLock({
    pipelineId: 'flowTutor',
    lockPath,
    projectRoot: dir,
    skipProcessScan: true,
  });

  const info = await readPipelineLock(lockPath);
  assert.equal(info?.pid, process.pid);
  assert.equal(info?.pipelineId, 'flowTutor');

  await lock.release();
  assert.equal(await readPipelineLock(lockPath), null);

  // Re-acquiring after release must work (lock is not sticky).
  const again = await acquirePipelineLock({
    pipelineId: 'xhot',
    lockPath,
    projectRoot: dir,
    skipProcessScan: true,
  });
  await again.release();
  assert.equal(await readPipelineLock(lockPath), null);
});

test('acquirePipelineLock treats corrupt lock JSON as stale', async () => {
  const dir = await makeTmpDir();
  const lockPath = path.join(dir, 'pipeline.lock');
  await fs.writeFile(lockPath, '{not json');

  const lock = await acquirePipelineLock({
    pipelineId: 'flowTutor',
    lockPath,
    projectRoot: dir,
    skipProcessScan: true,
  });
  const info = await readPipelineLock(lockPath);
  assert.equal(info?.pid, process.pid);
  await lock.release();
});

test('acquirePipelineLock aborts on a live pipeline process even without a lock file', async () => {
  const dir = await makeTmpDir();
  const lockPath = path.join(dir, 'pipeline.lock');

  await assert.rejects(
    () =>
      acquirePipelineLock({
        pipelineId: 'flowTutor',
        lockPath,
        projectRoot: dir,
        detectProcesses: async () => [
          { pid: 4242, pipelineId: 'xhot', command: 'node src/cli.ts xhot "new model"' },
        ],
      }),
    (err: any) => {
      assert.ok(err instanceof PipelineConflictError);
      assert.equal(err.holder.source, 'process');
      assert.equal(err.holder.pipelineId, 'xhot');
      assert.equal(err.holder.pid, 4242);
      return true;
    }
  );

  // The lock must not be left behind by the aborted start.
  assert.equal(await readPipelineLock(lockPath), null);
});
