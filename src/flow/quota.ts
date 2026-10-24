/**
 * Live Flow Credit Quota (real balance from flow.google.com).
 *
 * The local daily-usage ledger, its file locks, and the DAILY_VIDEO_LIMIT env
 * gating are GONE: the only limit is the real credit balance managed by
 * flow.google.com, read live via the top-right avatar ("Account details" →
 * credits-count) before and after every generation task.
 *
 * Reading the balance itself lives in src/flow/dom.ts (playwright page) and the
 * extension bridge (get_flow_credits) — this module only builds snapshots and
 * enforces the sufficiency gate.
 */
import { VIDEO_CREDIT_COST, getFlowReservedCredits } from './config.js';
import type { QuotaSnapshot } from './contracts.js';

/**
 * Enforces the reserved credits threshold gate at pipeline startup.
 * Throws immediately if the pipeline config contains fewer credits than required.
 */
export function assertFlowCreditsThreshold(
  actualCredits: number | null | undefined,
  threshold: number = getFlowReservedCredits(),
  pipelineId?: string
): void {
  if (threshold <= 0) return;

  if (typeof actualCredits === 'number' && actualCredits < threshold) {
    const prefix = pipelineId ? `[${pipelineId}] ` : '';
    throw new Error(
      `${prefix}Insufficient Google Flow credits in pipeline config: ${actualCredits} credits recorded, ` +
        `but ${threshold} reserved credits required (env FLOW_RESERVED_CREDITS=${threshold}). ` +
        `Top up credits on flow.google.com before running the pipeline.`
    );
  }
}


export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Builds a quota snapshot from the live credit balance read on flow.google.com.
 */
export function buildCreditSnapshot(input: {
  /** Live balance (the authoritative number from the avatar panel). */
  actualCredits: number;
  /** Balance before the task, when this snapshot belongs to a task run. */
  creditsBefore?: number | null;
  /** Balance after the task, when this snapshot belongs to a task run. */
  creditsAfter?: number | null;
}): QuotaSnapshot {
  return {
    date: todayUtc(),
    actualCredits: input.actualCredits,
    costPerVideo: VIDEO_CREDIT_COST,
    creditsBefore: input.creditsBefore ?? null,
    creditsAfter: input.creditsAfter ?? null,
  };
}

/**
 * Refuses a task when the live balance cannot cover one video generation.
 * Throws before any request is submitted — flow.google.com stays untouched.
 */
export function assertSufficientCredits(credits: number, label: string): void {
  if (!Number.isFinite(credits) || credits < VIDEO_CREDIT_COST) {
    throw new Error(
      `Insufficient Google Flow credits: ${credits} available, ${VIDEO_CREDIT_COST} required for ${label}. ` +
        `The credit balance is managed by flow.google.com — top up and re-run. No request was submitted.`
    );
  }
}
