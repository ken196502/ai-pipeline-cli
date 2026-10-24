/**
 * Evaluation Standard Generator and SHA-256 Canonical Hashing.
 *
 * Implements 3-round LLM distillation of search queries into canonical topics,
 * quantitative metrics, and 1-5 qualitative scoring rubrics with composite guidance.
 * Ensures reproducible and tamper-evident scoring criteria via standardHash.
 */
import { createHash } from 'node:crypto';
import type {
  CompositeGuidance,
  EvaluationDimensionRequirement,
  EvaluationRequirements,
  EvaluationStandard,
  QualitativeDimension,
  QuantitativeDimension,
  ScoreBand,
  VideoCandidate,
} from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import { chat, type ChatMessage } from '../llm/client.js';
import { chatJsonObject } from '../llm/json-chat.js';
import { getEnvConfig } from '../../env.js';
import { isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';

export const STANDARD_VERSION = 'research-standard-v2';
export const STANDARD_PROMPT_VERSION = '2026-03-standard-v1';

export function resolveLlmModel(model?: string): string {
  if (model && model.trim() && model.trim() !== 'default') {
    return model.trim();
  }
  return getEnvConfig().llmModel;
}

export interface GenerateStandardOptions {
  query: string;
  candidates?: readonly VideoCandidate[];
  language?: string;
  model?: string;
  promptVersion?: string;
  pipeline?: string[];
  evaluationFocus?: string;
  evaluationRequirements?: EvaluationRequirements | string;
  now?: () => Date;
}

/**
 * Formats structured or textual evaluation requirements into an authoritative
 * directives block for LLM evaluation standard distillation across all rounds.
 */
export function formatEvaluationRequirements(
  input?: EvaluationRequirements | string,
): string {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();

  const sections: string[] = [];

  const headerParts: string[] = [];
  if (input.pipelineId) {
    headerParts.push(`Pipeline Target: [${input.pipelineId}]`);
  }
  if (input.coreObjective) {
    headerParts.push(`Core Objective: ${input.coreObjective}`);
  }
  if (headerParts.length > 0) {
    sections.push(headerParts.join('\n'));
  }

  if (Array.isArray(input.requiredDimensions) && input.requiredDimensions.length > 0) {
    const dims = input.requiredDimensions.map((dim, idx) => {
      let block = `${idx + 1}. **${dim.name}**${dim.priority ? ` [Priority: ${dim.priority.toUpperCase()}]` : ''}:\n   ${dim.description}`;
      if (dim.scoringGuidelines?.high) {
        block += `\n   - Score 4-5 Benchmark: ${dim.scoringGuidelines.high}`;
      }
      if (dim.scoringGuidelines?.low) {
        block += `\n   - Score 1-2 Defect: ${dim.scoringGuidelines.low}`;
      }
      return block;
    }).join('\n\n');
    sections.push(`REQUIRED QUALITATIVE DIMENSIONS (Must be directly represented in distilled rubrics):\n${dims}`);
  }

  if (Array.isArray(input.targetTraits) && input.targetTraits.length > 0) {
    const traits = input.targetTraits.map((t) => `• ${t}`).join('\n');
    sections.push(`KEY TARGET TRAITS & DIRECTIVES:\n${traits}`);
  }

  if (Array.isArray(input.negativeFilters) && input.negativeFilters.length > 0) {
    const neg = input.negativeFilters.map((f) => `• ${f}`).join('\n');
    sections.push(`STRICT NEGATIVE FILTERS & DISQUALIFIERS (Penalize heavily in score criteria & pitfalls):\n${neg}`);
  }

  if (input.customDirectives && input.customDirectives.trim()) {
    sections.push(`ADDITIONAL CUSTOM DIRECTIVES:\n${input.customDirectives.trim()}`);
  }

  return sections.join('\n\n');
}

/**
 * Computes deterministic SHA-256 hash across candidates in context.
 */
export function standardCandidateContextHash(candidates: readonly VideoCandidate[] = []): string {
  const sorted = [...candidates].sort((a, b) => a.videoId.localeCompare(b.videoId));
  const payload = sorted.map((c) => ({
    videoId: c.videoId,
    title: c.title,
    channelTitle: c.channelTitle,
    views: c.metrics.viewCount,
    duration: c.metrics.durationSec,
  }));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Computes canonical SHA-256 standardHash over normalized standard contents.
 */
export function computeStandardHash(
  data: {
    topic: string;
    language: string;
    version: string;
    promptVersion: string;
    model: string;
    quantitativeDimensions: readonly QuantitativeDimension[];
    qualitativeDimensions: readonly QualitativeDimension[];
    compositeGuidance: CompositeGuidance;
  },
): string {
  const canonicalPayload = {
    topic: data.topic.trim().toLowerCase(),
    language: data.language.trim().toLowerCase(),
    version: data.version,
    promptVersion: data.promptVersion,
    model: data.model,
    quantitative: data.quantitativeDimensions.map((q) => ({
      name: q.name,
      metricKey: q.metricKey,
      direction: q.direction,
      resolved: q.resolved,
    })),
    qualitative: data.qualitativeDimensions.map((d) => ({
      dimension: d.dimension,
      criteria: {
        1: d.scoringCriteria[1],
        2: d.scoringCriteria[2],
        3: d.scoringCriteria[3],
        4: d.scoringCriteria[4],
        5: d.scoringCriteria[5],
      },
    })),
    pitfalls: [...data.compositeGuidance.evaluationPitfalls].sort(),
    interpretation: data.compositeGuidance.overallInterpretation.map((b) => ({
      band: b.band,
      min: b.min,
      max: b.max,
    })),
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
}

/**
 * Verifies that an EvaluationStandard's standardHash matches its content.
 */
export function verifyStandardHash(standard: EvaluationStandard): boolean {
  const calculated = computeStandardHash({
    topic: standard.meta.topic,
    language: standard.meta.language,
    version: standard.meta.version,
    promptVersion: standard.meta.promptVersion,
    model: standard.meta.model,
    quantitativeDimensions: standard.quantitativeDimensions,
    qualitativeDimensions: standard.qualitativeEvaluation.dimensions,
    compositeGuidance: standard.qualitativeEvaluation.compositeGuidance,
  });

  return calculated === standard.meta.standardHash;
}

/**
 * Generates an evaluation standard using 3-round LLM distillation.
 */
export async function generateEvaluationStandard(
  options: GenerateStandardOptions,
): Promise<EvaluationStandard> {
  const {
    query,
    candidates = [],
    language = 'en',
    model,
    promptVersion = STANDARD_PROMPT_VERSION,
    pipeline = ['round-1:dimensions', 'round-2:rubrics', 'round-3:guidance'],
    evaluationFocus,
    evaluationRequirements,
    now = () => new Date(),
  } = options;

  const candidateContextHash = standardCandidateContextHash(candidates);
  const effectiveModel = resolveLlmModel(model);
  const effectiveFocus = formatEvaluationRequirements(evaluationRequirements || evaluationFocus);

  try {
    // Round 1: Canonical Topic and Dimensions
    const r1Result = await executeRound1(query, language, candidates, effectiveModel, effectiveFocus);

    // Round 2: 1-5 Scoring Rubrics for each qualitative dimension
    const r2Dimensions = await executeRound2(r1Result.topic, r1Result.dimensions, language, effectiveModel, effectiveFocus);

    // Round 3: Composite Guidance, Score Bands, and Pitfalls
    const r3Guidance = await executeRound3(r1Result.topic, r2Dimensions, language, effectiveModel, effectiveFocus);

    // Calculate equal weights (must sum to ~100)
    const count = r2Dimensions.length;
    const baseWeight = Math.floor(100 / count);
    const remainder = 100 - baseWeight * count;
    const equalWeights: Record<string, number> = {};

    r2Dimensions.forEach((dim, idx) => {
      equalWeights[dim.dimension] = baseWeight + (idx < remainder ? 1 : 0);
    });

    const standardData = {
      topic: r1Result.topic,
      language,
      version: STANDARD_VERSION,
      promptVersion,
      model: effectiveModel,
      quantitativeDimensions: r1Result.quantitativeDimensions,
      qualitativeDimensions: r2Dimensions,
      compositeGuidance: r3Guidance,
    };

    const standardHash = computeStandardHash(standardData);

    const standard: EvaluationStandard = {
      meta: {
        query,
        candidateContextHash,
        topic: r1Result.topic,
        language,
        generatedAt: now().toISOString(),
        version: STANDARD_VERSION,
        promptVersion,
        model: effectiveModel,
        standardHash,
        source: 'generated',
        pipeline,
      },
      quantitativeDimensions: r1Result.quantitativeDimensions,
      unresolvedQuantitativeDimensions: r1Result.unresolvedQuantitative,
      qualitativeEvaluation: {
        equalWeights,
        dimensions: r2Dimensions,
        compositeGuidance: r3Guidance,
      },
    };

    return standard;
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.error(`\x1b[31m[standard] LLM standard distillation failed: ${errMsg}\x1b[0m`);
    const appError = error instanceof AppError ? error : new AppError({
      code: ErrorCodes.LLM_REQUEST_FAILED,
      message: `LLM standard distillation failed: ${errMsg}`,
      stage: 'research',
      task: 'standard-gen',
      retryable: false,
      cause: error,
    });
    if (isLlmUnavailableError(appError)) {
      await notifyLlmUnavailableAndExit(appError, {
        stage: 'research',
        task: 'standard-gen',
        context: 'Standard Generation',
      });
    }
    throw appError;
  }
}

interface Round1Output {
  topic: string;
  dimensions: Array<{ name: string; description: string }>;
  quantitativeDimensions: QuantitativeDimension[];
  unresolvedQuantitative: string[];
}

async function executeRound1(
  query: string,
  language: string,
  candidates: readonly VideoCandidate[],
  model?: string,
  evaluationFocus?: string,
): Promise<Round1Output> {
  const candidateSummaries = candidates.slice(0, 5).map((c) => `- "${c.title}" by ${c.channelTitle}`).join('\n');

  const baseGuidance = 'You are an expert video research evaluation architect. Your task is to distill a search query into a canonical subject topic, 4-5 qualitative evaluation dimensions, and map standard quantitative metrics.';
  const focusBlock = evaluationFocus
    ? `\n\nEvaluation Focus & Pipeline Requirements:\n${evaluationFocus}\n\nCRITICAL INSTRUCTION: When explicit pipeline requirements or required dimensions are provided above, your 4-5 qualitative dimensions MUST directly adopt, reflect, and evaluate these specific pillars (e.g. detailed generation guidance & actionable instructions, distinctive aesthetic style & visual identity, story script / narrative staging, cinematic camera choreography & prompt re-creativity). Do NOT omit required dimensions or substitute them with generic filler.`
    : '';
  const systemGuidance = `${baseGuidance}${focusBlock}`;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${systemGuidance}
Respond ONLY with a JSON object with this shape:
{
  "topic": "Canonical Topic Name",
  "dimensions": [
    { "name": "Dimension Name", "description": "Description..." }
  ],
  "quantitative": [
    {
      "name": "Metric Name",
      "description": "Description of metric",
      "metricKey": "viewCount | viewsPerDay | engagementRate | durationSec",
      "unit": "views | views/day | ratio | seconds",
      "direction": "higher-better | lower-better | null",
      "resolved": true
    }
  ]
}`,
    },
    {
      role: 'user',
      content: `Query: "${query}"\nLanguage: ${language}\nSample Candidates:\n${candidateSummaries || 'None provided'}`,
    },
  ];

  const { value: parsedRound1 } = await chatJsonObject({
    model,
    messages,
    temperature: 0.2,
    context: { stage: 'research', task: 'standard-round-1' },
  });
  const parsed = parsedRound1 as Record<string, any>;
  const rawQuant = Array.isArray(parsed.quantitative) ? parsed.quantitative : [];
  const normalizedQuant = rawQuant.map((q: any) => {
    let dir = q?.direction;
    if (dir === 'null' || dir === 'none' || dir === 'undefined' || dir === '') dir = null;
    return {
      ...q,
      direction: dir === 'higher-better' || dir === 'lower-better' ? dir : null,
    };
  });

  return {
    topic: parsed.topic || query,
    dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
    quantitativeDimensions: normalizedQuant,
    unresolvedQuantitative: [],
  };
}

async function executeRound2(
  topic: string,
  dimensions: Array<{ name: string; description: string }>,
  language: string,
  model?: string,
  evaluationFocus?: string,
): Promise<QualitativeDimension[]> {
  const focusContext = evaluationFocus
    ? `\n\nEvaluation Focus & Pipeline Requirements:\n${evaluationFocus}\nTailor all 1-5 scoring criteria definitions to reflect the benchmarks and penalties specified in the Evaluation Focus / Requirements above. Specifically ensure Score 5 reflects high benchmark execution and Score 1 reflects critical defects or disqualifiers.`
    : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are an expert video evaluation rubric designer. For each qualitative dimension, create clear, objective 1-5 scoring criteria tailored to the subject topic and evaluation focus:${focusContext}

Score 1: Unsatisfactory / Lowest quality / Fails core criteria
Score 2: Below average / Notable defects or shallow treatment
Score 3: Competent / Standard quality meeting basic expected benchmarks
Score 4: Strong / High quality with clear strengths and polished execution
Score 5: Exceptional / Benchmark quality, outstanding execution across all criteria

Respond ONLY with a JSON object:
{
  "dimensions": [
    {
      "dimension": "Dimension Name",
      "description": "Description...",
      "scoringCriteria": {
        "1": "Criterion for 1...",
        "2": "Criterion for 2...",
        "3": "Criterion for 3...",
        "4": "Criterion for 4...",
        "5": "Criterion for 5..."
      }
    }
  ]
}`,
    },
    {
      role: 'user',
      content: `Topic: "${topic}"\nLanguage: ${language}\nDimensions to rubricate:\n${JSON.stringify(dimensions, null, 2)}`,
    },
  ];

  const { value: parsedRound2 } = await chatJsonObject({
    model,
    messages,
    temperature: 0.2,
    context: { stage: 'research', task: 'standard-round-2' },
  });
  const parsed = parsedRound2 as any;
  if (!Array.isArray(parsed.dimensions) || parsed.dimensions.length === 0) {
    throw new Error('Round 2 returned empty dimensions');
  }

  return parsed.dimensions.map((d: any) => ({
    dimension: String(d.dimension || d.name),
    description: String(d.description || ''),
    scoringCriteria: {
      1: String(d.scoringCriteria?.['1'] || 'Unsatisfactory'),
      2: String(d.scoringCriteria?.['2'] || 'Below average'),
      3: String(d.scoringCriteria?.['3'] || 'Competent standard'),
      4: String(d.scoringCriteria?.['4'] || 'Strong quality'),
      5: String(d.scoringCriteria?.['5'] || 'Exceptional benchmark'),
    },
  }));
}

async function executeRound3(
  topic: string,
  dimensions: QualitativeDimension[],
  language: string,
  model?: string,
  evaluationFocus?: string,
): Promise<CompositeGuidance> {
  const focusContext = evaluationFocus
    ? `\n\nEvaluation Focus & Pipeline Requirements:\n${evaluationFocus}\nEnsure score bands and common evaluation pitfalls specifically reflect the domain criteria, strict negative filters, and disqualifiers in the Evaluation Focus / Requirements above.`
    : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are an expert evaluation methodologist. Create composite score bands (1.0 to 5.0) and domain-specific evaluation pitfalls for the topic:${focusContext}
Respond ONLY with a JSON object:
{
  "overallInterpretation": [
    { "band": "Benchmark Winner", "range": "4.5 - 5.0", "min": 4.5, "max": 5.0, "description": "Interpretation description for top benchmark tier" },
    { "band": "Strong Contender", "range": "3.5 - 4.4", "min": 3.5, "max": 4.4, "description": "Interpretation description for strong tier" },
    { "band": "Average / Baseline", "range": "2.5 - 3.4", "min": 2.5, "max": 3.4, "description": "Interpretation description for baseline tier" },
    { "band": "Sub-par / Reject", "range": "1.0 - 2.4", "min": 1.0, "max": 2.4, "description": "Interpretation description for reject tier" }
  ],
  "evaluationPitfalls": [
    "Domain-specific pitfall 1",
    "Domain-specific pitfall 2",
    "Domain-specific pitfall 3"
  ]
}`,
    },
    {
      role: 'user',
      content: `Topic: "${topic}"\nLanguage: ${language}\nDimensions: ${dimensions.map((d) => d.dimension).join(', ')}`,
    },
  ];

  const { value: parsedRound3 } = await chatJsonObject({
    model,
    messages,
    temperature: 0.2,
    context: { stage: 'research', task: 'standard-round-3' },
  });
  const parsed = parsedRound3 as any;
  const interpretation: ScoreBand[] = Array.isArray(parsed.overallInterpretation)
    ? parsed.overallInterpretation.map((b: any) => ({
        band: String(b.band || 'Standard Band'),
        range: String(b.range || '1.0 - 5.0'),
        min: Number(b.min) || 1.0,
        max: Number(b.max) || 5.0,
        description: String(b.description || ''),
      }))
    : [
        { band: 'Benchmark Winner', range: '4.5 - 5.0', min: 4.5, max: 5.0, description: 'Outstanding' },
        { band: 'Strong Contender', range: '3.5 - 4.4', min: 3.5, max: 4.4, description: 'High quality' },
        { band: 'Baseline', range: '2.5 - 3.4', min: 2.5, max: 3.4, description: 'Average' },
        { band: 'Reject', range: '1.0 - 2.4', min: 1.0, max: 2.4, description: 'Unsuitable' },
      ];

  const pitfalls: string[] = Array.isArray(parsed.evaluationPitfalls)
    ? parsed.evaluationPitfalls.map(String)
    : [
        'Over-weighting subscriber count over script quality',
        'Ignoring pacing or structural issues due to flashy visuals',
      ];

  return {
    overallInterpretation: interpretation,
    evaluationPitfalls: pitfalls,
  };
}

/**
 * Builds a deterministic fallback evaluation standard when LLM is unavailable.
 */
export function buildFallbackStandard(options: {
  query: string;
  candidateContextHash: string;
  language: string;
  model: string;
  promptVersion: string;
  pipeline: string[];
  evaluationFocus?: string;
  now: () => Date;
}): EvaluationStandard {
  const topic = options.query.trim();

  const qualitativeDimensions: QualitativeDimension[] = [
    {
      dimension: 'Content Depth & Accuracy',
      description: 'Accuracy, depth, and substantive relevance to the core topic',
      scoringCriteria: {
        1: 'Factually inaccurate, misleading, or entirely superficial',
        2: 'Surface-level coverage with several factual oversights',
        3: 'Adequate, competent overview covering standard expected facts',
        4: 'Deep, nuanced analysis with strong factual backing',
        5: 'Definitive masterclass; rigorous and insightful coverage',
      },
    },
    {
      dimension: 'Narrative Structure & Clarity',
      description: 'Logical flow, pacing, and coherence of explanation',
      scoringCriteria: {
        1: 'Disjointed, incoherent, or impossible to follow',
        2: 'Rambling or poorly structured progression',
        3: 'Clear linear structure with standard transitions',
        4: 'Compelling narrative progression that maintains engagement',
        5: 'Seamless, masterfully paced storytelling and conceptual clarity',
      },
    },
    {
      dimension: 'Visual & Audio Production Value',
      description: 'Sound clarity, visual framing, graphic support, and edit quality',
      scoringCriteria: {
        1: 'Unusable audio or severely degraded visuals',
        2: 'Noticeable background noise, poor lighting, or distracting edits',
        3: 'Clean audio, clear 1080p+ visual fidelity, competent editing',
        4: 'High-end production with thoughtful b-roll and crisp audio',
        5: 'Studio-grade cinematography, immersive audio, and bespoke animation',
      },
    },
    {
      dimension: 'Actionable Value & Practical Insight',
      description: 'Practical takeaways, synthesis, and usefulness for downstream generation',
      scoringCriteria: {
        1: 'No actionable insights or practical substance',
        2: 'Vague or generic advice without concrete demonstrations',
        3: 'Solid practical advice that can be directly applied',
        4: 'Highly useful specific methodologies and examples',
        5: 'Transformative insights with rich reference value',
      },
    },
  ];

  const quantitativeDimensions: QuantitativeDimension[] = [
    {
      name: 'Audience Reach',
      description: 'Total view count achieved',
      metricKey: 'viewCount',
      unit: 'views',
      direction: 'higher-better',
      resolved: true,
    },
    {
      name: 'Daily Velocity',
      description: 'Average views accumulated per day',
      metricKey: 'viewsPerDay',
      unit: 'views/day',
      direction: 'higher-better',
      resolved: true,
    },
    {
      name: 'Audience Engagement',
      description: 'Engagement ratio based on likes and comments over views',
      metricKey: 'engagementRate',
      unit: 'ratio',
      direction: 'higher-better',
      resolved: true,
    },
    {
      name: 'Duration Fit',
      description: 'Video runtime duration in seconds',
      metricKey: 'durationSec',
      unit: 'seconds',
      direction: null,
      resolved: true,
    },
  ];

  const compositeGuidance: CompositeGuidance = {
    overallInterpretation: [
      {
        band: 'Benchmark Winner',
        range: '4.5 - 5.0',
        min: 4.5,
        max: 5.0,
        description: 'Benchmark standard; exceptional across all evaluated dimensions',
      },
      {
        band: 'Strong Contender',
        range: '3.5 - 4.4',
        min: 3.5,
        max: 4.4,
        description: 'High quality content suitable for reference and framing',
      },
      {
        band: 'Baseline Reference',
        range: '2.5 - 3.4',
        min: 2.5,
        max: 3.4,
        description: 'Acceptable baseline, but contains minor structural or visual defects',
      },
      {
        band: 'Sub-par / Reject',
        range: '1.0 - 2.4',
        min: 1.0,
        max: 2.4,
        description: 'Inadequate depth or unacceptable production quality',
      },
    ],
    evaluationPitfalls: [
      'Assuming high view count equates to high script and factual accuracy',
      'Penalizing older authoritative videos due to lower resolution compared to modern uploads',
      'Ignoring narrative gaps when visual editing is flashy',
    ],
  };

  const equalWeights: Record<string, number> = {};
  const weight = Math.floor(100 / qualitativeDimensions.length);
  const rem = 100 - weight * qualitativeDimensions.length;
  qualitativeDimensions.forEach((dim, idx) => {
    equalWeights[dim.dimension] = weight + (idx < rem ? 1 : 0);
  });

  const standardHash = computeStandardHash({
    topic,
    language: options.language,
    version: STANDARD_VERSION,
    promptVersion: options.promptVersion,
    model: options.model,
    quantitativeDimensions,
    qualitativeDimensions,
    compositeGuidance,
  });

  return {
    meta: {
      query: options.query,
      candidateContextHash: options.candidateContextHash,
      topic,
      language: options.language,
      generatedAt: options.now().toISOString(),
      version: STANDARD_VERSION,
      promptVersion: options.promptVersion,
      model: options.model,
      standardHash,
      source: 'fixture',
      pipeline: options.pipeline,
    },
    quantitativeDimensions,
    unresolvedQuantitativeDimensions: [],
    qualitativeEvaluation: {
      equalWeights,
      dimensions: qualitativeDimensions,
      compositeGuidance,
    },
  };
}
