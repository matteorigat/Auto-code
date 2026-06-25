import { formatNumber } from '../utils/format.mjs';

export function mountSessions(container, state) {
  const render = () => {
    if (state.activeTab !== 'overview') return;
    const sessions = state.sessions || [];

    let feedHTML = '';
    sessions.forEach((sess) => {
      feedHTML += `
          <div class="bg-zinc-800/30 border border-zinc-700/50 rounded-lg p-3 flex justify-between items-center">
              <div>
                  <div class="text-sm font-semibold text-zinc-200">${sess.agent || 'Agent'}</div>
                  <div class="text-xs text-zinc-500 mt-1">${(sess.model || '').split('/').pop()}</div>
              </div>
              <div class="text-right">
                  <div class="text-xs text-purple-400 code-font">${formatNumber(sess.total_tokens || 0)} tk</div>
                  <div class="text-[10px] text-zinc-500 mt-1">${sess.ts.substring(5, 16)}</div>
              </div>
          </div>
      `;
    });

    container.innerHTML = `
      <div class="flex flex-col h-full">
          <h3 class="text-sm font-semibold text-zinc-200 mb-4 flex justify-between items-center">
              Recent Sessions
              <span class="text-xs font-normal text-zinc-500 bg-zinc-800 px-2 py-1 rounded">Latest 50</span>
          </h3>
          <div class="overflow-y-auto flex-1 pr-2 custom-scrollbar">
              <div class="space-y-3">
                  ${feedHTML}
              </div>
          </div>
      </div>
    `;
  };

  state.subscribe(render);
  render();
}
