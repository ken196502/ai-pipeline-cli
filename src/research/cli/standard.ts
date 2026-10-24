#!/usr/bin/env node
/**
 * Standalone YouTube Research Evaluation Standard CLI.
 *
 * Provides two primary commands:
 * 1. `generate`: Distills search queries and optional candidate context into canonical
 *    topics, quantitative dimensions, 1-5 qualitative scoring rubrics, and composite guidance
 *    with a cryptographically verifiable canonical SHA-256 standardHash.
 * 2. `verify`: Inspects an existing evaluation-standard.json file, validates schema conformance,
 *    recomputes the canonical SHA-256 digest, and detects tampering or criteria corruption.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  EvaluationStandardSchema,
  type EvaluationRequirements,
  type EvaluationStandard,
  type VideoCandidate,
} from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import {
  computeStandardHash,
  generateEvaluationStandard,
  verifyStandardHash,
} from '../evaluation/standard.js';
import { createRunLogger } from '../../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../../utils/run.js';
import { isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';

export interface GenerateStandardCliOptions {
  query: string;
  candidatesPath?: string;
  topic?: string;
  language?: string;
  model?: string;
  output?: string;
  evaluationFocus?: string;
  evaluationRequirements?: EvaluationRequirements | string;
}

export interface VerifyStandardCliOptions {
  standardPath: string;
  strict?: boolean;
  json?: boolean;
}

export interface VerifyStandardResult {
  valid: boolean;
  standardPath: string;
  standardHash: string;
  computedHash: string;
  topic: string;
  version: string;
  dimensionsCount: number;
  schemaValid: boolean;
  schemaErrors?: string[];
  mismatches: string[];
}

/**
 * Loads and parses candidate videos from a JSON file.
 */
export async function loadCandidatesFromFile(filePath: string): Promise<VideoCandidate[]> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf-8');
  const data = JSON.parse(raw);

  if (Array.isArray(data)) {
    return data as VideoCandidate[];
  }
  if (data.kept && Array.isArray(data.kept)) {
    return data.kept as VideoCandidate[];
  }
  if (data.candidates && Array.isArray(data.candidates)) {
    return data.candidates as VideoCandidate[];
  }

  throw new Error(`File at ${filePath} does not contain an array of candidates or a { kept: [] } structure`);
}

/**
 * Executes the `generate` command programmatic workflow.
 */
export async function runGenerateStandard(
  options: GenerateStandardCliOptions
): Promise<{ standard: EvaluationStandard; savedPath?: string }> {
  const query = options.query.trim();
  if (!query) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Query parameter cannot be empty',
      stage: 'standard-gen',
      task: 'validate-input',
    });
  }

  let candidates: VideoCandidate[] = [];
  if (options.candidatesPath) {
    candidates = await loadCandidatesFromFile(options.candidatesPath);
  }

  const standard = await generateEvaluationStandard({
    query,
    candidates,
    language: options.language || 'en',
    model: options.model,
    evaluationFocus: options.evaluationFocus,
    evaluationRequirements: options.evaluationRequirements,
  });

  if (options.topic) {
    standard.meta.topic = options.topic;
    standard.meta.standardHash = computeStandardHash({
      topic: standard.meta.topic,
      language: standard.meta.language,
      version: standard.meta.version,
      promptVersion: standard.meta.promptVersion,
      model: standard.meta.model,
      quantitativeDimensions: standard.quantitativeDimensions,
      qualitativeDimensions: standard.qualitativeEvaluation.dimensions,
      compositeGuidance: standard.qualitativeEvaluation.compositeGuidance,
    });
  }

  // Validate strict schema conformance
  EvaluationStandardSchema.parse(standard);

  let savedPath: string | undefined;
  if (options.output) {
    savedPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, JSON.stringify(standard, null, 2), 'utf-8');
  }

  return { standard, savedPath };
}

/**
 * Executes the `verify` command programmatic workflow.
 */
export async function runVerifyStandard(
  options: VerifyStandardCliOptions
): Promise<VerifyStandardResult> {
  const resolvedPath = path.resolve(options.standardPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read evaluation standard file at ${resolvedPath}: ${err.message}`);
  }

  let parsedJson: any;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err: any) {
    return {
      valid: false,
      standardPath: resolvedPath,
      standardHash: '',
      computedHash: '',
      topic: 'Unknown',
      version: 'Unknown',
      dimensionsCount: 0,
      schemaValid: false,
      schemaErrors: [`Invalid JSON: ${err.message}`],
      mismatches: ['File is not valid JSON'],
    };
  }

  const schemaCheck = EvaluationStandardSchema.safeParse(parsedJson);
  const schemaValid = schemaCheck.success;
  const schemaErrors = schemaCheck.success
    ? undefined
    : schemaCheck.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  const mismatches: string[] = [];
  let computedHash = '';
  let standardHash = '';
  let topic = 'Unknown';
  let version = 'Unknown';
  let dimensionsCount = 0;

  if (schemaCheck.success) {
    const standard = schemaCheck.data;
    standardHash = standard.meta.standardHash;
    topic = standard.meta.topic;
    version = standard.meta.version;
    dimensionsCount = standard.qualitativeEvaluation.dimensions.length;

    computedHash = computeStandardHash({
      topic: standard.meta.topic,
      language: standard.meta.language,
      version: standard.meta.version,
      promptVersion: standard.meta.promptVersion,
      model: standard.meta.model,
      quantitativeDimensions: standard.quantitativeDimensions,
      qualitativeDimensions: standard.qualitativeEvaluation.dimensions,
      compositeGuidance: standard.qualitativeEvaluation.compositeGuidance,
    });

    if (computedHash !== standardHash) {
      mismatches.push(
        `standardHash mismatch: metadata says ${standardHash}, but recomputed hash is ${computedHash}`
      );
    }
  } else {
    mismatches.push('Schema validation failed; canonical hash cannot be reliably computed');
  }

  const valid = schemaValid && mismatches.length === 0;

  return {
    valid,
    standardPath: resolvedPath,
    standardHash,
    computedHash,
    topic,
    version,
    dimensionsCount,
    schemaValid,
    schemaErrors,
    mismatches,
  };
}

// CLI Command Setup
const program = new Command();

program
  .name('yt-research-standard')
  .description('Generate 3-round LLM evaluation standards and verify canonical SHA-256 digests')
  .version('1.0.0');

/**
 * Subcommand: generate
 */
program
  .command('generate')
  .description('Distill search query and candidate context into a canonical evaluation standard')
  .requiredOption('-q, --query <string>', 'Search query or research subject')
  .option('-c, --candidates <path>', 'Path to JSON file containing discovered candidate videos')
  .option('-t, --topic <string>', 'Override canonical topic name')
  .option('-l, --language <string>', 'Evaluation language', 'en')
  .option('-m, --model <string>', 'LLM model identifier for standard distillation')
  .option('-o, --output <path>', 'Output destination path for evaluation-standard.json (relative to artifact dir)')
  .option('--artifacts-dir <path>', 'Output directory for run artifacts (default: artifacts/standard-<runId>/)')
  .action(async (opts) => {
    const runId = generateRunId('standard');
    const outDir = await ensureOutputDir(opts.artifactsDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'EVALUATION STANDARD GENERATION RUN LOG',
    });

    try {
      logger.stage('generate', 'Generating evaluation standard', {
        query: opts.query,
        topic: opts.topic,
        language: opts.language,
      });

      console.log(pc.bold(pc.cyan('\n=== Generating Evaluation Standard ===\n')));
      console.log(`${pc.bold('Query:')}        ${opts.query}`);
      if (opts.candidates) console.log(`${pc.bold('Candidates:')}   ${opts.candidates}`);
      if (opts.topic) console.log(`${pc.bold('Topic:')}        ${opts.topic}`);
      console.log(`${pc.bold('Language:')}     ${opts.language}`);
      console.log(`${pc.bold('Artifacts Dir:')} ${outDir}`);

      const { standard, savedPath } = await runGenerateStandard({
        query: opts.query,
        candidatesPath: opts.candidates,
        topic: opts.topic,
        language: opts.language,
        model: opts.model,
        output: opts.output ? path.join(outDir, opts.output) : undefined,
      });

      logger.info('Evaluation standard generated', {
        topic: standard.meta.topic,
        standardHash: standard.meta.standardHash,
        version: standard.meta.version,
        dimensionsCount: standard.qualitativeEvaluation.dimensions.length,
      });

      console.log(pc.green('\n✓ Evaluation Standard generated successfully!'));
      console.log(`${pc.bold('Canonical Topic:')} ${standard.meta.topic}`);
      console.log(`${pc.bold('Standard Hash:')}   ${pc.yellow(standard.meta.standardHash)}`);
      console.log(`${pc.bold('Version:')}         ${standard.meta.version}`);
      console.log(`${pc.bold('Source:')}          ${standard.meta.source}\n`);

      console.log(pc.bold('Qualitative Dimensions (1-5 Rubrics):'));
      for (const d of standard.qualitativeEvaluation.dimensions) {
        const weight = standard.qualitativeEvaluation.equalWeights[d.dimension] ?? 25;
        console.log(` • ${pc.bold(d.dimension)} (${weight}% weight): ${pc.dim(d.description)}`);
      }

      console.log(pc.bold('\nQuantitative Metrics:'));
      for (const q of standard.quantitativeDimensions) {
        console.log(` • ${pc.bold(q.name)} [${q.metricKey}] (${q.direction || 'neutral'})`);
      }

      console.log(pc.bold('\nScore Bands:'));
      for (const b of standard.qualitativeEvaluation.compositeGuidance.overallInterpretation) {
        console.log(` • [${b.min.toFixed(1)} - ${b.max.toFixed(1)}] ${pc.bold(b.band)}: ${pc.dim(b.description)}`);
      }

      if (savedPath) {
        logger.info('Standard persisted', { path: savedPath });
        console.log(pc.green(`\n✓ Persisted standard JSON to: ${savedPath}\n`));
      } else {
        console.log('');
      }

      console.log(pc.dim(`Run artifacts: ${outDir}`));
      console.log(pc.dim(`  run.log   - Human-readable log`));
      console.log(pc.dim(`  run.jsonl - Structured JSON-lines log\n`));
    } catch (err: any) {
      logger.error('Standard generation failed', err);
      console.error(pc.red(`\n[Standard Generation Error] ${err.message}`));
      if (isLlmUnavailableError(err)) {
        await notifyLlmUnavailableAndExit(err, {
          stage: 'standard-cli',
          task: 'generate-standard',
          context: 'Evaluation Standard CLI',
          shouldExit: true,
        });
      }
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

/**
 * Subcommand: verify
 */
program
  .command('verify')
  .description('Verify an evaluation-standard.json file against schema and canonical SHA-256 digest')
  .requiredOption('-s, --standard <path>', 'Path to evaluation-standard.json file')
  .option('--strict', 'Fail with non-zero exit code if schema issues are detected', false)
  .option('--json', 'Output verification result as JSON', false)
  .option('--artifacts-dir <path>', 'Output directory for run artifacts (default: artifacts/verify-<runId>/)')
  .action(async (opts) => {
    const runId = generateRunId('verify');
    const outDir = await ensureOutputDir(opts.artifactsDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'EVALUATION STANDARD VERIFICATION RUN LOG',
    });

    try {
      logger.stage('verify', 'Verifying evaluation standard', { path: opts.standard });

      const result = await runVerifyStandard({
        standardPath: opts.standard,
        strict: opts.strict,
        json: opts.json,
      });

      logger.info('Verification complete', {
        valid: result.valid,
        topic: result.topic,
        standardHash: result.standardHash,
        computedHash: result.computedHash,
        schemaValid: result.schemaValid,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.valid) {
          process.exit(1);
        }
        return;
      }

      console.log(pc.bold(pc.cyan('\n=== Evaluation Standard Verification ===\n')));
      console.log(`${pc.bold('File:')}            ${result.standardPath}`);
      console.log(`${pc.bold('Topic:')}           ${result.topic}`);
      console.log(`${pc.bold('Version:')}         ${result.version}`);
      console.log(`${pc.bold('Dimensions:')}      ${result.dimensionsCount}`);
      console.log(`${pc.bold('Schema Conformance:')} ${result.schemaValid ? pc.green('PASSED') : pc.red('FAILED')}`);
      console.log(`${pc.bold('Integrity Status:')}   ${result.valid ? pc.green('AUTHENTIC (Hash Matches)') : pc.red('TAMPERED / MISMATCH')}`);
      console.log(`${pc.bold('Standard Hash:')}    ${result.standardHash}`);
      console.log(`${pc.bold('Computed Hash:')}    ${result.computedHash || pc.dim('N/A')}\n`);

      if (!result.valid) {
        logger.warn('Verification failed', { mismatches: result.mismatches, schemaErrors: result.schemaErrors });

        console.log(pc.bold(pc.red('Defects Detected:')));
        for (const m of result.mismatches) {
          console.log(` ✗ ${pc.red(m)}`);
        }
        if (result.schemaErrors && result.schemaErrors.length > 0) {
          console.log(pc.bold(pc.red('\nSchema Violations:')));
          for (const err of result.schemaErrors) {
            console.log(` ✗ ${pc.red(err)}`);
          }
        }
        console.log('');
        process.exit(1);
      } else {
        logger.info('Standard verified as authentic');
        console.log(pc.green('✓ Evaluation standard is cryptographically verified and tamper-free.\n'));
      }

      console.log(pc.dim(`Run artifacts: ${outDir}`));
      console.log(pc.dim(`  run.log   - Human-readable log`));
      console.log(pc.dim(`  run.jsonl - Structured JSON-lines log\n`));
    } catch (err: any) {
      logger.error('Verification failed', err);
      console.error(pc.red(`\n[Verification Error] ${err.message}`));
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

// Execute when run as CLI entry point
if (process.argv[1]?.endsWith('standard.ts') || process.argv[1]?.endsWith('standard.js')) {
  program.parse(process.argv);
}
