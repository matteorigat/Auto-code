import { pipeline } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';

let extractorInstance: FeatureExtractionPipeline | null = null;

export class EmbeddingService {
  static async getEmbedding(text: string): Promise<number[]> {
    if (!extractorInstance) {
      extractorInstance = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
      })) as unknown as FeatureExtractionPipeline;
    }
    const output = await extractorInstance(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data) as number[];
  }
}
