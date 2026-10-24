/**
 * Candidate Evidence Assembly and Pool Selection.
 *
 * Implements deterministic pool selection sorted by metric confidence, velocity,
 * and view count. Computes weighted evidence coverage across metadata (20%),
 * description (15%), tags (5%), metrics (20%), and transcript (40%).
 */
import type {
  CandidateEvidence,
  EvaluationPool,
  NotEvaluated,
  QuantitativeEvidence,
  Transcript,
  VideoCandidate,
} from '../contracts.js';

export interface EvidenceWeights {
  metadata: number; // 0.20
  description: number; // 0.15
  tags: number; // 0.05
  metrics: number; // 0.20
  transcript: number; // 0.40
}

export const DEFAULT_EVIDENCE_WEIGHTS: EvidenceWeights = {
  metadata: 0.2,
  description: 0.15,
  tags: 0.05,
  metrics: 0.2,
  transcript: 0.4,
};

/**
 * Calculates a confidence score (0 to 3) based on how many platform metrics
 * were explicitly provided without being suppressed.
 */
export function metricConfidenceScore(candidate: VideoCandidate): number {
  const conf = candidate.metricsConfidence;
  let score = 0;
  if (conf?.views) score += 1;
  if (conf?.likes) score += 1;
  if (conf?.comments) score += 1;
  return score;
}

/**
 * Selects a bounded candidate evaluation pool sorted deterministically.
 * Candidates exceeding poolSize are recorded as notEvaluated with reason 'pool_limit'.
 */
export function chooseEvaluationPool(
  kept: readonly VideoCandidate[],
  poolSize = 5,
): EvaluationPool {
  const ordered = [...kept].sort(
    (left, right) =>
      metricConfidenceScore(right) - metricConfidenceScore(left) ||
      right.metrics.viewsPerDay - left.metrics.viewsPerDay ||
      right.metrics.viewCount - left.metrics.viewCount ||
      left.videoId.localeCompare(right.videoId),
  );

  const limit = Math.max(1, Math.floor(poolSize));
  const pool = ordered.slice(0, limit);
  const notEvaluated: NotEvaluated[] = ordered.slice(limit).map((candidate) => ({
    videoId: candidate.videoId,
    reason: 'pool_limit',
    detail: `outside the top ${limit} of ${kept.length} filtered candidates`,
  }));

  return {
    pool,
    notEvaluated,
  };
}

export interface CandidateEvidenceInput {
  candidate: VideoCandidate;
  transcript: Transcript | null;
  transcriptFailure?: string | null;
  cachePath?: string | null;
  transcriptSha256?: string | null;
  requireTranscript?: boolean;
  minEvidenceCoverage?: number;
  weights?: EvidenceWeights;
}

/**
 * Calculates evidence coverage score (0.0 to 1.0) and missing reasons.
 */
export function calculateEvidenceCoverage(
  candidate: VideoCandidate,
  transcript: Transcript | null,
  weights: EvidenceWeights = DEFAULT_EVIDENCE_WEIGHTS,
): { coverage: number; missingReasons: string[] } {
  let score = 0;
  const missing: string[] = [];

  // Metadata: 20%
  const hasMeta =
    Boolean(candidate.title) &&
    Boolean(candidate.channelTitle) &&
    candidate.metrics.durationSec > 0;
  if (hasMeta) {
    score += weights.metadata;
  } else {
    missing.push('metadata: incomplete title, channel, or duration');
  }

  // Description: 15% (must be at least 50 characters)
  const hasDesc = candidate.description.length >= 50;
  if (hasDesc) {
    score += weights.description;
  } else {
    missing.push('description: fewer than 50 characters');
  }

  // Tags: 5%
  const hasTags = candidate.tags.length > 0;
  if (hasTags) {
    score += weights.tags;
  } else {
    missing.push('tags: no tags provided');
  }

  // Metrics: 20%
  const hasMetrics = candidate.metrics.viewCount > 0 && candidate.metrics.viewsPerDay > 0;
  if (hasMetrics) {
    score += weights.metrics;
  } else {
    missing.push('metrics: view count or daily velocity is zero');
  }

  // Transcript: 40%
  const hasTranscript =
    transcript !== null &&
    transcript.cues.length >= 5;
  if (hasTranscript) {
    score += weights.transcript;
  } else {
    missing.push('transcript: captions missing or insufficient cues');
  }

  const coverage = Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
  return { coverage, missingReasons: missing };
}

/**
 * Builds quantitative evidence records from platform metrics and confidence signals.
 */
export function buildQuantitativeEvidence(candidate: VideoCandidate): QuantitativeEvidence[] {
  const m = candidate.metrics;
  const conf = candidate.metricsConfidence;
  return [
    {
      metricKey: 'viewCount',
      label: 'View Count',
      value: m.viewCount,
      unit: 'views',
      source: 'yt-dlp',
      confident: Boolean(conf?.views),
    },
    {
      metricKey: 'likeCount',
      label: 'Like Count',
      value: m.likeCount,
      unit: 'likes',
      source: 'yt-dlp',
      confident: Boolean(conf?.likes),
    },
    {
      metricKey: 'commentCount',
      label: 'Comment Count',
      value: m.commentCount,
      unit: 'comments',
      source: 'yt-dlp',
      confident: Boolean(conf?.comments),
    },
    {
      metricKey: 'durationSec',
      label: 'Duration',
      value: m.durationSec,
      unit: 'seconds',
      source: 'yt-dlp',
      confident: true,
    },
    {
      metricKey: 'viewsPerDay',
      label: 'Daily View Velocity',
      value: m.viewsPerDay,
      unit: 'views/day',
      source: 'derived',
      confident: Boolean(conf?.views),
    },
    {
      metricKey: 'engagementRate',
      label: 'Engagement Rate',
      value: m.engagementRate,
      unit: 'rate',
      source: 'derived',
      confident: Boolean(conf?.views && conf?.likes),
    },
  ];
}

/**
 * Builds a validated CandidateEvidence record with selectable determination.
 */
export function buildCandidateEvidence(input: CandidateEvidenceInput): CandidateEvidence {
  const {
    candidate,
    transcript,
    transcriptFailure = null,
    cachePath = null,
    transcriptSha256 = null,
    requireTranscript = true,
    minEvidenceCoverage = 0.5,
    weights = DEFAULT_EVIDENCE_WEIGHTS,
  } = input;

  const { coverage, missingReasons } = calculateEvidenceCoverage(candidate, transcript, weights);

  const transcriptAvailable = transcript !== null && transcript.cues.length > 0;

  // Selectable policy check
  let selectable = coverage >= minEvidenceCoverage;
  if (requireTranscript && !transcriptAvailable) {
    selectable = false;
  }

  return {
    videoId: candidate.videoId,
    title: candidate.title,
    channelTitle: candidate.channelTitle,
    description: candidate.description,
    tags: candidate.tags,
    metrics: candidate.metrics,
    quantitative: buildQuantitativeEvidence(candidate),
    transcript: {
      available: transcriptAvailable,
      language: transcript ? transcript.language : null,
      source: transcript ? transcript.source : null,
      cueCount: transcript ? transcript.cues.length : 0,
      cues: transcript ? transcript.cues : [],
      cachePath: cachePath ?? null,
      sha256: transcriptSha256 ?? null,
      failureReason: transcriptFailure ?? null,
    },
    evidenceCoverage: coverage,
    selectable,
    missingReasons,
  };
}
