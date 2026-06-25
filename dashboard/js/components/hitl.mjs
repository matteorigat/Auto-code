import { escapeHtml } from '../utils/sanitize.mjs';

export function mountHITL(container, state, api) {
  const render = () => {
    if (state.activeTab !== 'hitl') return;
    const hitl = state.hitl;

    if (!hitl || !hitl.active) {
      container.innerHTML = `
        <h3 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Interactive Human Gate Portal</h3>
        <div id="hitl-status-area" class="text-center text-zinc-500 py-16 transition-all duration-300">
            <div class="text-4xl mb-4">🟢</div>
            <h4 class="text-lg font-medium text-white">System Clear</h4>
            <p class="text-sm text-zinc-400 mt-2 max-w-md mx-auto">The Loop Orchestrator is running autonomously. No manual authorizations or reviews are currently requested.</p>
        </div>
      `;
      return;
    }

    const detailsStr =
      typeof hitl.details === 'object'
        ? JSON.stringify(hitl.details, null, 2)
        : String(hitl.details);

    const questionText =
      hitl.details?.question ||
      hitl.details?.message ||
      hitl.details?.prompt ||
      'Agent requires feedback or permission to run action.';

    let detailsHTML = '';
    if (hitl.details && typeof hitl.details === 'object') {
      const keys = Object.keys(hitl.details).filter(
        (k) => k !== 'question' && k !== 'message' && k !== 'prompt',
      );
      if (keys.length > 0) {
        detailsHTML = `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-white/[0.01] border border-white/5 rounded-lg p-4 font-mono">
            ${keys
              .map((k) => {
                const val = hitl.details[k];
                const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return `
                <div class="flex flex-col min-w-0">
                  <span class="text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">${escapeHtml(k)}</span>
                  <span class="text-zinc-300 break-words select-all">${escapeHtml(valStr)}</span>
                </div>
              `;
              })
              .join('')}
          </div>
        `;
      }
    }

    if (!detailsHTML && hitl.details) {
      detailsHTML = `
        <pre class="bg-zinc-950 p-3 rounded-lg border border-white/5 text-[10px] text-zinc-400 max-h-48 overflow-y-auto custom-scrollbar code-font">${escapeHtml(detailsStr)}</pre>
      `;
    }

    container.innerHTML = `
      <h3 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Interactive Human Gate Portal</h3>
      <div class="hitl-alert-panel p-6 rounded-xl border border-warning/20 space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-warning">
            <span class="w-2.5 h-2.5 rounded-full bg-warning hit-badge-glow pulse-dot"></span>
            <span class="text-sm font-bold uppercase tracking-wider">GATE ACTIVE: ${escapeHtml(hitl.gateType)}</span>
          </div>
          <span class="text-[10px] font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded border border-white/5">Req ID: ${escapeHtml(hitl.requestId)}</span>
        </div>

        <div>
          <h4 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Agent Question / Request</h4>
          <blockquote class="border-l-2 border-warning pl-4 text-sm text-zinc-200 font-medium italic my-2">
            "${escapeHtml(questionText)}"
          </blockquote>
        </div>

        ${
          detailsHTML
            ? `
        <div>
          <h4 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 font-mono">Payload Details</h4>
          ${detailsHTML}
        </div>
        `
            : ''
        }

        <div class="space-y-3 pt-2">
          <h4 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Resolution Feedback</h4>
          <textarea id="hitl-feedback" rows="3" placeholder="Provide answer, commands or guidance for the agent..." class="w-full bg-zinc-900/50 border border-zinc-700/60 focus:border-warning text-xs rounded-lg p-3 outline-none text-zinc-200 placeholder-zinc-500 custom-scrollbar"></textarea>
          
          <div class="flex flex-wrap gap-2 pt-1">
            <button id="hitl-btn-approve" class="flex-1 py-2 px-4 rounded-lg bg-success/20 hover:bg-success/35 text-success border border-success/30 font-semibold transition outline-none text-xs">
              Approve / Allow
            </button>
            <button id="hitl-btn-reject" class="flex-1 py-2 px-4 rounded-lg bg-danger/20 hover:bg-danger/35 text-danger border border-danger/30 font-semibold transition outline-none text-xs">
              Reject / Deny
            </button>
            <button id="hitl-btn-abort" class="py-2 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-300 border border-white/5 font-semibold transition outline-none text-xs">
              Abort Run
            </button>
          </div>
        </div>
      </div>
    `;

    const feedbackInput = container.querySelector('#hitl-feedback');
    const approveBtn = container.querySelector('#hitl-btn-approve');
    const rejectBtn = container.querySelector('#hitl-btn-reject');
    const abortBtn = container.querySelector('#hitl-btn-abort');

    const resolveGate = async (action, btn) => {
      const originalText = btn.innerHTML;
      btn.innerHTML =
        '<div class="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-white animate-spin mx-auto"></div>';
      btn.disabled = true;

      const responseText = feedbackInput.value.trim();

      try {
        await api.post('/hitl-resolve', { action, responseText });
        btn.innerHTML = '<span class="text-success">✓ Sent</span>';
      } catch (e) {
        btn.innerHTML = '<span class="text-danger">✗ Failed</span>';
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.disabled = false;
        }, 1500);
      }
    };

    approveBtn.addEventListener('click', (e) =>
      resolveGate(`approve:${hitl.gateType}:${hitl.requestId}`, e.currentTarget),
    );
    rejectBtn.addEventListener('click', (e) =>
      resolveGate(`reject:${hitl.gateType}:${hitl.requestId}`, e.currentTarget),
    );
    abortBtn.addEventListener('click', (e) =>
      resolveGate(`abort:${hitl.requestId}`, e.currentTarget),
    );
  };

  state.subscribe(render);
  render();
}
