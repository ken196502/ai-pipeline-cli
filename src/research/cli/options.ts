import type { Command } from 'commander';
import { type MetricThresholds, DEFAULT_THRESHOLDS } from '../contracts.js';

/**
 * Attaches standardized candidate evaluation metric threshold flags to any commander Command.
 * Single source of truth for CLI threshold flags across all pipelines and CLIs.
 */
export function attachMetricThresholdOptions(cmd: Command): Command {
  return cmd
    .option(
      '--min-duration <number>',
      `Minimum duration in seconds (default: ${DEFAULT_THRESHOLDS.minDurationSec}, 5 mins)`,
      (v) => parseInt(v, 10)
    )
    .option(
      '--max-age-days <number>',
      `Maximum video age in days (default: ${DEFAULT_THRESHOLDS.maxAgeDays}, i.e. 6 months)`,
      (v) => parseInt(v, 10)
    );
}

/**
 * Parses attached metric threshold options from commander opts into a Partial<MetricThresholds>.
 */
export function parseMetricThresholdOptions(opts: any): Partial<MetricThresholds> {
  const thresholds: Partial<MetricThresholds> = {};
  if (opts.minDuration != null && !Number.isNaN(opts.minDuration)) {
    thresholds.minDurationSec = opts.minDuration;
  }
  if (opts.maxAgeDays != null && !Number.isNaN(opts.maxAgeDays)) {
    thresholds.maxAgeDays = opts.maxAgeDays;
  }
  return thresholds;
}
