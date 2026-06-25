export function mountCommands(container, state, api) {
  container.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
      <!-- Left: Loop Controls -->
      <div>
        <h3 class="font-bold text-sm text-zinc-300 uppercase tracking-wider mb-4">Orchestrator Loop Commands</h3>
        <div class="flex flex-col gap-3">
          <div class="flex gap-3">
            <button id="cmd-pause" class="flex-1 py-2 px-4 rounded-lg bg-warning/10 text-warning hover:bg-warning/20 border border-warning/20 transition flex items-center justify-center font-medium outline-none text-xs">
              Pause Loop
            </button>
            <button id="cmd-resume" class="flex-1 py-2 px-4 rounded-lg bg-success/10 text-success hover:bg-success/20 border border-success/20 transition flex items-center justify-center font-medium outline-none text-xs">
              Resume Loop
            </button>
          </div>
          <button id="cmd-kill" class="py-2 px-4 rounded-lg bg-danger/10 text-danger hover:bg-danger/25 border border-danger/20 transition flex items-center justify-center font-medium outline-none text-xs">
            Stop Loop Orchestrator
          </button>
          
          <div class="mt-2 pt-2 border-t border-white/5 flex gap-2">
            <input id="run-project-key" type="text" placeholder="Project slug (e.g. app-di-libri-usati)" class="flex-1 bg-zinc-800 border border-zinc-700 text-xs rounded px-3 py-2 outline-none focus:border-primary text-zinc-200 placeholder-zinc-500" />
            <button id="cmd-start" class="py-2 px-4 rounded-lg bg-primary hover:bg-primary/80 transition text-xs font-semibold text-white outline-none">
              Start Loop
            </button>
          </div>
        </div>
      </div>

      <!-- Right: Subprocesses Control Grid -->
      <div>
        <h3 class="font-bold text-sm text-zinc-300 uppercase tracking-wider mb-4">Core Process Managers</h3>
        <div class="space-y-3" id="process-list-container">
          <!-- Process rows dynamically loaded -->
        </div>
      </div>
    </div>
  `;

  const processContainer = container.querySelector('#process-list-container');
  const runProjectKey = container.querySelector('#run-project-key');

  const executeCommand = async (cmd, btn, extra = {}) => {
    const originalText = btn.innerHTML;
    btn.innerHTML =
      '<div class="w-4 h-4 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin mx-auto"></div>';
    btn.disabled = true;

    try {
      await api.post('/bridge-cmd', { cmd, ...extra });
      btn.innerHTML = '<span class="text-success font-bold text-xs">✓ Done</span>';
    } catch (e) {
      btn.innerHTML = '<span class="text-danger font-bold text-xs">✗ Fail</span>';
    }

    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }, 1500);
  };

  const executeProcessCommand = async (processName, action, btn) => {
    const originalText = btn.innerHTML;
    btn.innerHTML =
      '<div class="w-3 h-3 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin mx-auto"></div>';
    btn.disabled = true;

    try {
      await api.post('/process-cmd', { processName, action });
      btn.innerHTML = '<span class="text-success text-xs font-bold">✓</span>';
    } catch (e) {
      btn.innerHTML = '<span class="text-danger text-xs font-bold">✗</span>';
    }

    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }, 1500);
  };

  // Bind loop buttons
  container
    .querySelector('#cmd-pause')
    .addEventListener('click', (e) => executeCommand('pause', e.currentTarget));
  container
    .querySelector('#cmd-resume')
    .addEventListener('click', (e) => executeCommand('resume', e.currentTarget));
  container
    .querySelector('#cmd-kill')
    .addEventListener('click', (e) => executeCommand('kill', e.currentTarget));
  container.querySelector('#cmd-start').addEventListener('click', (e) => {
    const projectKey = runProjectKey.value.trim();
    executeCommand('start', e.currentTarget, { projectKey });
  });

  // Render process list
  const updateProcesses = () => {
    if (state.activeTab !== 'overview') return;
    const p = state.bridgeState;

    const processesData = [
      {
        id: 'litellm',
        name: 'LiteLLM Proxy',
        desc: 'Model routing (port 4000)',
        running: !!p.litellm?.running,
        pid: p.litellm?.pid,
      },
      {
        id: 'opencode',
        name: 'OpenCode Server',
        desc: 'IDE sandbox (port 4096)',
        running: !!p.opencode?.running,
        pid: p.opencode?.pid,
      },
      {
        id: 'loop',
        name: 'Orchestrator Loop',
        desc: 'Phase flow controller',
        running: !!p.loop?.running || (p.loop?.phase && p.loop.phase !== 'IDLE'),
        pid: p.loop?.pid,
      },
    ];

    processContainer.innerHTML = processesData
      .map((proc) => {
        const runningLabel = proc.running
          ? `<span class="flex items-center gap-1 text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded border border-success/20"><span class="w-1 h-1 rounded-full bg-success pulse-dot"></span>On${proc.pid ? ` (PID: ${proc.pid})` : ''}</span>`
          : `<span class="flex items-center gap-1 text-[9px] font-bold text-danger bg-danger/10 px-1.5 py-0.5 rounded border border-danger/20"><span class="w-1 h-1 rounded-full bg-danger"></span>Off</span>`;

        return `
        <div class="flex items-center justify-between p-2.5 bg-white/[0.02] border border-white/5 rounded-lg hover:border-white/10 transition">
          <div class="min-w-0 flex-1 pr-3">
            <div class="flex items-center gap-2">
              <h4 class="text-xs font-semibold text-white">${proc.name}</h4>
              ${runningLabel}
            </div>
            <p class="text-[10px] text-zinc-500 mt-0.5 truncate">${proc.desc}</p>
          </div>
          <div class="flex gap-1">
            ${
              proc.running
                ? `<button data-proc="${proc.id}" data-action="stop" class="proc-btn px-2 py-1 text-[10px] font-semibold rounded bg-danger/10 hover:bg-danger/20 text-danger border border-danger/15 transition outline-none">Stop</button>
                 <button data-proc="${proc.id}" data-action="restart" class="proc-btn px-2 py-1 text-[10px] font-semibold rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/5 transition outline-none">Restart</button>`
                : `<button data-proc="${proc.id}" data-action="start" class="proc-btn px-2 py-1 text-[10px] font-semibold rounded bg-success/10 hover:bg-success/20 text-success border border-success/15 transition outline-none">Start</button>`
            }
          </div>
        </div>
      `;
      })
      .join('');

    // Bind process button clicks
    processContainer.querySelectorAll('.proc-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const procId = e.currentTarget.dataset.proc;
        const action = e.currentTarget.dataset.action;
        executeProcessCommand(procId, action, e.currentTarget);
      });
    });
  };

  state.subscribe(updateProcesses);
  updateProcesses();
}
