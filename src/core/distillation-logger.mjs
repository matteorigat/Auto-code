import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DistillationLogger
 * Automatically captures successful LLM interactions and formats them
 * into an OpenAI-compatible JSONL dataset for LoRA Fine-Tuning.
 */
export class DistillationLogger {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.hydraDir = join(projectPath, '.hydra');
    if (!existsSync(this.hydraDir)) mkdirSync(this.hydraDir, { recursive: true });
    this.datasetPath = join(this.hydraDir, 'distillation-dataset.jsonl');
  }

  /**
   * Appends a successful interaction to the dataset.
   * @param {string} systemPrompt The system prompt used
   * @param {string} userPrompt The specific task prompt / context
   * @param {string} assistantContent The generated correct code/response
   */
  appendSuccess(systemPrompt, userPrompt, assistantContent) {
    if (!assistantContent || !userPrompt) return;

    const entry = {
      messages: [
        { role: 'system', content: systemPrompt || 'You are an expert developer.' },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantContent },
      ],
    };

    try {
      appendFileSync(this.datasetPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (e) {
      console.error('[DistillationLogger] Failed to write dataset entry:', e);
    }
  }
}

export default DistillationLogger;
