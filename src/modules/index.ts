/**
 * Modules Subsystem (Layer 2 of the 3-Layer Architecture).
 *
 * Exposes 5 decoupled, self-contained business capability modules that can be
 * tested and executed independently or orchestrated within pipelines:
 *
 * 1. Auth Module: X (Twitter) automated login & persistent session verification
 * 2. Discovery Module: X topic search, tweet card screenshotting, and NxN candidate contact grid montage
 * 3. Evaluation Module: Multimodal Vision-Language (VL) evaluation, scoring, top 3 ranking, and winner determination
 * 4. Harvest Module: Winner topic deep search, tweet harvesting, image downloads, and yt-dlp video downloads
 * 5. Presentation Module: Storyboard generation, Edge-TTS voice synthesis, HTML5/Canvas player generation, and headless 1080p MP4 rendering
 */

export * as authModule from './auth/index.js';
export * as discoveryModule from './discovery/index.js';
export * as evaluationModule from './evaluation/index.js';
export * as harvestModule from './harvest/index.js';
export * as presentationModule from './presentation/index.js';

export { testAuthModule } from './auth/index.js';
export { testDiscoveryModule } from './discovery/index.js';
export { testEvaluationModule } from './evaluation/index.js';
export { testHarvestModule } from './harvest/index.js';
export { testPresentationModule } from './presentation/index.js';

export * from './auth/index.js';
export * from './discovery/index.js';
export * from './evaluation/index.js';
export * from './harvest/index.js';
export * from './presentation/index.js';

/**
 * Executes isolated self-tests across all 5 modules one by one.
 */
export async function testAllModules(): Promise<{
  allPassed: boolean;
  results: Record<string, { success: boolean; errors?: string[] }>;
}> {
  const { testAuthModule } = await import('./auth/index.js');
  const { testDiscoveryModule } = await import('./discovery/index.js');
  const { testEvaluationModule } = await import('./evaluation/index.js');
  const { testHarvestModule } = await import('./harvest/index.js');
  const { testPresentationModule } = await import('./presentation/index.js');

  const results: Record<string, { success: boolean; errors?: string[] }> = {};

  // 1. Auth Module Test
  const authRes = await testAuthModule();
  results['auth'] = { success: authRes.success, errors: authRes.errors };

  // 2. Discovery Module Test
  const discRes = await testDiscoveryModule();
  results['discovery'] = { success: discRes.success, errors: discRes.errors };

  // 3. Evaluation Module Test
  const evalRes = await testEvaluationModule();
  results['evaluation'] = { success: evalRes.success, errors: evalRes.errors };

  // 4. Harvest Module Test
  const harvestRes = await testHarvestModule();
  results['harvest'] = { success: harvestRes.success, errors: harvestRes.errors };

  // 5. Presentation Module Test
  const presRes = await testPresentationModule();
  results['presentation'] = { success: presRes.success, errors: presRes.errors };

  const allPassed = Object.values(results).every((r) => r.success);
  return { allPassed, results };
}
