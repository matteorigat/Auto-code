import { escapeHtml } from '../utils/sanitize.js';
function fmtTime(ts) {
    if (!ts)
        return '--';
    return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDate(ts) {
    if (!ts)
        return '--';
    return new Date(ts).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function mountHITL(container, state, api) {
    const _history = [];
    function renderEmpty() {
        container.innerHTML = `
      <div class="flex flex-col items-center justify-center min-h-[320px] text-center py-8 transition-all duration-500 select-none">
        <div class="relative mb-5">
          <span class="text-5xl block">🟢</span>
          <span class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-success animate-ping opacity-40"></span>
        </div>
        <h4 class="text-xl font-bold text-white">System Clear</h4>
        <p class="text-sm text-zinc-500 mt-2 max-w-md leading-relaxed">The Loop Orchestrator is running autonomously. No manual authorizations or reviews are currently requested.</p>
        ${_history.length > 0 ? `
        <div class="mt-8 w-full max-w-sm">
          <div class="text-[9px] text-zinc-600 font-bold uppercase tracking-wider mb-2 text-left">Recent Resolutions</div>
          <div class="space-y-1.5">
            ${_history.slice(-5).reverse().map(h => {
            const isApprove = h.action.startsWith('approve');
            const ico = isApprove ? '✅' : h.action.startsWith('reject') ? '❌' : '⏹️';
            const col = isApprove ? 'text-success' : h.action.startsWith('reject') ? 'text-danger' : 'text-zinc-400';
            return `<div class="flex items-center gap-2 text-[11px] bg-white/[0.01] border border-white/5 rounded-lg px-3 py-2">
                <span>${ico}</span>
                <span class="${col} font-semibold capitalize truncate">${escapeHtml(h.action.split(':')[0])}</span>
                <span class="text-zinc-600 truncate">${escapeHtml(h.gateType)}</span>
                <span class="text-zinc-700 font-mono ml-auto shrink-0">${fmtTime(h.ts)}</span>
              </div>`;
        }).join('')}
          </div>
        </div>` : ''}
      </div>
    `;
    }
    function renderWaitHumanBanner(loop) {
        const reason = loop.humanGateReason || 'Loop execution paused by system/user.';
        container.innerHTML = `
      <div class="flex flex-col items-center justify-center min-h-[320px] text-center py-8 transition-all duration-500 select-none">
        <div class="relative mb-5 animate-bounce">
          <span class="text-5xl block">⏳</span>
        </div>
        <h4 class="text-xl font-bold text-warning">Loop Suspended / Awaiting Review</h4>
        <p class="text-sm text-zinc-400 mt-2 max-w-md leading-relaxed">
          The Orchestrator loop is currently in <strong>WAIT_HUMAN</strong> phase.
        </p>
        <div class="mt-4 bg-zinc-900/60 border border-warning/20 rounded-xl p-4 max-w-md text-left text-xs font-mono text-zinc-300">
          <span class="text-warning font-bold uppercase text-[9px] block mb-1">Reason:</span>
          "${escapeHtml(reason)}"
        </div>
        
        <button id="hitl-resume-btn" class="mt-6 flex items-center justify-center gap-1.5 py-3 px-6 rounded-xl text-xs font-bold bg-success hover:bg-success/80 active:scale-[0.97] transition-all text-white border border-success/20 shadow-[0_0_12px_rgba(16,185,129,0.2)] outline-none">
          <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Resume Loop Execution
        </button>
      </div>
    `;
        const resumeBtn = container.querySelector('#hitl-resume-btn');
        if (resumeBtn) {
            resumeBtn.addEventListener('click', () => {
                const origHTML = resumeBtn.innerHTML;
                resumeBtn.innerHTML = '<div class="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin mx-auto"></div>';
                resumeBtn.disabled = true;
                api.post('/bridge-cmd', { cmd: 'resume' }).then(() => {
                    resumeBtn.innerHTML = '<span class="text-white text-xs font-bold">✓ Resumed</span>';
                }).catch(() => {
                    resumeBtn.innerHTML = '<span class="text-danger text-xs font-bold">✗ Failed</span>';
                }).finally(() => {
                    setTimeout(() => {
                        resumeBtn.innerHTML = origHTML;
                        resumeBtn.disabled = false;
                    }, 1200);
                });
            });
        }
    }
    function renderGate(hitl) {
        if (!hitl || !hitl.active) {
            renderEmpty();
            return;
        }
        const details = hitl.details || {};
        const question = details.question || details.message || details.prompt || 'Agent requires feedback or permission to proceed.';
        const detailKeys = Object.keys(details).filter(k => !['question', 'message', 'prompt', 'gateType'].includes(k));
        container.innerHTML = `
      <div class="flex flex-col min-h-[320px] transition-all duration-500">
        <div class="hitl-alert-panel rounded-xl p-5 space-y-4 border border-warning/20">
          <!-- Header -->
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full bg-warning hitl-badge-glow shrink-0"></span>
              <span class="text-xs font-bold text-warning uppercase tracking-wider">Gate Active: ${escapeHtml(hitl.gateType)}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-[10px] font-mono bg-zinc-800/80 text-zinc-400 px-2 py-0.5 rounded border border-white/5">${escapeHtml(hitl.requestId)}</span>
              <span class="text-[10px] font-mono text-zinc-600 hidden sm:inline">${fmtDate(hitl.ts)}</span>
            </div>
          </div>

          <!-- Question -->
          <div class="bg-white/[0.02] border border-white/5 rounded-xl p-4">
            <div class="flex items-center gap-2 text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-2">
              <span>💬</span><span>Agent Request</span>
            </div>
            <blockquote class="border-l-2 border-warning/50 pl-4 text-sm text-zinc-200 font-medium leading-relaxed">"${escapeHtml(question)}"</blockquote>
          </div>

          ${detailKeys.length > 0 ? `
          <!-- Details -->
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
            <div class="flex items-center gap-2 text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-2.5">
              <span>📋</span><span>Payload Details</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              ${detailKeys.map(k => {
            const val = details[k];
            const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
            return `<div class="bg-zinc-900/40 border border-white/[0.02] rounded-lg px-3 py-2 min-w-0">
                  <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider block mb-0.5">${escapeHtml(k)}</span>
                  <span class="text-[11px] text-zinc-300 font-mono break-words select-all block">${escapeHtml(valStr)}</span>
                </div>`;
        }).join('')}
            </div>
          </div>` : ''}

          <!-- Quick actions -->
          <div class="flex flex-wrap gap-1.5">
            ${['Approve', 'Provide context', 'Continue', 'Explain reasoning', 'Skip'].map(label => `<button class="quick-chip text-[9px] font-bold px-2.5 py-1 rounded-full bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 hover:text-zinc-200 border border-zinc-700/30 transition outline-none">${label}</button>`).join('')}
          </div>

          <!-- Feedback + Actions -->
          <div class="space-y-3 pt-1">
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Resolution Feedback</span>
              <span id="hitl-charcount" class="text-[10px] text-zinc-600 font-mono">0</span>
            </div>
            <textarea id="hitl-feedback" rows="3" placeholder="Add instructions, approval notes, or feedback for the agent..." class="w-full bg-zinc-900/50 border border-zinc-700/60 focus:border-warning/50 text-xs rounded-lg p-3 outline-none text-zinc-200 placeholder-zinc-600 custom-scrollbar transition-colors"></textarea>

            <div class="flex flex-wrap gap-2 pt-1">
              <button id="hitl-btn-approve" class="flex-1 min-w-[100px] py-2.5 px-4 rounded-xl bg-success/15 hover:bg-success/25 text-success border border-success/25 font-bold transition-all duration-200 outline-none text-xs active:scale-[0.97]">
                <span class="flex items-center justify-center gap-1.5">✅ Approve</span>
              </button>
              <button id="hitl-btn-reject" class="flex-1 min-w-[100px] py-2.5 px-4 rounded-xl bg-danger/15 hover:bg-danger/25 text-danger border border-danger/25 font-bold transition-all duration-200 outline-none text-xs active:scale-[0.97]">
                <span class="flex items-center justify-center gap-1.5">❌ Reject</span>
              </button>
              <button id="hitl-btn-abort" class="py-2.5 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border border-zinc-700/30 font-bold transition-all duration-200 outline-none text-xs active:scale-[0.97]">
                <span class="flex items-center justify-center gap-1.5">⏹ Abort Run</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
        const feedback = container.querySelector('#hitl-feedback');
        const charCount = container.querySelector('#hitl-charcount');
        const approveBtn = container.querySelector('#hitl-btn-approve');
        const rejectBtn = container.querySelector('#hitl-btn-reject');
        const abortBtn = container.querySelector('#hitl-btn-abort');
        feedback.addEventListener('input', () => {
            charCount.textContent = feedback.value.length;
        });
        let abortConfirm = false;
        function resetAbort() { abortConfirm = false; updateAbortBtn(); }
        function updateAbortBtn() {
            if (abortConfirm) {
                abortBtn.innerHTML = '<span class="flex items-center justify-center gap-1.5">⚠ Confirm Abort?</span>';
                abortBtn.className = 'py-2.5 px-4 rounded-xl bg-danger/20 text-danger border border-danger/40 font-bold transition-all duration-200 outline-none text-xs active:scale-[0.97]';
                setTimeout(resetAbort, 4000);
            }
            else {
                abortBtn.innerHTML = '<span class="flex items-center justify-center gap-1.5">⏹ Abort Run</span>';
                abortBtn.className = 'py-2.5 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border border-zinc-700/30 font-bold transition-all duration-200 outline-none text-xs active:scale-[0.97]';
            }
        }
        function disableAll() {
            [approveBtn, rejectBtn, abortBtn].forEach(b => b.disabled = true);
        }
        async function resolveGate(action, btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<div class="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin mx-auto"></div>';
            btn.disabled = true;
            try {
                await api.post('/hitl-resolve', { action, responseText: feedback.value.trim() });
                btn.innerHTML = '<span class="text-success font-bold">✓ Resolved</span>';
                disableAll();
                _history.push({ action, gateType: hitl.gateType, requestId: hitl.requestId, ts: Date.now() });
            }
            catch {
                btn.innerHTML = '<span class="text-danger font-bold">✗ Failed</span>';
                setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
            }
        }
        approveBtn.addEventListener('click', () => resolveGate(`approve:${hitl.gateType}:${hitl.requestId}`, approveBtn));
        rejectBtn.addEventListener('click', () => resolveGate(`reject:${hitl.gateType}:${hitl.requestId}`, rejectBtn));
        abortBtn.addEventListener('click', () => {
            if (abortConfirm) {
                resolveGate(`abort:${hitl.requestId}`, abortBtn);
            }
            else {
                abortConfirm = true;
                updateAbortBtn();
            }
        });
        container.querySelectorAll('.quick-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                feedback.value += (feedback.value ? ' ' : '') + chip.textContent.trim();
                charCount.textContent = feedback.value.length;
                feedback.focus();
            });
        });
    }
    const render = () => {
        if (state.activeTab !== 'hitl')
            return;
        const hitl = state.hitl;
        const loop = state.bridgeState?.loop || {};
        const isWaitHumanPhase = loop.phase === 'WAIT_HUMAN';
        if (hitl && hitl.active) {
            renderGate(hitl);
        }
        else if (isWaitHumanPhase) {
            renderWaitHumanBanner(loop);
        }
        else {
            renderEmpty();
        }
    };
    state.subscribe(render);
    render();
}
