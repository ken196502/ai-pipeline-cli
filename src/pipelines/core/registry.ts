import type { Pipeline } from './contracts.js';

export class PipelineRegistry {
  private readonly pipelines = new Map<string, Pipeline>();

  register(pipeline: Pipeline): void {
    this.pipelines.set(pipeline.id, pipeline);
  }

  get(id: string): Pipeline | undefined {
    return this.pipelines.get(id);
  }

  list(): Pipeline[] {
    return Array.from(this.pipelines.values());
  }

  async run<TOptions, TResult>(id: string, options: TOptions, ctx?: any): Promise<TResult> {
    const pipeline = this.get(id);
    if (!pipeline) {
      throw new Error(`Pipeline "${id}" not found in registry. Available: ${Array.from(this.pipelines.keys()).join(', ')}`);
    }
    const validated = pipeline.schema.parse(options);
    return pipeline.execute(validated, ctx) as Promise<TResult>;
  }
}

export const pipelineRegistry = new PipelineRegistry();
