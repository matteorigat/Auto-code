import { basename, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';
import { AgentRuntime } from '../../runtime.js';

/**
 * Structured story extracted from project-planner PLAN.md or prd.json.
 */
interface ParsedStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/**
 * PRIMARY: Try to parse stories from the project-planner's prd.json output.
 * The project-planner is now instructed to write prd.json directly with full AC.
 * Falls back to content parsing if prd.json isn't parseable.
 */
function parseStoriesFromJson(content: string): ParsedStory[] | null {
  // Look for a JSON block in the content (project-planner may output it inline)
  const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) ||
    content.match(/\{[\s\S]*"stories"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const raw = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(raw);
    const stories = parsed.stories || parsed;
    if (!Array.isArray(stories)) return null;
    return stories
      .filter((s: Record<string, unknown>) => s.title || s.name)
      .map((s: Record<string, unknown>) => ({
        title: String(s.title || s.name || '').trim(),
        description: String(s.description || '').trim(),
        acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
          ? (s.acceptanceCriteria as string[]).map(String)
          : [],
      }))
      .filter((s) => s.title.length > 5);
  } catch {
    return null;
  }
}

/**
 * SECONDARY: Extract stories from PLAN.md task sections.
 * Parses task blocks that contain: title, description, and AC bullet lists.
 * Accepts numbered (1.), bullet (- * •), or heading (## ###) formats.
 */
function extractStoriesFromContent(content: string): ParsedStory[] {
  const seen = new Set<string>();
  const stories: ParsedStory[] = [];

  // Split on task/story boundaries: ## Task N, ### Story N, \n---\n, \n\n---\n
  // Also split on numbered headers like "1. Title\n"
  const taskBlocks = content.split(/(?=^#{2,3}\s+(?:Task|Story|US-|\d+))/m);

  for (const block of taskBlocks) {
    const lines = block.split('\n').map((l) => l.trim());
    if (lines.length < 2) continue;

    // Extract title from first non-empty line
    let title = '';
    let titleLineIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const l = lines[i];
      const headingMatch = l.match(/^#{1,4}\s+(?:Task\s+\d+[:.]\s*)?(.+)$/);
      const numberedMatch = l.match(/^\d+[.)]\s+(.+)$/);
      const bulletMatch = l.match(/^[-*•]\s+(.+)$/);
      const candidate = headingMatch?.[1] || numberedMatch?.[1] || bulletMatch?.[1];
      if (candidate && candidate.length > 5 && candidate.length < 200) {
        title = candidate.trim();
        titleLineIdx = i;
        break;
      }
    }
    if (!title || seen.has(title)) continue;

    // Extract description: first paragraph after title
    let description = '';
    let acStart = -1;
    for (let i = titleLineIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      // AC section keywords
      if (/^(?:acceptance\s*criteria|ac:|criteria:|tests?:|requirements?:)/i.test(l)) {
        acStart = i + 1;
        break;
      }
      if (!description && l.length > 10 && !l.startsWith('#')) {
        description = l;
      }
    }

    // Extract AC items
    const acceptanceCriteria: string[] = [];
    const acLines = acStart >= 0 ? lines.slice(acStart) : lines.slice(titleLineIdx + 1);
    for (const l of acLines) {
      // Stop at next section boundary
      if (/^#{1,4}\s/.test(l) || /^---+$/.test(l)) break;
      const bulletMatch = l.match(/^[-*•✓☑]\s+(.+)$/) || l.match(/^\d+[.)]\s+(.+)$/);
      if (bulletMatch && bulletMatch[1].length > 5) {
        acceptanceCriteria.push(bulletMatch[1].trim());
      }
    }

    seen.add(title);
    stories.push({ title, description, acceptanceCriteria });
  }

  // Fallback: simple line-by-line extraction if block parsing yielded nothing
  if (stories.length === 0) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      let title = '';
      const m = line.match(/^(?:\d+[.)]\s+|[-*•]\s+|#{2,4}\s+)(.+)$/);
      if (m) title = m[1].trim();
      if (title && title.length > 5 && title.length < 200 && !seen.has(title)) {
        seen.add(title);
        stories.push({ title, description: '', acceptanceCriteria: [] });
      }
    }
  }

  return stories;
}

export async function handlePlan(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[PLAN] Running PLAN phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const readyTaskIds = (currentState as Record<string, unknown[]>).readyTaskIds || [];

  if (!readyTaskIds.length) {
    log(`[PLAN] No tasks to plan. Back to IDLE.`);
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksToExec: string[] = [];
  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];

  for (const taskId of readyTaskIds) {
    const task = tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
    if (!task) continue;

    updateStatus({ phase: 'PLAN', taskTitle: task.title, taskId: task.id });

    if (tasks.needsSplitting(task as never)) {
      log(`[PLAN] Story ${task.id} too large — splitting`);
      const parts = tasks.splitStory(task as never);
      const newTasks = tasksArr.filter(
        (t: Record<string, unknown>) => String(t.id) !== String(task.id),
      );
      (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks = newTasks;
      for (const p of parts) tasks.addStory(p);
      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    const projectDir = _resolveProjectDir(task, projectPath);
    task.workspacePath = projectDir;
    task._projectSlug = basename(projectDir);

    // Project-level planning check
    const sddArtifacts = ['PLAN.md', 'PRODUCT-SPEC.md', 'TECHNICAL-SPEC.md', 'CONSTITUTION.md'];
    const hasSddArtifacts = sddArtifacts.every((f: string) => existsSync(join(projectDir, f)));

    const localTasks = new TaskManager({ projectPath: projectDir });
    let storyCount = 0;
    try {
      const projPrd = localTasks.readPRD() as unknown as Record<string, unknown[]>;
      storyCount = ((projPrd.stories || []) as unknown[]).length;
    } catch (_) {}

    const isNewProject = storyCount <= 1 || !hasSddArtifacts;

    if (isNewProject) {
      updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Decomposing project with project-planner...`, taskId: task.id });
      log(`[PLAN] Project ${task._projectSlug} is new or missing SDD specifications. Running project-planner...`);
      const tierSelector = new TierSelector();
      const tier = tierSelector.select('PLAN');
      tierSelector.applyTierConfig(tier, projectDir);

      // B6: Inject ideas.md content as task description so planner has full spec context
      let ideasContent = '';
      const ideasPath = join(projectDir, 'ideas.md');
      try {
        if (existsSync(ideasPath)) {
          ideasContent = readFileSync(ideasPath, 'utf-8').slice(0, 6000);
        }
      } catch (_) {}

      const planner = new AgentRuntime({
        projectPath: projectDir,
        agentType: 'project-planner',
        safety,
        stream,
      });
      planner.task = {
        title: (task.title as string) || (task._projectSlug as string) || 'New Project',
        description: ideasContent ||
          (task.description as string) ||
          `Project: ${task._projectSlug}. No ideas.md found — infer from project name.`,
      };
      const planResult = await planner.run(600000);

      const planContent = planResult?.content || '';
      if (planContent) {
        updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Writing SDD specification files (PLAN.md, PRODUCT-SPEC.md, ...)...`, taskId: task.id });
        const sections = planContent.split(/(?=^## )/m);
        for (const section of sections) {
          const header = section.match(/^## (.+)$/m);
          if (header) {
            const title = header[1].trim();
            let fileName = '';
            const lower = title.toLowerCase();
            if (lower.includes('constitution')) fileName = 'CONSTITUTION.md';
            else if (lower.includes('product') || lower.includes('functional')) fileName = 'PRODUCT-SPEC.md';
            else if (lower.includes('technical')) fileName = 'TECHNICAL-SPEC.md';
            else if (lower.includes('plan') || lower.includes('implement')) fileName = 'PLAN.md';
            if (fileName) {
              try {
                writeFileSync(join(projectDir, fileName), section.trimStart(), 'utf-8');
              } catch (_) {}
            }
          }
        }

        // F1: Multi-format story extraction with AC (JSON primary, PLAN.md fallback)
        updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Decomposing tasks and saving backlog to prd.json...`, taskId: task.id });
        
        // Try to read prd.json that the project-planner wrote directly (it's now instructed to do so)
        let parsedStories: Record<string, unknown>[] = [];
        let usedLocalPrd = false;
        try {
          const localPrdRaw = readFileSync(join(projectDir, 'prd.json'), 'utf-8');
          const localPrd = JSON.parse(localPrdRaw);
          if (Array.isArray(localPrd.stories) && localPrd.stories.length > 0) {
            parsedStories = localPrd.stories;
            usedLocalPrd = true;
            log(`[PLAN] Using prd.json written directly by project-planner (${parsedStories.length} stories with AC).`);
          }
        } catch (_) {}

        // Fallback: parse from planContent using structured extractor
        if (!usedLocalPrd) {
          // Try JSON blocks first, then PLAN.md block parsing
          const jsonStories = parseStoriesFromJson(planContent);
          const structuredStories = jsonStories ?? extractStoriesFromContent(planContent);
          
          for (const s of structuredStories) {
            const storyData: Record<string, unknown> = {
              id: `US-${Date.now().toString(36)}-${parsedStories.length + 1}`,
              title: s.title,
              description: s.description || '',
              acceptanceCriteria: s.acceptanceCriteria || [],
              priority: 3,
              status: 'idle',
              passes: false,
            };
            parsedStories.push(storyData);
          }
          
          const acCount = parsedStories.filter((s) => ((s.acceptanceCriteria as string[])?.length || 0) > 0).length;
          log(`[PLAN] Extracted ${parsedStories.length} stories from content (${acCount} with AC).`);
        }

        if (parsedStories.length > 0) {
          const codebasePatterns = planContent.match(/## Technical[\s\S]*?(?=## |$)/)?.[0] || '';
          const localPrdData = {
            project: task.title,
            projectSlug: task._projectSlug,
            description: task.description || '',
            codebasePatterns: codebasePatterns.slice(0, 2000),
            stories: parsedStories,
          };
          writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(localPrdData, null, 2), 'utf-8');
          log(`[PLAN] Written ${parsedStories.length} stories to ${task._projectSlug}/prd.json`);
        } else {
          log(`[PLAN] WARNING: project-planner returned 0 parseable stories. Content length: ${planContent.length}. Check project-planner output.`);
        }
      } else {
        log(`[PLAN] WARNING: project-planner returned empty content. Task: ${task.id}. Check LLM response.`);
      }

      // Sync stories back to root prd.json
      updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Syncing project stories to root backlog...`, taskId: task.id });
      try {
        const projPrd = localTasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
        const rootPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
        let rootProjEntry = ((rootPrd.projects || []) as Record<string, unknown>[]).find(
          (p: Record<string, unknown>) => p.slug === task._projectSlug,
        ) as Record<string, unknown> | undefined;
        if (!rootProjEntry) {
          rootProjEntry = {
            slug: task._projectSlug,
            title: task.title,
            description: task.description || '',
            codebasePatterns: '',
            stories: [],
          };
          (rootPrd.projects as Record<string, unknown>[]).push(rootProjEntry);
        }
        rootProjEntry.stories = projPrd.stories || [];
        tasks.writePRD(rootPrd as unknown as import('../../../src/core/task-manager.js').PRD);
        log(`[PLAN] project-planner finished. Backlog decomposed into ${projPrd.stories?.length || 0} stories.`);
      } catch (err: unknown) {
        log(`[PLAN] Failed to sync planned stories back to root: ${(err as Error).message}`);
      }

      // Mark the project-level task as completed!
      tasks.markPass(task.id as string);

      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    log(`[PLAN] Planning task: ${task.id} ${task.title}`);

    (tasks as unknown as Record<string, (t: Record<string, unknown>) => void>)._syncProjectFiles(
      task,
    );

    const tierSelector = new TierSelector();
    const tier = tierSelector.select('PLAN');
    tierSelector.applyTierConfig(tier, projectDir);

    updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Generating tests and requirements with task-planner...`, taskId: task.id });
    log(`[PLAN] [${task.id}] Running task-planner to generate tests and details`);
    const taskPlanner = new AgentRuntime({
      projectPath: projectDir,
      agentType: 'task-planner',
      task,
      safety,
      stream,
      tasks: localTasks,
    });
    await taskPlanner.run(300000);

    updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Architecting technical changes with architect...`, taskId: task.id });
    log(`[PLAN] [${task.id}] Running architect to generate technical proposal`);
    const architect = new AgentRuntime({
      projectPath: projectDir,
      agentType: 'architect',
      task,
      safety,
      stream,
      tasks: localTasks,
    });
    const architectResult = await architect.run(300000);
    let architectProposal = architectResult?.content ||
      (architectResult?.result as { info?: { content?: string } } | undefined)?.info?.content || '';

    // F5: Reviewer gate — PROPOSAL REJECTED loops back to architect (max 2 cycles)
    let reviewContent = '';
    const MAX_REVIEW_CYCLES = 2;
    for (let reviewCycle = 0; reviewCycle < MAX_REVIEW_CYCLES; reviewCycle++) {
      updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Reviewing technical plan (attempt ${reviewCycle + 1})...`, taskId: task.id });
      log(`[PLAN] [${task.id}] Running reviewer (cycle ${reviewCycle + 1}/${MAX_REVIEW_CYCLES})`);
      const reviewer = new AgentRuntime({
        projectPath: projectDir,
        agentType: 'reviewer',
        task: {
          ...task,
          title: `Review Proposal: ${task.title}`,
          description: architectProposal
            ? `Review this technical proposal and provide feedback:\n\n${architectProposal.slice(0, 6000)}`
            : `Review the task: ${task.description || task.title}`,
        },
        safety,
        stream,
        tasks: localTasks,
      });
      const reviewerResult = await reviewer.run(300000);
      reviewContent = reviewerResult?.content ||
        (reviewerResult?.result as { info?: { content?: string } } | undefined)?.info?.content || '';

      const isApproved = /PROPOSAL APPROVED|^APPROVED/im.test(reviewContent);
      const isRejected = /PROPOSAL REJECTED|PROPOSAL BLOCKED/im.test(reviewContent);

      if (isApproved) {
        log(`[PLAN] [${task.id}] Reviewer APPROVED the technical proposal. Proceeding to CODE.`);
        break;
      } else if (isRejected && reviewCycle < MAX_REVIEW_CYCLES - 1) {
        // Extract rejection reason and re-run architect with the feedback
        const rejectedReason = reviewContent.match(/PROPOSAL (?:REJECTED|BLOCKED):\s*(.+)/i)?.[1] || 'See reviewer feedback';
        log(`[PLAN] [${task.id}] Reviewer REJECTED proposal: ${rejectedReason}. Re-running architect with feedback.`);
        updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Revising architecture based on reviewer feedback...`, taskId: task.id });
        const revisedArchitect = new AgentRuntime({
          projectPath: projectDir,
          agentType: 'architect',
          task: {
            ...task,
            description: `${task.description || ''}\n\nIMPORTANT: Your previous proposal was rejected by the reviewer. Rejection reason: ${rejectedReason}\n\nReviewer feedback:\n${reviewContent.slice(0, 3000)}\n\nRevise your proposal to address all issues.`,
          },
          safety,
          stream,
          tasks: localTasks,
        });
        const revisedResult = await revisedArchitect.run(300000);
        architectProposal = revisedResult?.content ||
          (revisedResult?.result as { info?: { content?: string } } | undefined)?.info?.content || architectProposal;
      } else if (isRejected) {
        // Max cycles exhausted — escalate to WAIT_HUMAN
        log(`[PLAN] [${task.id}] ESCALATING: architect/reviewer could not reach consensus after ${MAX_REVIEW_CYCLES} cycles.`);
        stream.emit('System', 'system', {
          action: 'PhaseChange',
          phase: 'WAIT_HUMAN',
          stateUpdates: {
            humanGateReason: `Architecture could not be agreed upon for task "${task.title}". Reason: ${reviewContent.slice(0, 300)}`,
            resumeTarget: 'PLAN',
          },
        });
        return;
      } else {
        // No clear verdict — treat as approved with a warning
        log(`[PLAN] [${task.id}] Reviewer did not output a clear verdict. Treating as approved with caution.`);
        break;
      }
    }

    // Save architect proposal + reviewer feedback to disk so builder can read it
    if (architectProposal || reviewContent) {
      try {
        const hydraDir = join(projectDir, '.hydra');
        if (!existsSync(hydraDir)) mkdirSync(hydraDir, { recursive: true });
        const reviewFilePath = join(hydraDir, `review-${task.id}.md`);
        const reviewDoc = [
          `# Technical Plan — ${task.title}`,
          '',
          architectProposal ? `## Architect Proposal\n\n${architectProposal}` : '',
          reviewContent ? `## Reviewer Feedback\n\n${reviewContent}` : '',
        ].filter(Boolean).join('\n\n');
        writeFileSync(reviewFilePath, reviewDoc, 'utf-8');
        log(`[PLAN] [${task.id}] Saved architect+reviewer output to .hydra/review-${task.id}.md`);
      } catch (err: unknown) {
        log(`[PLAN] [${task.id}] Failed to save review file: ${(err as Error).message}`);
      }
    }

    tasksToExec.push(task.id as string);
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'CODE',
    stateUpdates: { execTaskIds: tasksToExec },
  });
}

function _resolveProjectDir(story: Record<string, unknown>, projectPath: string): string {
  if (story.workspacePath && existsSync(story.workspacePath as string))
    return story.workspacePath as string;
  if (story._projectSlug) return join(projectPath, 'projects', story._projectSlug as string);
  return projectPath;
}
