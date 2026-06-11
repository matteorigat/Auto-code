import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AstIndexer } from "./ast-indexer.mjs";
import { pipeline, cos_sim } from "@xenova/transformers";

/**
 * HybridSearch
 * Combines Lexical Search (BM25/TF-IDF) and Semantic Search (Vector Embeddings)
 * to find precise symbols/keywords and conceptual matches in AST chunks.
 */
export class HybridSearch {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.indexPath = join(projectPath, ".hydra", "hybrid-index.json");
    this.indexer = new AstIndexer(projectPath);
    this.documents = []; // Array of { id, chunk, tf, embedding }
    this.termFrequencies = new Map();
    this.docFrequencies = new Map();
    this.extractor = null; // Transformers pipeline
    this.loadIndex();
  }

  async initPipeline() {
    if (!this.extractor) {
      this.extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true, // Uses 8-bit quantized model for extreme efficiency
      });
    }
  }

  async getEmbedding(text) {
    await this.initPipeline();
    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  tokenize(text) {
    if (!text) return [];
    return text.toLowerCase().replace(/[^a-z0-9_]/g, " ").split(/\s+/).filter(t => t.length > 2);
  }

  loadIndex() {
    try {
      if (existsSync(this.indexPath)) {
        const data = JSON.parse(readFileSync(this.indexPath, "utf-8"));
        this.documents = data.documents || [];
        for (const doc of this.documents) {
          if (doc.tfObj) {
            doc.tf = new Map(Object.entries(doc.tfObj));
            delete doc.tfObj;
          }
          if (doc.tf) {
            for (const t of doc.tf.keys()) {
              this.docFrequencies.set(t, (this.docFrequencies.get(t) || 0) + 1);
            }
          }
        }
      }
    } catch (e) {
      this.documents = [];
    }
  }

  saveIndex() {
    try {
      // Convert Maps to objects for JSON serialization
      const docsToSave = this.documents.map(d => ({
        id: d.id,
        chunk: d.chunk,
        tfObj: Object.fromEntries(d.tf),
        embedding: d.embedding
      }));
      writeFileSync(this.indexPath, JSON.stringify({ documents: docsToSave }));
    } catch {}
  }

  /**
   * Re-indexes all specified files.
   * @param {string[]} files Array of relative file paths
   */
  async buildIndex(files) {
    this.documents = [];
    this.termFrequencies.clear();
    this.docFrequencies.clear();

    let processed = 0;
    for (const file of files) {
      if (file.includes("node_modules") || file.includes(".git") || file.includes(".hydra")) continue;
      const chunks = await this.indexer.chunkFile(file);
      for (const chunk of chunks) {
        const fullText = chunk.name + " " + chunk.content;
        
        // 1. Lexical BM25 Tokens
        const tokens = this.tokenize(fullText);
        const tf = new Map();
        for (const t of tokens) {
          tf.set(t, (tf.get(t) || 0) + 1);
        }
        for (const t of tf.keys()) {
          this.docFrequencies.set(t, (this.docFrequencies.get(t) || 0) + 1);
        }
        
        // 2. Semantic Embedding
        const embedding = await this.getEmbedding(fullText);
        
        this.documents.push({
          id: `${chunk.file}#${chunk.startLine}`,
          chunk,
          tf,
          embedding
        });
        processed++;
      }
    }
    this.saveIndex();
    return processed;
  }

  /**
   * Search for top K chunks matching the query using RRF (BM25 + Semantic).
   */
  async search(query, topK = 5) {
    if (!query || !this.documents.length) return [];
    
    // 1. BM25 Scoring
    const qTokens = this.tokenize(query);
    const N = this.documents.length;
    
    const bm25Scores = this.documents.map((doc, index) => {
      let score = 0;
      for (const qt of qTokens) {
        const f = doc.tf.get(qt) || 0;
        if (f > 0) {
          const df = this.docFrequencies.get(qt) || 1;
          const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
          score += idf * ((f * 2.5) / (f + 1.5));
        }
      }
      return { docIndex: index, score };
    }).sort((a, b) => b.score - a.score);

    // Create BM25 Ranks
    const bm25Ranks = new Map();
    bm25Scores.forEach((s, rank) => {
      bm25Ranks.set(s.docIndex, s.score > 0 ? rank + 1 : N);
    });

    // 2. Vector Semantic Scoring
    const qEmbedding = await this.getEmbedding(query);
    const vectorScores = this.documents.map((doc, index) => {
      const score = doc.embedding ? cos_sim(qEmbedding, doc.embedding) : 0;
      return { docIndex: index, score };
    }).sort((a, b) => b.score - a.score);

    // Create Vector Ranks
    const vectorRanks = new Map();
    vectorScores.forEach((s, rank) => {
      vectorRanks.set(s.docIndex, rank + 1);
    });

    // 3. Reciprocal Rank Fusion (RRF)
    const K_RRF = 60; // Standard RRF constant
    const finalScores = this.documents.map((doc, index) => {
      const rankBM25 = bm25Ranks.get(index) || N;
      const rankVector = vectorRanks.get(index) || N;
      const rrfScore = (1 / (K_RRF + rankBM25)) + (1 / (K_RRF + rankVector));
      return { doc, score: rrfScore, rankBM25, rankVector };
    });

    finalScores.sort((a, b) => b.score - a.score);

    return finalScores
      .slice(0, topK)
      .map(s => s.doc.chunk);
  }
}
