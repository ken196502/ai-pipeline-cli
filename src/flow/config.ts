/**
 * Configuration and Defaults for Google Flow Automation.
 *
 * Reuses the existing Ungoogled Chromium user profile directory (./.chromium-profile)
 * so YouTube and Google Flow authentication sessions are shared.
 */
import path from 'node:path';
import { loadEnvFile } from '../env.js';
import { resolveProfileDir, getProjectRootDir } from '../utils/browser.js';

// Ensure .env is loaded so FLOW_VIDEO_CREDIT_COST and other env vars are populated
loadEnvFile();

export const FLOW_HOME_URL = 'https://flow.google.com';
export const FLOW_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fflow.google.com%2F';

/**
 * Credits required for ONE video generation task (lite model). The live balance
 * is read from flow.google.com (top-right avatar "Account details" panel) before
 * and after every task; a task is refused when the balance is below this.
 * Env-overridable (FLOW_VIDEO_CREDIT_COST) so pricing/model changes never need a
 * code edit. There is NO local daily limit anymore — flow.google.com is the
 * single source of truth.
 */
export const VIDEO_CREDIT_COST = clampInt(process.env.FLOW_VIDEO_CREDIT_COST, 15, 1, 100_000);
export const DEFAULT_MODEL = 'lite';

/**
 * Reserved credits threshold (env FLOW_RESERVED_CREDITS / FLOW_MIN_CREDITS_THRESHOLD).
 * If the latest locally recorded credits fall below this threshold, the pipeline
 * halts immediately at the first step to prevent wasting LLM and workflow resources.
 */
export const FLOW_RESERVED_CREDITS = clampInt(
  process.env.FLOW_RESERVED_CREDITS || process.env.FLOW_MIN_CREDITS_THRESHOLD,
  0,
  0,
  10_000_000
);

export function getFlowReservedCredits(): number {
  return clampInt(
    process.env.FLOW_RESERVED_CREDITS || process.env.FLOW_MIN_CREDITS_THRESHOLD,
    0,
    0,
    10_000_000
  );
}


/**
 * Google anti-abuse risk-control retry policy ("We noticed some unusual activity"),
 * see plan-fix-risk-control-refresh-retry.md. Every attempt starts with a page
 * refresh that clears the stale risk tile, then re-runs the click → Ctrl+V → Enter
 * gesture. Configurable via env — never hardcoded at call sites.
 */
export const RISK_RETRY_ATTEMPTS = clampInt(process.env.FLOW_RISK_RETRY_ATTEMPTS, 5, 1, 20);
export const RISK_RETRY_DELAY_MIN_SEC = clampInt(process.env.FLOW_RISK_RETRY_DELAY_MIN_SEC, 10, 0, 3600);
export const RISK_RETRY_DELAY_MAX_SEC = clampInt(process.env.FLOW_RISK_RETRY_DELAY_MAX_SEC, 25, 0, 7200);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Default profile matches YouTube persistent Chromium profile */
export const DEFAULT_PROFILE_DIR = resolveProfileDir();
export const DEFAULT_DATA_DIR = path.resolve(process.env.FLOW_DATA_DIR || path.join(getProjectRootDir(), '.flow-cli'));
export const DEFAULT_DEBUG_DIR = path.resolve(process.env.FLOW_DEBUG_DIR || path.join(DEFAULT_DATA_DIR, 'debug'));

export interface FlowConfig {
  homeUrl: string;
  loginUrl: string;
  videoCreditCost: number;
  reservedCredits: number;
  defaultModel: string;
  profileDir: string;
  dataDir: string;
  debugDir: string;
  defaultProjectId?: string;
  headed?: boolean;
  timeoutMs: number;
  riskRetryAttempts: number;
  riskRetryDelaySec: [number, number];
}

export function getFlowConfig(overrides?: Partial<FlowConfig>): FlowConfig {
  const profileDir = overrides?.profileDir
    ? path.resolve(overrides.profileDir)
    : DEFAULT_PROFILE_DIR;

  const dataDir = overrides?.dataDir
    ? path.resolve(overrides.dataDir)
    : DEFAULT_DATA_DIR;

  const debugDir = overrides?.debugDir
    ? path.resolve(overrides.debugDir)
    : path.join(dataDir, 'debug');

  const defaultProjectId = overrides?.defaultProjectId ?? process.env.FLOW_PROJECT_ID?.trim();
  const headed = overrides?.headed ?? (process.env.FLOW_HEADED === 'true' || process.env.FLOW_HEADED === '1');
  // Default 30 min: continuation/frame videos routinely exceed 10 min server-side
  // when the audio track hiccups (observed: video landed only AFTER the old 600s
  // timeout gave up — round-0002/round-0004). Override via FLOW_TIMEOUT_SEC.
  const timeoutMs = overrides?.timeoutMs
    ?? (process.env.FLOW_TIMEOUT_SEC ? Number.parseInt(process.env.FLOW_TIMEOUT_SEC, 10) * 1000 : 1_800_000);

  return {
    homeUrl: overrides?.homeUrl ?? FLOW_HOME_URL,
    loginUrl: overrides?.loginUrl ?? FLOW_LOGIN_URL,
    videoCreditCost: overrides?.videoCreditCost ?? VIDEO_CREDIT_COST,
    reservedCredits: overrides?.reservedCredits ?? getFlowReservedCredits(),
    defaultModel: overrides?.defaultModel ?? DEFAULT_MODEL,
    profileDir,
    dataDir,
    debugDir,
    defaultProjectId,
    headed,
    timeoutMs,
    riskRetryAttempts: RISK_RETRY_ATTEMPTS,
    riskRetryDelaySec: [RISK_RETRY_DELAY_MIN_SEC, RISK_RETRY_DELAY_MAX_SEC],
  };
}
