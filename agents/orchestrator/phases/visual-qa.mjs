import puppeteer from 'puppeteer';
import { AgentRuntime } from "../../runtime.mjs";

export async function handleVisualQa(context) {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[VISUAL_QA] Running VISUAL_QA phase...`);
  const currentState = state.get();
  const visualQaTaskIds = currentState.visualQaTaskIds || [];

  if (!visualQaTaskIds.length) {
    stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
    return;
  }

  let allPassed = true;

  for (const taskId of visualQaTaskIds) {
    const task = tasks._tasks.find(t => String(t.id) === String(taskId));
    if (!task) continue;

    const ws = task.workspacePath || projectPath;
    updateStatus({ phase: "VISUAL_QA", taskTitle: task.title, taskId: task.id });

    // Update state checkpoint with current task details during Visual QA
    state.transition("VISUAL_QA", {
      currentTaskId: task.id,
      currentStory: task.title
    });
    
    log(`[VISUAL_QA] Attempting to screenshot UI for ${taskId}`);
    
    let browser;
    let screenshotBase64 = null;
    try {
      browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 5000 });
      screenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true });
    } catch (e) {
      log(`[VISUAL_QA] Could not capture screenshot (maybe not a web app or server not running): ${e.message}`);
    } finally {
      if (browser) await browser.close();
    }

    if (screenshotBase64) {
      log(`[VISUAL_QA] Invoking visual-reviewer AgentRuntime`);
      
      const runtime = new AgentRuntime({ projectPath: ws, agentType: "visual-reviewer", task, safety, stream });
      
      // Pass the image context
      runtime.task = {
        ...task,
        _screenshotBase64: screenshotBase64
      };

      const result = await runtime.run(120000);
      const feedback = result.content || result.result?.info?.content || "";
      
      if (feedback.includes("APPROVED")) {
        log(`[VISUAL_QA] ${taskId} PASSED visual inspection`);
        tasks.markPass(taskId);
      } else {
        log(`[VISUAL_QA] ${taskId} FAILED visual inspection`);
        allPassed = false;
        const reflectionCount = currentState.reflectionCount || 0;
        stream.emit("System", "system", { 
          action: "PhaseChange", 
          phase: "FIX", 
          stateUpdates: { 
            previousError: `Visual UI issues detected:\n${feedback}`, 
            fixTaskId: taskId,
            reflectionCount: reflectionCount + 1
          } 
        });
        return;
      }
    } else {
      // No UI detected, pass it implicitly
      log(`[VISUAL_QA] No UI detected, auto-passing ${taskId}`);
      tasks.markPass(taskId);
    }
  }

  if (allPassed) {
    stream.emit("System", "system", { action: "PhaseChange", phase: "COMMIT" });
  }
}
