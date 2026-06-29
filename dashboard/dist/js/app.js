import { DashboardAPI } from './api.js';
import { DashboardWebSocket } from './ws.js';
import { AppState } from './state.js';
import { mountHeader } from './components/header.js';
import { mountLogs } from './components/logs.js';
import { mountCommands } from './components/commands.js';
import { mountStats } from './components/stats.js';
import { mountProviders, mountQuotaGauges } from './components/providers.js';
import { mountUsageCharts } from './components/usage-charts.js';
import { mountProviderStats } from './components/provider-stats.js';
import { mountSessions } from './components/sessions.js';
import { mountCalls } from './components/calls.js';
import { mountRouting } from './components/routing.js';
import { mountCognitive } from './components/cognitive.js';
import { mountAuthOverlay } from './components/auth.js';
import { mountHITL } from './components/hitl.js';
import { mountTimeline } from './components/timeline.js';
import { BurnChart, ModelChart } from './charts.js';
const api = new DashboardAPI();
const state = new AppState();
const tabKeys = ['overview', 'logs', 'hitl', 'quotas', 'usage-charts', 'provider-stats', 'explorer'];
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
    if (logsCount)
        logsCount.textContent = s.logs.length;
    const hitlDot = document.getElementById('hitl-alert-dot');
    if (hitlDot) {
        if (s.hitl && s.hitl.active) {
            hitlDot.classList.remove('hidden');
        }
        else {
            hitlDot.classList.add('hidden');
        }
    }
    if (s.activeTab === 'overview') {
        if (s.summary)
            modelChart.update(s.summary);
        if (s.dailyData)
            burnChart.update(s.dailyData);
    }
    if (s.activeTab === 'usage-charts' && s.omnirouteUsageAnalytics) {
        // handled by mountUsageCharts subscriber
    }
    if (s.activeTab === 'provider-stats' && s.omnirouteProviderStats) {
        // handled by mountProviderStats subscriber
    }
});
function rangeToParams(range) {
    const now = new Date();
    const label = range || '1d';
    if (label === '1d') {
        const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
        return { from, to: now.toISOString() };
    }
    const seconds = { '1m': 60, '10m': 600, '1h': 3600, '24h': 86400, '1w': 604800, '1mo': 2592000 }[label] || 3600;
    const from = new Date(now.getTime() - seconds * 1000).toISOString();
    const to = now.toISOString();
    return { from, to };
}
let _fetchSnapshotPromise = null;
const header = mountHeader(document.getElementById('header-container'), state, api, () => {
    window.location.reload();
}, (range) => {
    fetchSnapshot();
});
mountLogs(document.getElementById('logs-container'), state, api);
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
mountUsageCharts(document.getElementById('usage-charts-container'), state);
mountProviderStats(document.getElementById('provider-stats-container'), state);
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
    if (_fetchSnapshotPromise)
        return _fetchSnapshotPromise;
    _fetchSnapshotPromise = (async () => {
        try {
            const rp = rangeToParams(state.timeRange);
            const rangeQuery = `?from=${encodeURIComponent(rp.from)}&to=${encodeURIComponent(rp.to)}`;
            const [summaryRes, bridgeRes, sessionsRes, sysRes, quotaRes, routingRes, sotaRes, dailyRes, logsRes, callsRes, providersMatrixRes, usageAnalyticsRes, providerStatsRes,] = await Promise.all([
                api.get(`/summary${rangeQuery}`).catch(() => null),
                api.get('/bridge-state').catch(() => null),
                api.get(`/sessions${rangeQuery}`).catch(() => null),
                api.get('/sysinfo').catch(() => null),
                api.get('/quota').catch(() => null),
                api.get('/routing-chain').catch(() => null),
                api.get('/sota-stats').catch(() => null),
                api.get(`/daily${rangeQuery}`).catch(() => null),
                api.get('/logs?limit=500&type=log').catch(() => null),
                api.get(`/calls${rangeQuery}`).catch(() => null),
                api.get('/providers-matrix').catch(() => null),
                api.get('/omniroute/usage/analytics').catch(() => null),
                api.get('/omniroute/provider-stats').catch(() => null),
            ]);
            if (summaryRes) {
                state.summary = summaryRes;
                modelChart.update(summaryRes);
            }
            if (bridgeRes)
                state.bridgeState.loop = bridgeRes;
            if (sessionsRes)
                state.sessions = sessionsRes;
            if (sysRes)
                state.systemMetrics = sysRes;
            if (quotaRes)
                state.quota = quotaRes;
            if (routingRes)
                state.routingChain = routingRes;
            if (sotaRes)
                state.sotaStats = sotaRes;
            if (dailyRes) {
                const dailyData = Array.isArray(dailyRes) ? dailyRes : (dailyRes.local || []);
                state.dailyData = dailyData;
                burnChart.update(dailyData);
            }
            if (providersMatrixRes && !providersMatrixRes.error) {
                state.providerHealthMatrix = providersMatrixRes;
            }
            if (usageAnalyticsRes && !usageAnalyticsRes.error) {
                state.omnirouteUsageAnalytics = usageAnalyticsRes;
            }
            if (providerStatsRes && !providerStatsRes.error) {
                state.omnirouteProviderStats = providerStatsRes;
            }
            if (logsRes && logsRes.events) {
                state.bulkAddEvents(logsRes.events);
            }
            if (callsRes && Array.isArray(callsRes)) {
                state.loadCalls(callsRes);
            }
            else if (callsRes && callsRes.calls) {
                state.loadCalls(callsRes.calls);
            }
            state.notify();
        }
        catch (e) {
            if (e.message === 'Unauthorized') {
                mountAuthOverlay(document.getElementById('auth-overlay'), (token) => {
                    localStorage.setItem('dashboard_token', token);
                    window.location.reload();
                });
            }
        }
        finally {
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
    }
    catch (_) {
        // Ignore fetch error
    }
}
const ws = new DashboardWebSocket({
    token: api.token,
    onSnapshot: (snap) => {
        state.loadSnapshot(snap);
    },
    onEvent: (ev) => {
        state.addEvent(ev);
    },
    onStatusChange: (status) => {
        header.setConnectionStatus(status);
    },
});
let _sysInfoInterval = null;
function startSysInfoPolling() {
    if (_sysInfoInterval)
        return;
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
let _quotaInterval = null;
function startQuotaPolling() {
    if (_quotaInterval)
        clearInterval(_quotaInterval);
    _quotaInterval = setInterval(() => {
        if (state.activeTab === 'quotas')
            fetchQuotaOnly();
    }, 5000);
}
startQuotaPolling();
fetchSnapshot().then(() => {
    ws.connect();
});
