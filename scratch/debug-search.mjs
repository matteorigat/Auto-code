import { HybridSearch } from "../src/core/hybrid-search.mjs";

(async () => {
  const searcher = new HybridSearch(process.cwd());
  
  console.log("Loading index...");
  // Load the index created by the user's run
  if (searcher.documents.length === 0) {
    console.log("No index loaded!");
    return;
  }
  
  console.log("Loaded documents:", searcher.documents.length);
  
  // Find hybrid search chunk manually
  const chunk = searcher.documents.find(d => d.chunk.name === "search" && d.id.includes("hybrid-search"));
  if (chunk) {
    console.log("Found chunk 'search' in index!");
    console.log("Embedding length:", chunk.embedding?.length);
    console.log("TF keys:", Array.from(chunk.tf.keys()));
  } else {
    console.log("Chunk 'search' NOT found in index!");
  }

  // Run search
  const query = "hybrid search logic and rrf fusion";
  console.log(`\nSearching for: "${query}"`);
  
  const qTokens = searcher.tokenize(query);
  console.log("Query tokens:", qTokens);
  
  // 1. BM25 Scoring
  const N = searcher.documents.length;
  const bm25Scores = searcher.documents.map((doc, index) => {
    let score = 0;
    for (const qt of qTokens) {
      const f = doc.tf.get(qt) || 0;
      if (f > 0) {
        const df = searcher.docFrequencies.get(qt) || 1;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        score += idf * ((f * 2.5) / (f + 1.5));
      }
    }
    return { docIndex: index, score, name: doc.chunk.name, file: doc.chunk.file };
  }).sort((a, b) => b.score - a.score);

  console.log("\nTop 5 BM25:");
  bm25Scores.slice(0, 5).forEach((s, rank) => console.log(`${rank+1}. ${s.name} (${s.file}): ${s.score}`));

  // 2. Vector Scoring
  const qEmbedding = await searcher.getEmbedding(query);
  const vectorScores = searcher.documents.map((doc, index) => {
    let score = 0;
    if (doc.embedding && qEmbedding) {
       // Manual dot product for cosine sim assuming normalized
       let dot = 0;
       for (let i = 0; i < qEmbedding.length; i++) {
         dot += qEmbedding[i] * doc.embedding[i];
       }
       score = dot;
    }
    return { docIndex: index, score, name: doc.chunk.name, file: doc.chunk.file };
  }).sort((a, b) => b.score - a.score);

  console.log("\nTop 5 Vector:");
  vectorScores.slice(0, 5).forEach((s, rank) => console.log(`${rank+1}. ${s.name} (${s.file}): ${s.score}`));

})();
