import { pipeline } from '@xenova/transformers';
let extractorInstance = null;
export class EmbeddingService {
    static async getEmbedding(text) {
        if (!extractorInstance) {
            extractorInstance = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                quantized: true,
            }));
        }
        const output = await extractorInstance(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }
}
