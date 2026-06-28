import { DashboardAPI } from './api.mjs';
import { DashboardWebSocket } from './ws.mjs';
import { AppState } from './state.mjs';
import { mountHeader } from './components/header.mjs';
import { mountLogs } from './components/logs.mjs';
import { mountCommands } from './components/commands.mjs';
import { mountStats } from './components/stats.mjs';
import { mountProviders, mountQuotaGauges } from './components/providers.mjs';
import { mountSessions } from './components/sessions.mjs';
import { mountCalls } from './components/calls.mjs';
import { mountRouting } from './components/routing.mjs';
import { mountCognitive } from './components/cognitive.mjs';
import { mountAuthOverlay } from './components/auth.mjs';
import { mountHITL } from './components/hitl.mjs';
import { mountTimeline } from './components/timeline.mjs';
import { mountModels } from './components/models/index.mjs';
import { BurnChart, ModelChart } from './charts.mjs';

const api = new DashboardAPI();
const state = new AppState();

const tabKeys = ['overview', 'logs', 'hitl', 'quotas', 'explorer', 'models'];
tabKeys.forEach((tab) => {
  const btn = document.getElementById(`tab-btn-${tab}`);
  const pane = document.getElementById(`tab-content-${tab}`);
  if (btn && pane) {
    btn.addEventListener('click', () => {
      tabKeys.forEach((t) => {
        document.getElementById(`tab-btn-${t}`)?.classList.remove('active', 'text-white');
        document.getElementById(`tab-btn-${t}`)?.classList.add('text-zinc-400');
        document.getElementById(`tab-content-${t}`)?.classList.remove('active');
      });
      btn.classList.add('active', 'text-white');
      btn.classList.remove('text-zinc-400');
      pane.classList.add('active');

      state.activeTab = tab;
      state.notify();
    });
  }
});

state.subscribe((s) => {
  const logsCount = document.getElementById('logs-count-badge');
  if (logsCount) logsCount.textContent = s.logs.length;

  const hitlDot = document.getElementById('hitl-alert-dot');
  if (hitlDot) {
    if (s.hitl && s.hitl.active) {
      hitlDot.classList.remove('hidden');
    } else {
      hitlDot.classList.add('hidden');
    }
  }

  if (s.activeTab === 'overview') {
    if (s.summary) modelChart.update(s.summary);
    if (s.dailyData) burnChart.update(s.dailyData);
  }
});

function rangeToParams(range) {
  const now = new Date();
  const label = range || '1d';
  if (label === '1d') {
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    return { from, to: now.toISOString() };
  }
  const seconds =
    { '1m': 60, '10m': 600, '1h': 3600, '24h': 86400, '1w': 604800, '1mo': 2592000 }[label] || 3600;
  const from = new Date(now.getTime() - seconds * 1000).toISOString();
  const to = now.toISOString();
  return { from, to };
}

let _fetchSnapshotPromise = null;

const header = mountHeader(
  document.getElementById('header-container'),
  state,
  api,
  () => {
    window.location.reload();
  },
  (range) => {
    fetchSnapshot();
  },
);

mountLogs(document.getElementById('logs-container'), state);
mountCommands(document.getElementById('commands-container'), state, api);
mountStats(document.getElementById('stats-container'), state);
mountProviders(document.getElementById('provider-table-container'), state);
mountQuotaGauges(document.getElementById('quota-gauges-container'), state);
mountSessions(document.getElementById('sessions-container'), state);
mountCalls(document.getElementById('calls-container'), state);
mountRouting(document.getElementById('routing-container'), state);
mountCognitive(document.getElementById('cognitive-container'), state);
mountHITL(document.getElementById('hitl-panel-container'), state, api);
mountTimeline(document.getElementById('loop-state-details'), state);
mountModels(document.getElementById('tab-content-models'), state, api);

const burnChartCanvas = document.createElement('canvas');
burnChartCanvas.classList.add('w-full', 'h-full');
const burnChartWrapper = document.getElementById('burn-chart-container');
burnChartWrapper.appendChild(burnChartCanvas);
const burnChart = new BurnChart(burnChartCanvas);

const modelChartCanvas = document.createElement('canvas');
modelChartCanvas.classList.add('w-full', 'h-full');
const modelChartWrapper = document.getElementById('model-chart-container');
modelChartWrapper.appendChild(modelChartCanvas);
const modelChart = new ModelChart(modelChartCanvas);

async function fetchSnapshot() {
  if (_fetchSnapshotPromise) return _fetchSnapshotPromise;

  _fetchSnapshotPromise = (async () => {
    try {
      const rp = rangeToParams(state.timeRange);
      const rangeQuery = `?from=${encodeURIComponent(rp.from)}&to=${encodeURIComponent(rp.to)}`;
      const [summaryRes, bridgeRes, sessionsRes, sysRes, quotaRes, routingRes, sotaRes, dailyRes, logsRes] =
        await Promise.all([
          api.get(`/summary${rangeQuery}`).catch(() => null),
          api.get('/bridge-state').catch(() => null),
          api.get(`/sessions${rangeQuery}`).catch(() => null),
          api.get('/sysinfo').catch(() => null),
          api.get('/quota').catch(() => null),
          api.get('/routing-chain').catch(() => null),
          api.get('/sota-stats').catch(() => null),
          api.get(`/daily${rangeQuery}`).catch(() => null),
          api.get('/logs?limit=500&type=log').catch(() => null),
        ]);

      if (summaryRes) {
        state.summary = summaryRes;
        modelChart.update(summaryRes);
      }
      if (bridgeRes) state.bridgeState.loop = bridgeRes;
      if (sessionsRes) state.sessions = sessionsRes;
      if (sysRes) state.systemMetrics = sysRes;
      if (quotaRes) state.quota = quotaRes;
      if (routingRes) state.routingChain = routingRes;
      if (sotaRes) state.sotaStats = sotaRes;
      if (dailyRes) {
        state.dailyData = dailyRes;
        burnChart.update(dailyRes);
      }
      if (logsRes && logsRes.events) {
        state.bulkAddEvents(logsRes.events);
      }

      state.notify();
    } catch (e) {
      if (e.message === 'Unauthorized') {
        mountAuthOverlay(document.getElementById('auth-overlay'), (token) => {
          localStorage.setItem('dashboard_token', token);
          window.location.reload();
        });
      }
    } finally {
      _fetchSnapshotPromise = null;
    }
  })();

  return _fetchSnapshotPromise;
}

async function fetchQuotaOnly() {
  try {
    const quotaRes = await api.get('/quota').catch(() => null);
    if (quotaRes) {
      state.quota = quotaRes;
      state.notify();
    }
  } catch (_) {}
}

const ws = new DashboardWebSocket({
  token: api.token,
  onSnapshot: (snap) => {
    state.loadSnapshot(snap);
  },
  onEvent: (ev) => {
    state.addEvent(ev);
    if (ev.type === 'loop.status' || ev.type === 'phase.transition') {
      api
        .get('/routing-chain')
        .then((res) => {
          if (res) {
            state.routingChain = res;
            state.notify();
          }
        })
        .catch(() => null);
    }
  },
  onStatusChange: (status) => {
    header.setConnectionStatus(status);
  },
});

let _sysInfoInterval = null;
function startSysInfoPolling() {
  if (_sysInfoInterval) return;
  _sysInfoInterval = setInterval(async () => {
    if (!ws.connected) {
      const sysRes = await api.get('/sysinfo').catch(() => null);
      if (sysRes) {
        state.systemMetrics = sysRes;
        state.notify();
      }
    }
  }, 5000);
}
startSysInfoPolling();

setInterval(() => {
  if (state.activeTab === 'quotas') fetchQuotaOnly();
}, 5000);

fetchSnapshot().then(() => {
  ws.connect();
});
