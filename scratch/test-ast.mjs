import { AstIndexer } from "../src/core/ast-indexer.mjs";

(async () => {
  const indexer = new AstIndexer(process.cwd());
  const chunks = await indexer.chunkFile("src/core/hybrid-search.mjs");
  console.log("Chunks found in hybrid-search.mjs:", chunks.length);
  for (const c of chunks) {
     console.log(`- ${c.name} (lines ${c.startLine}-${c.endLine}): ${c.content.length} chars`);
  }
})();
