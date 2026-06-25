import { pipeline } from '@xenova/transformers';

let extractorInstance = null;

export class EmbeddingService {
  /**
   * Returns a mean-pooled, normalized embedding for the given text.
   * Lazily initializes the 8-bit quantized MiniLM model on first use.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  static async getEmbedding(text) {
    if (!extractorInstance) {
      extractorInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true, // Uses 8-bit quantized model for extreme efficiency
      });
    }
    const output = await extractorInstance(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }
}
