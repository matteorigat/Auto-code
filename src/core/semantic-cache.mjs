import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline, cos_sim } from "@xenova/transformers";

/**
 * SemanticCache
 * Predictive caching layer using Vector Embeddings.
 * Bypasses LLM API calls if an identical or highly similar task
 * was already completed in the past.
 */
export class SemanticCache {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.hydraDir = join(projectPath, ".hydra");
    if (!existsSync(this.hydraDir)) mkdirSync(this.hydraDir, { recursive: true });
    this.cachePath = join(this.hydraDir, "semantic-cache.json");
    
    this.entries = [];
    this.extractor = null;
    this.loadCache();
  }

  async initPipeline() {
    if (!this.extractor) {
      this.extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true, // 8-bit quantization for speed
      });
    }
  }

  loadCache() {
    try {
      if (existsSync(this.cachePath)) {
        const data = JSON.parse(readFileSync(this.cachePath, "utf-8"));
        this.entries = data.entries || [];
      }
    } catch (e) {
      this.entries = [];
    }
  }

  saveCache() {
    try {
      writeFileSync(this.cachePath, JSON.stringify({ entries: this.entries }));
    } catch {}
  }

  async getEmbedding(text) {
    await this.initPipeline();
    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  /**
   * Search for a semantic hit in the cache.
   * @param {string} prompt The task description/prompt
   * @param {number} threshold The minimum cosine similarity to consider a hit (default 0.95)
   * @returns {Promise<{ hit: boolean, content?: string, similarity?: number }>}
   */
  async findMatch(prompt, threshold = 0.95) {
    if (!prompt || this.entries.length === 0) return { hit: false };

    const queryEmbedding = await this.getEmbedding(prompt);
    let bestMatch = null;
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
  async store(prompt, content, costSaved = 0) {
    if (!prompt || !content) return;
    
    const embedding = await this.getEmbedding(prompt);
    
    // Check if exactly identical prompt exists to update it rather than append
    const existingIdx = this.entries.findIndex(e => e.prompt === prompt);
    
    const newEntry = {
      prompt,
      embedding,
      content,
      costSaved,
      timestamp: Date.now()
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
