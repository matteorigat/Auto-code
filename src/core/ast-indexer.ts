import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as babelParser from '@babel/parser';

export interface AstChunk {
  file: string;
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * AstIndexer
 * Divides code into semantic chunks (functions, classes, methods)
 * using @babel/parser.
 */
interface BabelNode {
  type?: string;
  id?: { name?: string };
  key?: { name?: string };
  start?: number;
  end?: number;
  loc?: { start: { line: number }; end: { line: number } };
  body?: BabelNode | BabelNode[];
  [key: string]: unknown;
}

export class AstIndexer {
  projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Parses a file and returns an array of semantic chunks.
   * Can handle JS, TS, and JSX.
   */
  async chunkFile(filePath: string): Promise<AstChunk[]> {
    const absolutePath = join(this.projectPath, filePath);
    if (!existsSync(absolutePath)) return [];

    // Ignore .py for now since babel only does JS/TS
    if (filePath.endsWith('.py')) return [];

    const content = readFileSync(absolutePath, 'utf-8');
    if (!content.trim()) return [];

    let ast: { program: BabelNode };
    try {
      ast = babelParser.parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAssertions'],
      }) as unknown as { program: BabelNode };
    } catch (e: unknown) {
      console.error(
        `[AstIndexer] Failed to parse ${filePath}:`,
        e instanceof Error ? e.message : String(e),
      );
      return [];
    }

    const chunks: AstChunk[] = [];

    const traverse = (node: BabelNode | BabelNode[]): void => {
      if (!node) return;

      if (Array.isArray(node)) {
        node.forEach(traverse);
        return;
      }

      // Capture top-level declarations
      if (
        node.type === 'ClassDeclaration' ||
        node.type === 'FunctionDeclaration' ||
        node.type === 'MethodDefinition' ||
        node.type === 'ClassMethod' ||
        node.type === 'VariableDeclarator' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        let name = 'anonymous';

        if (node.id?.name) {
          name = node.id.name;
        } else if (node.key?.name) {
          name = node.key.name;
        }

        // Avoid pushing very small arrow functions unless they are standalone
        if (node.start !== undefined && node.end !== undefined) {
          const chunkText = content.substring(node.start, node.end);
          if (chunkText.trim()) {
            chunks.push({
              file: filePath,
              name: name,
              content: chunkText,
              startLine: node.loc ? node.loc.start.line : 0,
              endLine: node.loc ? node.loc.end.line : 0,
            });
          }
        }

        if (node.type === 'ClassDeclaration' && node.body) {
          traverse(node.body);
        }
        return; // Don't traverse deeper into the function bodies for now
      }

      // Traverse child objects
      for (const key in node) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (typeof child === 'object' && child !== null) {
          traverse(child as BabelNode | BabelNode[]);
        }
      }
    };

    traverse(ast.program);
    return chunks;
  }
}
