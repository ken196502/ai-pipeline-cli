import { XHotEvalResultSchema } from './contracts.js';

export * from './contracts.js';
export * from './eval.js';

/**
 * Self-test routine for the Evaluation Module.
 * Verifies schema parsing, rankings validation, and data integrity contracts.
 */
export async function testEvaluationModule(): Promise<{
  success: boolean;
  schemaValidationPassed: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let schemaValidationPassed = false;

  try {
    const mockPayload = {
      query: 'new model',
      evaluatedAt: new Date().toISOString(),
      gridImagePath: '/tmp/mock-grid.png',
      winner: {
        rank: 1,
        index: 1,
        id: '101',
        name: 'Claude 3.7',
        summary: 'Hybrid reasoning milestone',
        reason: 'Overwhelming benchmark and community engagement',
      },
      topCandidates: [
        {
          rank: 1,
          index: 1,
          id: '101',
          name: 'Claude 3.7',
          summary: 'Hybrid reasoning milestone',
          reason: 'Benchmark performance',
        },
        {
          rank: 2,
          index: 2,
          id: '102',
          name: 'DeepSeek-V3',
          summary: 'Open source weights',
          reason: 'High replication activity',
        },
      ],
      reasoning: 'Detailed multimodal evaluation selecting Claude 3.7.',
    };

    const parsed = XHotEvalResultSchema.parse(mockPayload);
    schemaValidationPassed = parsed.winner.rank === 1 && parsed.topCandidates.length === 2;
    if (!schemaValidationPassed) {
      errors.push('Schema validation failed to enforce top candidate structure');
    }
  } catch (err: any) {
    errors.push(`Evaluation self-test error: ${err.message}`);
  }

  return {
    success: errors.length === 0,
    schemaValidationPassed,
    errors,
  };
}
