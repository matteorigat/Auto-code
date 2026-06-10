import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), 'projects', 'opencode-bridge-telegram', 'agents', 'hydra-loop.v2.mjs');
let code = fs.readFileSync(file, 'utf8');

// Replace checkpoint variable usages
code = code.replace(/checkpoint\.phase/g, 'checkpoint.globalPhase');
code = code.replace(/checkpoint\.currentTaskId/g, 'null');

// Replace while loop with global IDLE function and dispatcher
const oldMainLoop = `
  let phase = checkpoint.globalPhase || "IDLE";

  while (true) {
    if (safety.isCircuitOpen()) {
      await sendAlert("critical", "Circuit breaker OPEN \u2014 pausing 5 minutes");
      await sleep(5 * 60 * 1000);
      continue;
    }

    try {
      const cmdPath = join(projectPath, ".hydra", "bridge-cmd.json");
      if (existsSync(cmdPath)) {
        const cmdData = JSON.parse(readFileSync(cmdPath, "utf-8"));
        unlinkSync(cmdPath);
        if (cmdData.cmd === "pause") {
          sendAlert("warn", "Loop paused by dashboard command");
          phase = "WAIT_HUMAN";
          state.transition("WAIT_HUMAN", { reason: "Paused by dashboard" });
        } else if (cmdData.cmd === "resume" && phase === "WAIT_HUMAN") {
          sendAlert("info", "Loop resumed by dashboard command");
          phase = "IDLE";
          state.transition("IDLE");
        }
      }
    } catch (e) {
      log(\`Error processing bridge command: \${e.message}\`);
    }

    switch (phase) {
      case "IDLE": phase = await phaseIDLE(); break;
      case "PLAN": phase = await phasePLAN(); break;
      case "EXEC": phase = await phaseEXEC(); break;
      case "QA": phase = await phaseQA(); break;
      case "COMMIT": phase = await phaseCOMMIT(); break;
      case "REFLECT": phase = await phaseREFLECT(); break;
      case "SYNC": phase = await phaseSYNC(); break;
      case "FIX": phase = await phaseFIX(); break;
      case "DISCOVER": phase = await phaseDISCOVER(); break;
      case "WAIT_HUMAN": phase = await phaseWAIT_HUMAN(); break;
      default: phase = "IDLE";
    }

    memory.appendEvent("heartbeat", { phase });
    try { writeFileSync(join(projectPath, ".hydra", "heartbeat"), JSON.stringify({ phase, ts: Date.now() })); } catch {}

    if (phase === "IDLE") await sleep(5000);
  }
`;

const newMainLoop = `
  let globalPhase = checkpoint.globalPhase || "IDLE";
  
  const activeExecutors = new Map();
  const MAX_CONCURRENT = 3;

  function updateAggregatedStatus() {
    const s = state.get();
    const activeTasks = Array.from(activeExecutors.entries()).map(([id, t]) => {
      const ts = s.activeTasks[id] || {};
      return { taskId: id, title: t.title, phase: ts.phase, project: ts.project };
    });
    
    const allTasks = tasks._tasks || [];
    const blocked = allTasks.filter(t => t.status === "blocked").length;
    const done = allTasks.filter(t => t.passes).length;
    const st = tasks.stats();

    updateStatus({ 
      phase: globalPhase, 
      cost: safety.getDailyCost(), 
      tasksCompleted: done, 
      tasksBlocked: blocked, 
      tasksTotal: st.total,
      activeTasks
    });
    
    try { writeFileSync(join(projectPath, ".hydra", "heartbeat"), JSON.stringify({ phase: globalPhase, ts: Date.now(), activeTasks: activeTasks.length })); } catch {}
  }

  setInterval(updateAggregatedStatus, 2000);

  // ─── Task State Machine ───
  async function runTaskStateMachine(task) {
    const taskId = String(task.id);
    let taskPhase = state.getTaskState(taskId)?.phase || "PLAN";
    state.transition(taskId, taskPhase, { project: task._projectSlug || basename(task.workspacePath || "") });
    
    while (taskPhase !== "IDLE" && taskPhase !== "SYNC") {
      updateAggregatedStatus();
      if (safety.isCircuitOpen()) { await sleep(30000); continue; }
      
      switch (taskPhase) {
        case "PLAN": taskPhase = await phasePLAN(task); break;
        case "EXEC": taskPhase = await phaseEXEC(task); break;
        case "QA": taskPhase = await phaseQA(task); break;
        case "COMMIT": taskPhase = await phaseCOMMIT(task); break;
        case "REFLECT": taskPhase = await phaseREFLECT(task); break;
        case "FIX": taskPhase = await phaseFIX(task); break;
        case "WAIT_HUMAN": taskPhase = await phaseWAIT_HUMAN(task); break;
        default: taskPhase = "IDLE";
      }
    }
    
    if (taskPhase === "SYNC") await phaseSYNC(task);
    activeExecutors.delete(taskId);
    updateAggregatedStatus();
  }

  // ─── Event Dispatcher ───
  while (true) {
    if (safety.isCircuitOpen()) {
      await sendAlert("critical", "Circuit breaker OPEN — pausing 5 minutes");
      await sleep(5 * 60 * 1000);
      continue;
    }

    try {
      const cmdPath = join(projectPath, ".hydra", "bridge-cmd.json");
      if (existsSync(cmdPath)) {
        const cmdData = JSON.parse(readFileSync(cmdPath, "utf-8"));
        unlinkSync(cmdPath);
        if (cmdData.cmd === "pause") {
          sendAlert("warn", "Loop paused by dashboard command");
          globalPhase = "WAIT_HUMAN";
          state.transition(null, "WAIT_HUMAN", { reason: "Paused by dashboard" });
        } else if (cmdData.cmd === "resume" && globalPhase === "WAIT_HUMAN") {
          sendAlert("info", "Loop resumed by dashboard command");
          globalPhase = "IDLE";
          state.transition(null, "IDLE");
        }
      }
    } catch (e) { log(\`Error processing bridge command: \${e.message}\`); }

    if (globalPhase === "WAIT_HUMAN") { await sleep(5000); continue; }

    globalPhase = await phaseIDLE();

    // Spawn new executors up to limit
    const allPending = tasks.getPendingTasks();
    for (const task of allPending) {
      if (activeExecutors.size >= MAX_CONCURRENT) break;
      const taskId = String(task.id);
      
      const slug = task._projectSlug || (task.workspacePath ? basename(task.workspacePath) : null);
      if (slug && _isProjectPaused(slug)) continue;
      
      if (!activeExecutors.has(taskId)) {
        log(\`DISPATCH — Spawning executor for \${taskId}\`);
        const promise = runTaskStateMachine(task).catch(e => {
          log(\`Executor crash \${taskId}: \${e.message}\`);
          activeExecutors.delete(taskId);
        });
        activeExecutors.set(taskId, { title: task.title, promise });
      }
    }

    await sleep(5000);
  }
`;

// Simple indexOf replacement (since it's massive)
const loopStart = code.indexOf('  let globalPhase = checkpoint.globalPhase || "IDLE";');
if (loopStart !== -1) {
    const loopEnd = code.lastIndexOf('}'); // End of main()
    const tail = code.slice(loopEnd);
    code = code.slice(0, loopStart) + newMainLoop + '\\n' + tail;
}

// Now replace phasePLAN() signatures
code = code.replace(/async function phasePLAN\(\)/, "async function phasePLAN(task)");
code = code.replace(/async function phaseEXEC\(\)/, "async function phaseEXEC(task)");
code = code.replace(/async function phaseQA\(\)/, "async function phaseQA(task)");
code = code.replace(/async function phaseCOMMIT\(\)/, "async function phaseCOMMIT(task)");
code = code.replace(/async function phaseREFLECT\(\)/, "async function phaseREFLECT(task)");
code = code.replace(/async function phaseFIX\(\)/, "async function phaseFIX(task)");
code = code.replace(/async function phaseWAIT_HUMAN\(\)/, "async function phaseWAIT_HUMAN(task)");
code = code.replace(/async function phaseSYNC\(\)/, "async function phaseSYNC(task)");

// Replace state transitions in phase handlers to use taskId
code = code.replace(/state\.transition\("([^"]+)"(?:,\s*([^)]+))?\)/g, (m, p1, p2) => {
    if (["IDLE", "DISCOVER", "WAIT_HUMAN"].includes(p1)) {
        return \`state.transition(null, "\${p1}"\${p2 ? ', ' + p2 : ''})\`;
    }
    return \`state.transition(String(task.id), "\${p1}"\${p2 ? ', ' + p2 : ''})\`;
});

// Update state getters
code = code.replace(/state\.get\(\)\.currentTaskId/g, 'String(task.id)');
code = code.replace(/state\.get\(\)\.currentStory/g, 'task.title');

// Fix phasePLAN logic
const planStart = code.indexOf('async function phasePLAN(task)');
const planEnd = code.indexOf('async function _initTaskProject(task)');
let planCode = code.slice(planStart, planEnd);

// In phasePLAN, we already have \`task\`, so we don't need to fetch it from tasks._tasks
const newPlanCode = \`async function phasePLAN(task) {
    state.transition(String(task.id), "PLAN", { currentStory: task.title, attempt: 0 });
    log(\`PLAN — next task: \${task.id} \${task.title}\`);

    if (tasks.needsSplitting(task)) {
      log(\`Story \${task.id} too large — splitting\`);
      const parts = tasks.splitStory(task);
      tasks._tasks = tasks._tasks.filter((t) => String(t.id) !== String(task.id));
      for (const p of parts) tasks.addStory(p);
      return "SYNC"; // Go to SYNC to persist splits, then it will get picked up again
    }

    await _initTaskProject(task);

    const planDir = task.workspacePath || projectPath;
    const hasSddArtifacts = ["PLAN.md", "PRODUCT-SPEC.md", "TECHNICAL-SPEC.md", "CONSTITUTION.md"]
      .some(f => existsSync(join(planDir, f)));

    if (hasSddArtifacts) {
      log(\`PLAN — running task-planner for \${task.id} \${task.title}\`);
      const taskPlanner = new AgentRuntime({ projectPath: planDir, agentType: "task-planner", task });
      await taskPlanner.run(300_000).catch(() => {});
    }

    return "EXEC";
  }

  \`;
code = code.slice(0, planStart) + newPlanCode + code.slice(planEnd);

// Fix phaseEXEC logic
const execStart = code.indexOf('async function phaseEXEC(task)');
const execEnd = code.indexOf('async function phaseQA(task)');
let execCode = code.slice(execStart, execEnd);

// Remove 'const taskId = ...' and 'const task = ...' lines
execCode = execCode.replace(/const taskId = String\\(task\\.id\\);\\n/, '');
execCode = execCode.replace(/const task = tasks\\._tasks\\.find.*\\n/, '');
execCode = execCode.replace(/if \\(!task\\) return "IDLE";\\n/, '');

const sgetAttemptRegex = /state\\.get\\(\\)\\.attempt/g;
execCode = execCode.replace(sgetAttemptRegex, '(state.getTaskState(String(task.id))?.attempt || 0)');

code = code.slice(0, execStart) + execCode + code.slice(execEnd);

// phaseQA logic
const qaStart = code.indexOf('async function phaseQA(task)');
const qaEnd = code.indexOf('async function phaseCOMMIT(task)');
let qaCode = code.slice(qaStart, qaEnd);
qaCode = qaCode.replace(/const taskId = String\\(task\\.id\\);\\n/, '');
qaCode = qaCode.replace(/const task = tasks\\._tasks\\.find.*\\n/, '');
code = code.slice(0, qaStart) + qaCode + code.slice(qaEnd);

// phaseCOMMIT logic
const commitStart = code.indexOf('async function phaseCOMMIT(task)');
const commitEnd = code.indexOf('async function phaseREFLECT(task)');
let commitCode = code.slice(commitStart, commitEnd);
commitCode = commitCode.replace(/const taskId = String\\(task\\.id\\);\\n/, '');
commitCode = commitCode.replace(/const task = tasks\\._tasks\\.find.*\\n/, '');
code = code.slice(0, commitStart) + commitCode + code.slice(commitEnd);

// phaseREFLECT logic
const reflectStart = code.indexOf('async function phaseREFLECT(task)');
const reflectEnd = code.indexOf('async function phaseSYNC(task)');
let reflectCode = code.slice(reflectStart, reflectEnd);
reflectCode = reflectCode.replace(/const taskId = String\\(task\\.id\\);\\n/, '');
reflectCode = reflectCode.replace(/const task = tasks\\._tasks\\.find.*\\n/, '');
code = code.slice(0, reflectStart) + reflectCode + code.slice(reflectEnd);

// phaseFIX
const fixStart = code.indexOf('async function phaseFIX(task)');
const fixEnd = code.indexOf('async function phaseDISCOVER()');
let fixCode = code.slice(fixStart, fixEnd);
fixCode = fixCode.replace(/const s = state\\.get\\(\\);/g, 'const s = state.getTaskState(String(task.id)) || {};');
fixCode = fixCode.replace(/const task = tasks\\._tasks\\.find.*\\n/g, '');
code = code.slice(0, fixStart) + fixCode + code.slice(fixEnd);

// phaseWAIT_HUMAN rewrite for task-specific
const waitStart = code.indexOf('async function phaseWAIT_HUMAN(task)');
const waitEnd = code.indexOf('// ─── Main loop ───');
let waitCode = \`async function phaseWAIT_HUMAN(task) {
    const taskId = String(task.id);
    const resumeSignalPath = join(projectPath, ".hydra", \`resume-signal-\${taskId}.json\`);
    
    // Auto-unpause if the signal file is manually created
    if (existsSync(resumeSignalPath)) {
      try { unlinkSync(resumeSignalPath); } catch {}
      return "EXEC";
    }

    return new Promise(resolve => {
        let resolved = false;
        const fallbackTimer = setInterval(() => {
          if (existsSync(resumeSignalPath)) {
            try { unlinkSync(resumeSignalPath); } catch {}
            if (!resolved) { resolved = true; clearInterval(fallbackTimer); resolve("EXEC"); }
          }
        }, 5000);
        setTimeout(() => {
          if (!resolved) { resolved = true; clearInterval(fallbackTimer); resolve("IDLE"); }
        }, 24 * 60 * 60 * 1000);
    });
  }

  \`;
if(waitEnd !== -1) code = code.slice(0, waitStart) + waitCode + code.slice(waitEnd);


fs.writeFileSync(file, code);
console.log("Refactor complete.");
