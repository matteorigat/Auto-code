import { escapeHtml } from '../utils/sanitize.mjs';

export function mountCalls(container, state) {
  let selectedCall = null;
  let selectedRowIndex = -1;

  container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[480px]">
      <div class="flex flex-col h-full border-r border-white/5 pr-4">
        <h3 class="text-sm font-semibold text-zinc-200 mb-3 flex justify-between items-center select-none">
            Recent API Explorer
            <span class="text-[10px] font-normal text-zinc-400 bg-zinc-800 border border-white/5 px-2 py-0.5 rounded">Latest 200</span>
        </h3>
        <div class="overflow-y-auto flex-1 custom-scrollbar pr-2 min-h-0">
            <table class="w-full text-left text-xs text-zinc-400">
                <thead class="text-[10px] uppercase bg-zinc-800/40 text-zinc-300 sticky top-0 backdrop-blur-md">
                    <tr>
                        <th class="px-3 py-2 rounded-l">Time</th>
                        <th class="px-3 py-2">Model</th>
                        <th class="px-3 py-2">Tokens</th>
                        <th class="px-3 py-2 rounded-r">Status</th>
                    </tr>
                </thead>
                <tbody id="calls-table-rows" class="divide-y divide-zinc-800/50">
                    <tr>
                        <td colspan="4" class="px-3 py-6 text-center text-zinc-500">No API calls recorded</td>
                    </tr>
                </tbody>
            </table>
        </div>
      </div>

      <div class="flex flex-col h-full pl-2 overflow-y-auto custom-scrollbar" id="call-detail-pane">
        <div class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs py-12 select-none border border-dashed border-white/5 rounded-xl">
          <div class="text-3xl mb-2">🔍</div>
          <span>Select an API call to inspect request details</span>
        </div>
      </div>
    </div>
  `;

  const tbody = container.querySelector('#calls-table-rows');
  const detailPane = container.querySelector('#call-detail-pane');

  const highlightRow = (newIndex) => {
    const rows = tbody.querySelectorAll('tr');
    if (selectedRowIndex >= 0 && rows[selectedRowIndex]) {
      rows[selectedRowIndex].classList.remove('bg-primary/10', 'border-l-2', 'border-primary');
    }
    if (newIndex >= 0 && rows[newIndex]) {
      rows[newIndex].classList.add('bg-primary/10', 'border-l-2', 'border-primary');
    }
    selectedRowIndex = newIndex;
  };

  const update = () => {
    if (state.activeTab !== 'explorer') return;
    const calls = state.calls || [];

    if (calls.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="px-3 py-6 text-center text-zinc-500 select-none">No API calls recorded</td>
        </tr>
      `;
      selectedRowIndex = -1;
      return;
    }

    tbody.innerHTML = calls
      .map((call, idx) => {
        const isErr = call.status !== 'ok';
        const statusBadge = isErr
          ? `<span class="bg-danger/10 text-danger border border-danger/15 px-1.5 py-0.5 rounded text-[9px] font-bold">ERR</span>`
          : `<span class="bg-success/10 text-success border border-success/15 px-1.5 py-0.5 rounded text-[9px] font-bold">OK</span>`;
        const modelShort = (call.model || '').split('/').pop();
        const timeStr = call.ts
          ? new Date(call.ts).toLocaleTimeString([], {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          : '--';
        const isSelected = idx === selectedRowIndex;

        return `
          <tr data-index="${idx}" class="hover:bg-white/[0.03] transition cursor-pointer select-none ${isSelected ? 'bg-primary/10 border-l-2 border-primary' : ''}">
              <td class="px-3 py-2.5 code-font text-zinc-500">${timeStr}</td>
              <td class="px-3 py-2.5 truncate max-w-[150px] font-medium text-zinc-300" title="${escapeHtml(call.model)}">${escapeHtml(modelShort)}</td>
              <td class="px-3 py-2.5 code-font text-accentBlue">${new Intl.NumberFormat().format(call.total_tokens)}</td>
              <td class="px-3 py-2.5">${statusBadge}</td>
          </tr>
      `;
      })
      .join('');

    tbody.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.dataset.index);
        selectedCall = state.calls[index];
        highlightRow(index);
        renderDetail();
      });
    });
  };

  const renderDetail = () => {
    if (!selectedCall) return;
    const call = selectedCall;

    const formattedTime = call.ts ? new Date(call.ts).toLocaleString() : '--';
    const promptText =
      call.prompt ||
      call.data?.parts?.map((p) => p.text || '').join('\n') ||
      call.data?.prompt ||
      'No prompt content payload persisted';

    const usage = call.data?.promptCache?.lastCallUsage || {};
    const input = usage.input || call.input_tokens || 0;
    const output = usage.output || call.output_tokens || 0;
    const cost = usage.cost?.total || 0;

    let responseHTML = '';
    if (call.status === 'ok') {
      const respText = call.response || call.data?.response || 'Successful API call completion';
      responseHTML = `<div class="bg-zinc-950/60 p-3 rounded-lg border border-white/5 max-h-56 overflow-y-auto custom-scrollbar code-font text-[10px] text-zinc-400 select-all whitespace-pre-wrap">${escapeHtml(respText)}</div>`;
    } else {
      const err = call.data?.promptError || call.data?.terminalError || 'Unknown API Exception';
      responseHTML = `
        <div class="p-3 bg-danger/5 border border-danger/10 rounded-lg text-danger text-xs code-font select-all overflow-x-auto max-h-48 custom-scrollbar">
          ${escapeHtml(err)}
        </div>
      `;
    }

    detailPane.innerHTML = `
      <div class="space-y-4 pr-2">
        <div class="flex items-center justify-between border-b border-white/5 pb-3">
          <h3 class="text-sm font-semibold text-white">Call Details</h3>
          <span class="text-[10px] text-zinc-500 font-mono">${formattedTime}</span>
        </div>

        <div class="grid grid-cols-2 gap-3 text-xs bg-white/[0.01] border border-white/5 rounded-lg p-3">
          <div class="flex flex-col col-span-2">
            <span class="text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Model Identifier</span>
            <span class="text-primary font-mono select-all truncate">${escapeHtml(call.model)}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Prompt / Response Tokens</span>
            <span class="text-zinc-300 font-medium font-mono">${formatNumber(input)} / ${formatNumber(output)}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Cost (USD)</span>
            <span class="text-success font-medium font-mono">$${cost.toFixed(6)}</span>
          </div>
        </div>

        <div>
          <h4 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Request Prompt Context</h4>
          <div class="bg-zinc-950/60 p-3 rounded-lg border border-white/5 max-h-56 overflow-y-auto custom-scrollbar code-font text-[10px] text-zinc-400 select-all whitespace-pre-wrap">${escapeHtml(promptText)}</div>
        </div>

        <div>
          <h4 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Response Status</h4>
          ${responseHTML}
        </div>
      </div>
    `;
  };

  const formatNumber = (num) => new Intl.NumberFormat().format(num);

  state.subscribe(update);
  update();
}
