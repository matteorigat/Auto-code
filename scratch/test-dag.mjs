import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function runTest() {
  console.log("=== Testing DAG Parallel Execution via IPC ===");
  
  const workerPath = join(__dirname, "../agents/workers/builder-worker.mjs");
  
  // Dummy task
  const task = {
    id: "US-test-dag",
    title: "Test DAG Parallelism",
    workspacePath: process.cwd(),
    description: "Implement a test file"
  };

  const worker = fork(workerPath, [], { stdio: "inherit" });

  let eventsReceived = 0;

  worker.on("message", (msg) => {
    if (msg.type === "EVENT") {
      eventsReceived++;
      console.log(`[IPC Event] ${msg.event.actor} emitted ${msg.event.source}`);
    } else if (msg.type === "STATUS") {
      console.log(`[IPC Status] Phase changed to ${msg.phase}`);
    } else if (msg.type === "DONE") {
      console.log(`[IPC Done] Worker finished with success=${msg.result.ok}`);
      console.log(`Total events correctly relayed via IPC: ${eventsReceived}`);
      worker.kill();
    }
  });

  worker.on("error", (e) => console.error("Worker error:", e));
  worker.on("exit", (code) => console.log(`Worker exited with code ${code}`));

  worker.send({
    type: "START",
    projectPath: process.cwd(),
    task,
    safetyOptions: { allowedDirs: [process.cwd()], maxCycleMs: 10000 }
  });
}

runTest();
