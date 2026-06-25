export function mountStats(container, state) {
  // Initialize the structure of the 4 cards once
  container.innerHTML = `
    <div class="glass-panel p-6 relative overflow-hidden">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-blue-500/10 rounded-full blur-2xl"></div>
        <h3 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Total Tokens Burned</h3>
        <div id="stat-tokens" class="text-3xl font-bold code-font">--</div>
        <p id="stat-tokens-sub" class="text-xs text-zinc-500 mt-2">All time cumulative</p>
    </div>
    <div class="glass-panel p-6 relative overflow-hidden">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-purple-500/10 rounded-full blur-2xl"></div>
        <h3 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Model API Calls</h3>
        <div id="stat-calls" class="text-3xl font-bold code-font">--</div>
        <p id="stat-errors" class="text-xs text-zinc-500 mt-2">-- errors</p>
    </div>
    <div class="glass-panel p-6 relative overflow-hidden">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-green-500/10 rounded-full blur-2xl"></div>
        <h3 id="stat-cost-title" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Est. Cost Today</h3>
        <div id="stat-cost" class="text-3xl font-bold code-font text-green-400">$0.0000</div>
        <p id="stat-cost-sub" class="text-xs text-zinc-500 mt-2">Based on active run spend</p>
    </div>
    <div class="glass-panel p-6 relative overflow-hidden">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-orange-500/10 rounded-full blur-2xl"></div>
        <h3 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Success Rate</h3>
        <div id="stat-success-rate" class="text-3xl font-bold code-font text-purple-400">0.0%</div>
        <p id="stat-completed-ratio" class="text-xs text-zinc-500 mt-2">0/0 loop tasks done</p>
    </div>
  `;

  const tokensEl = container.querySelector('#stat-tokens');
  const callsEl = container.querySelector('#stat-calls');
  const errorsEl = container.querySelector('#stat-errors');
  const costEl = container.querySelector('#stat-cost');
  const successEl = container.querySelector('#stat-success-rate');
  const ratioEl = container.querySelector('#stat-completed-ratio');

  const update = () => {
    if (state.activeTab !== 'overview') return;
    const summary = state.summary || {};
    const tokens = summary.totalInput + summary.totalOutput || state.bridgeState.loop?.tokens || 0;
    const calls = summary.totalCalls || 0;
    const errors = summary.totalErrors || 0;

    // Choose cost source based on range
    const isToday = state.timeRange === '1d';
    const cost = isToday
      ? state.bridgeState.loop?.cost || summary.totalCost || 0
      : summary.totalCost || 0;

    const completed = state.bridgeState.loop?.tasksCompleted || 0;
    const total = state.bridgeState.loop?.tasksTotal || 0;
    const rate = total > 0 ? ((completed / total) * 100).toFixed(1) : '100.0';

    // Map range to subtitle
    const rangeLabels = {
      '1m': 'Last minute',
      '10m': 'Last 10 minutes',
      '1h': 'Last hour',
      '1d': 'Today (UTC)',
      '24h': 'Last 24 hours',
      '1w': 'Last week',
      '1mo': 'Last month',
    };
    const rangeLabel = rangeLabels[state.timeRange] || 'Selected timeframe';

    tokensEl.textContent = new Intl.NumberFormat().format(tokens);
    container.querySelector('#stat-tokens-sub').textContent = `In ${rangeLabel.toLowerCase()}`;

    callsEl.textContent = new Intl.NumberFormat().format(calls);
    errorsEl.textContent = `${errors} errors (${rangeLabel.toLowerCase()})`;

    // Update cost title and subtitle
    container.querySelector('#stat-cost-title').textContent = isToday
      ? 'Est. Cost Today'
      : 'Estimated Cost';
    costEl.textContent = `$${Number(cost).toFixed(4)}`;
    container.querySelector('#stat-cost-sub').textContent = isToday
      ? 'Based on active run spend'
      : `Accumulated ${rangeLabel.toLowerCase()}`;

    successEl.textContent = `${rate}%`;
    ratioEl.textContent = `${completed}/${total} loop tasks completed`;
  };

  state.subscribe(update);
  update();
}
