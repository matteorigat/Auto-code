#!/usr/bin/env node
import { HybridSearch } from '../src/core/hybrid-search.js';
import { readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('Usage: node search_codebase.ts <query>');
  process.exit(1);
}

const projectPath = process.cwd();
const searcher = new HybridSearch(projectPath);

function getFiles(dir: string, files: string[] = []): string[] {
  const list = readdirSync(dir);
  for (const f of list) {
    if (f === 'node_modules' || f === '.git' || f === '.hydra') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      getFiles(p, files);
    } else if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.ts') || f.endsWith('.py')) {
      files.push(p);
    }
  }
  return files;
}

// Find JS/TS/PY files in the current directory, ignoring node_modules
(async () => {
  try {
    const files = getFiles('.');

    console.log(`Indexing ${files.length} files...`);
    await searcher.buildIndex(files);

    console.log(`Searching for: "${query}"...\n`);
    const results = await searcher.search(query, 5);

    if (!results.length) {
      console.log('No relevant AST chunks found.');
      process.exit(0);
    }

    for (const res of results) {
      console.log(
        `--- Match in ${res.file} (${res.name}) Lines ${res.startLine}-${res.endLine} ---`,
      );
      console.log(res.content);
      console.log();
    }
  } catch (e: unknown) {
    console.error('Error performing codebase search:', (e as Error).message);
    process.exit(1);
  }
})();
