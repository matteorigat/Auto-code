import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EmbeddingService } from './embedding-service.js';
import { cos_sim } from '@xenova/transformers';

export interface CacheEntry {
  prompt: string;
  embedding: number[];
  content: string;
  costSaved: number;
  timestamp: number;
}

/**
 * SemanticCache
 * Predictive caching layer using Vector Embeddings.
 * Bypasses LLM API calls if an identical or highly similar task
 * was already completed in the past.
 */
export class SemanticCache {
  projectPath: string;
  hydraDir: string;
  cachePath: string;
  entries: CacheEntry[];
  extractor: null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.hydraDir = join(projectPath, '.hydra');
    if (!existsSync(this.hydraDir)) mkdirSync(this.hydraDir, { recursive: true });
    this.cachePath = join(this.hydraDir, 'semantic-cache.json');

    this.entries = [];
    this.extractor = null;
    this.loadCache();
  }

  loadCache() {
    try {
      if (existsSync(this.cachePath)) {
        const data = JSON.parse(readFileSync(this.cachePath, 'utf-8'));
        this.entries = data.entries || [];
      }
    } catch (e) {
      this.entries = [];
    }
  }

  saveCache() {
    try {
      writeFileSync(this.cachePath, JSON.stringify({ entries: this.entries }));
    } catch (e: unknown) {
      console.error('Ignored error:', e instanceof Error ? e.message : String(e));
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    return await EmbeddingService.getEmbedding(text);
  }

  /**
   * Search for a semantic hit in the cache.
   * @param {string} prompt The task description/prompt
   * @param {number} threshold The minimum cosine similarity to consider a hit (default 0.95)
   */
  async findMatch(
    prompt: string,
    threshold: number = 0.95,
  ): Promise<{ hit: boolean; content?: string; similarity?: number }> {
    if (!prompt || this.entries.length === 0) return { hit: false };

    const queryEmbedding = await this.getEmbedding(prompt);
    let bestMatch: CacheEntry | null = null;
    let highestSim = -1;

    for (const entry of this.entries) {
      if (!entry.embedding) continue;
      const sim = cos_sim(queryEmbedding, entry.embedding);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = entry;
      }
    }

    if (highestSim >= threshold && bestMatch) {
      return { hit: true, content: bestMatch.content, similarity: highestSim };
    }

    return { hit: false };
  }

  /**
   * Store a successful LLM response in the semantic cache.
   * @param {string} prompt The original task description/prompt
   * @param {string} content The generated response
   * @param {number} costSaved Optional cost tracking
   */
  async store(prompt: string, content: string, costSaved: number = 0) {
    if (!prompt || !content) return;

    const embedding = await this.getEmbedding(prompt);

    // Check if exactly identical prompt exists to update it rather than append
    const existingIdx = this.entries.findIndex((e) => e.prompt === prompt);

    const newEntry: CacheEntry = {
      prompt,
      embedding,
      content,
      costSaved,
      timestamp: Date.now(),
    };

    if (existingIdx >= 0) {
      this.entries[existingIdx] = newEntry;
    } else {
      this.entries.push(newEntry);
    }

    this.saveCache();
  }
}

export default SemanticCache;
