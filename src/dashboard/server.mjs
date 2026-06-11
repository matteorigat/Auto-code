import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetricsCollector } from './collector.mjs';
import { auditProviders } from './providers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, "..", "..", "dashboard");
const HYDRA_DIR = join(__dirname, "..", "..", ".hydra");

export class DashboardServer {
  constructor(port = 8081, orchestratorIpcManager = null) {
    this.port = port;
    this.app = express();
    this.collector = new MetricsCollector();
    this.orchestratorIpcManager = orchestratorIpcManager;
    
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    this.setupRoutes();
  }

  setupRoutes() {
    this.app.get('/', (req, res) => {
      res.sendFile(join(DASHBOARD_DIR, 'index.html'));
    });

    this.app.get('/api/daily', (req, res) => {
      const data = this.collector.query(
        "SELECT date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors FROM daily_agg ORDER BY date DESC, calls DESC LIMIT 500"
      );
      res.json(data);
    });

    this.app.get('/api/calls', (req, res) => {
      const days = req.query.days || '7';
      const data = this.collector.query(
        "SELECT ts, provider, model, input_tokens, output_tokens, total_tokens, status FROM model_calls WHERE ts >= datetime('now', '+2 hours', ?) ORDER BY ts DESC LIMIT 200",
        [`-\${days} days`]
      );
      res.json(data);
    });

    this.app.get('/api/sessions', (req, res) => {
      const data = this.collector.query(
        "SELECT ts, session_key, model, agent, channel, context_pct, total_tokens FROM sessions_snapshot ORDER BY ts DESC LIMIT 50"
      );
      res.json(data);
    });

    this.app.get('/api/models-ref', (req, res) => {
      try {
        const refPath = join(DASHBOARD_DIR, "models-ref.json");
        if (existsSync(refPath)) res.json(JSON.parse(readFileSync(refPath, 'utf8')));
        else res.status(404).json({ error: "models-ref.json non trovato" });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/providers/audit', async (req, res) => {
      const probe = req.query.probe === '1';
      res.json(await auditProviders(probe));
    });

    this.app.get('/api/cooldowns', (req, res) => {
      res.json(this.collector.query("SELECT ts, provider, reason FROM cooldown_events ORDER BY ts DESC LIMIT 50"));
    });

    this.app.get('/api/bridge-state', (req, res) => {
      try {
        const statePath = join(HYDRA_DIR, "loop-state.json");
        if (existsSync(statePath)) res.json(JSON.parse(readFileSync(statePath, 'utf8')));
        else res.status(404).json({ error: "Bridge state missing" });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/sysinfo', async (req, res) => {
      try {
        const os = await import('node:os');
        res.json({
          cpu_pct: 0, // Mocked since psutil needs native bindings
          ram_used: os.totalmem() - os.freemem(),
          ram_total: os.totalmem(),
          ram_pct: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
          disk_used: 0,
          disk_total: 0,
          disk_pct: 0
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/routing-chain', (req, res) => {
      try {
        const configPath = join(__dirname, "..", "..", "config", "litellm.yaml");
        const tiers = {};
        if (existsSync(configPath)) {
          let currentTier = null;
          for (let line of readFileSync(configPath, 'utf8').split('\\n')) {
            line = line.trim();
            if (line.startsWith('- model_name:')) {
              currentTier = line.split(':')[1].trim();
              if (!tiers[currentTier]) tiers[currentTier] = [];
            } else if (line.startsWith('model:') && currentTier) {
              const m = line.split(':')[1].trim().replace(/['"]/g, '');
              const provider = m.includes('/') ? m.split('/')[0] : '';
              tiers[currentTier].push({ model: m, provider, status: 'standby' });
            }
          }
        }
        res.json(tiers);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/sota-stats', (req, res) => {
      let cacheHits = 0, costSaved = 0.0, distSamples = 0;
      try {
        const cachePath = join(HYDRA_DIR, "semantic-cache.json");
        if (existsSync(cachePath)) {
          const cacheData = JSON.parse(readFileSync(cachePath, 'utf8'));
          cacheHits = (cacheData.entries || []).length;
          costSaved = (cacheData.entries || []).reduce((acc, e) => acc + (e.costSaved || 0), 0);
        }
        const distillPath = join(HYDRA_DIR, "distillation-dataset.jsonl");
        if (existsSync(distillPath)) {
          distSamples = readFileSync(distillPath, 'utf8').split('\\n').filter(l => l.trim()).length;
        }
      } catch {}
      res.json({ cache_hits: cacheHits, cost_saved: costSaved, distillation_samples: distSamples });
    });

    this.app.get('/api/summary', (req, res) => {
      res.json(this.handleStats(req.query.range || 'all'));
    });

    this.app.post('/api/bridge-cmd', (req, res) => {
      const cmd = req.body.cmd;
      if (this.orchestratorIpcManager) {
        this.orchestratorIpcManager.sendCommand(cmd);
        res.json({ status: "ok", method: "ipc" });
      } else {
        // Fallback to file for older bridges
        try {
          const cmdPath = join(HYDRA_DIR, "bridge-cmd.json");
          const payload = { ...req.body, ts: new Date().toISOString() };
          import('node:fs').then(fs => fs.writeFileSync(cmdPath, JSON.stringify(payload)));
          res.json({ status: "ok", method: "file" });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      }
    });
    
    // Webhook from litellm_logger to natively stream metrics without parsing files
    this.app.post('/api/internal/log-call', (req, res) => {
      this.collector.logCall(req.body);
      res.json({ status: "ok" });
    });
  }

  handleStats(range) {
    let where = "";
    let rangeLabel = "All Time";
    const TZ = "'+2 hours'";
    const IT_NOW_MINUS_1M = `datetime('now', ${TZ}, '-1 minute')`;
    const IT_NOW_MINUS_1H = `datetime('now', ${TZ}, '-1 hour')`;
    const IT_DATE = `date('now', ${TZ})`;
    const IT_DATE_MINUS_1 = `date('now', ${TZ}, '-1 day')`;
    const IT_NOW_MINUS_24H = `datetime('now', ${TZ}, '-24 hours')`;
    const IT_NOW_MINUS_7D = `datetime('now', ${TZ}, '-7 days')`;
    const IT_WEEK = `date('now', ${TZ}, 'weekday 1', '-7 days')`;
    const IT_NOW_MINUS_30D = `datetime('now', ${TZ}, '-30 days')`;
    const IT_MONTH = `date('now', ${TZ}, 'start of month')`;

    switch (range) {
      case '1m': where = `WHERE ts >= ${IT_NOW_MINUS_1M}`; rangeLabel = "Last Minute"; break;
      case '1h': where = `WHERE ts >= ${IT_NOW_MINUS_1H}`; rangeLabel = "Last Hour"; break;
      case 'today': where = `WHERE ts >= ${IT_DATE}`; rangeLabel = "Today"; break;
      case 'yesterday': where = `WHERE ts >= ${IT_DATE_MINUS_1} AND ts < ${IT_DATE}`; rangeLabel = "Yesterday"; break;
      case '24h': where = `WHERE ts >= ${IT_NOW_MINUS_24H}`; rangeLabel = "Last 24h"; break;
      case '7d': where = `WHERE ts >= ${IT_NOW_MINUS_7D}`; rangeLabel = "Last 7 Days"; break;
      case 'thisweek': where = `WHERE ts >= ${IT_WEEK}`; rangeLabel = "This Week"; break;
      case '30d': where = `WHERE ts >= ${IT_NOW_MINUS_30D}`; rangeLabel = "Last 30 Days"; break;
      case 'thismonth': where = `WHERE ts >= ${IT_MONTH}`; rangeLabel = "This Month"; break;
    }

    const totalQ = `SELECT COUNT(*) as total_calls, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as total_errors FROM model_calls ${where}`;
    const byModelQ = `SELECT model, COUNT(*) as calls, SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(total_tokens) as total, SUM(cost) as cost, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as errors FROM model_calls ${where} GROUP BY model ORDER BY calls DESC LIMIT 50`;
    const byProviderQ = `SELECT provider, COUNT(*) as calls, SUM(total_tokens) as tokens, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_calls, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as err_calls FROM model_calls ${where} GROUP BY provider ORDER BY calls DESC`;
    const byStatusQ = `SELECT status, COUNT(*) as cnt FROM model_calls ${where} GROUP BY status ORDER BY cnt DESC`;

    const total = this.collector.get(totalQ) || {};
    const daily = this.collector.query("SELECT date, SUM(calls) as calls, SUM(total_tokens) as tokens, SUM(cost) as cost, SUM(errors) as errors FROM daily_agg GROUP BY date ORDER BY date DESC LIMIT 90");
    const byModelList = this.collector.query(byModelQ);
    const providerList = this.collector.query(byProviderQ);
    const byStatus = this.collector.query(byStatusQ);
    
    let today = {};
    if (range === '1m') {
      today = providerList[0] || {};
    } else {
      today = this.collector.get(`SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(cost),0) as cost FROM model_calls WHERE ts >= ${IT_DATE}`) || {};
    }

    const todayProv = this.collector.query(`SELECT provider, COUNT(*) as calls, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_calls FROM model_calls WHERE ts >= ${IT_DATE} GROUP BY provider`);
    const todayOkMap = {};
    for (const r of todayProv) todayOkMap[r.provider] = r.ok_calls;

    return {
      total,
      today,
      daily,
      byModel: byModelList,
      byProvider: providerList.map(p => ({ ...p, today_ok: todayOkMap[p.provider] || 0 })),
      byStatus,
      range: rangeLabel,
      gateway: { status: "ok" }
    };
  }

  start() {
    this.server = this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`📊 Dashboard Server running on http://127.0.0.1:${this.port}`);
    });
    
    // Cleanup old data periodically
    setInterval(() => this.collector.cleanupOld(), 1000 * 60 * 60);
    // Snapshot sessions periodically
    setInterval(() => this.collector.snapshotSessions(), 1000 * 60 * 15);
  }

  stop() {
    if (this.server) this.server.close();
  }
}
