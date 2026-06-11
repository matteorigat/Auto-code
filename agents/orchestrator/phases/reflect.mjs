import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export async function handleReflect(context) {
  const { tasks, state, projectPath, log, updateStatus, safety, stream } = context;
  const { AgentRuntime } = await import("../../runtime.mjs");

  const taskId = state.get().currentTaskId;
  const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
  const ws = task?.workspacePath || projectPath;
  
  updateStatus({ phase: "REFLECT", taskTitle: state.get().currentStory, taskId });
  log("[REFLECT] extracting reusable skills");

  try {
    const diff = execSync("git diff HEAD~1 HEAD", { cwd: ws, shell: "/bin/bash", timeout: 10000 }).toString();
    if (!diff.trim()) {
      log("[REFLECT] no diff found, skipping");
    } else {
      // Helper per model
      const getModel = () => process.env.OPENCODE_DEFAULT_MODEL || "openai/tier-2-hunter";
      
      const agent = new AgentRuntime({ projectPath, agentType: "skill-extractor", safety, stream });
      agent.task = { title: state.get().currentStory, description: diff };

      // Set model explicitly if needed via config file, but AgentRuntime also picks it up
      const result = await agent.run(120000); // 2 min timeout
      if (result.ok && (result.content || result.result?.info?.content)) {
        const skillContent = result.content || result.result.info.content;
        if (!skillContent.includes("NO_SKILL") && skillContent.length > 50) {
          const skillsDir = join(projectPath, ".hydra", "skills");
          if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
          
          const titleMatch = skillContent.match(/^#\\s+(.+)$/m);
          let safeTitle = taskId;
          if (titleMatch) {
            safeTitle = titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
          }
          const filename = `skill-${safeTitle}-${Date.now().toString(36)}.md`;
          
          writeFileSync(join(skillsDir, filename), skillContent, "utf-8");
          log(`[REFLECT] extracted skill saved to ${filename}`);
        } else {
          log("[REFLECT] task deemed trivial, no skill extracted");
        }
      }
    }
  } catch (err) {
    log(`[REFLECT] error (non-fatal): ${err.message}`);
  }

  stream.emit("System", "system", { 
    action: "PhaseChange", 
    phase: "SYNC"
  });
}
