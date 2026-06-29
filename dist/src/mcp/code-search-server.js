#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HybridSearch } from '../core/hybrid-search.js';
const projectPath = process.cwd();
const searcher = new HybridSearch(projectPath);
// Create the MCP server
const server = new McpServer({
    name: 'hydra-code-search',
    version: '1.0.0',
});
// Tool: search_codebase
server.tool('search_codebase', {
    query: z.string().describe('The semantic or keyword query to search the codebase for.'),
    topK: z.number().optional().describe('Number of results to return (default 5).'),
}, async ({ query, topK = 5 }) => {
    try {
        const results = await searcher.search(query, topK);
        if (!results || results.length === 0) {
            return {
                content: [{ type: 'text', text: 'No relevant code chunks found.' }],
            };
        }
        let responseText = `Found ${results.length} results:\n\n`;
        for (const res of results) {
            responseText += `--- File: ${res.file} | Node: ${res.name} | Lines: ${res.startLine}-${res.endLine} ---\n`;
            responseText += res.content + '\n\n';
        }
        return {
            content: [{ type: 'text', text: responseText }],
        };
    }
    catch (e) {
        return {
            content: [
                { type: 'text', text: `Search failed: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
        };
    }
});
// Tool: read_ast_node
server.tool('read_ast_node', {
    nodeName: z.string().describe('The exact name of the class or function to read.'),
}, async ({ nodeName }) => {
    try {
        const docs = searcher.documents.filter((d) => d.chunk && d.chunk.name === nodeName);
        if (docs.length === 0) {
            return {
                content: [{ type: 'text', text: `Node '${nodeName}' not found in the indexed AST.` }],
            };
        }
        let responseText = `Found ${docs.length} occurrences of '${nodeName}':\n\n`;
        for (const doc of docs) {
            const res = doc.chunk;
            responseText += `--- File: ${res.file} | Lines: ${res.startLine}-${res.endLine} ---\n`;
            responseText += res.content + '\n\n';
        }
        return {
            content: [{ type: 'text', text: responseText }],
        };
    }
    catch (e) {
        return {
            content: [
                { type: 'text', text: `Read AST failed: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
        };
    }
});
// Start listening on stdio
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Hydra Code Search MCP server running on stdio');
}
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
