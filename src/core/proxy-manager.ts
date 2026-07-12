/**
 * ProxyManager — IP rotation proxy pool for ModelRouter.
 *
 * Supports multiple proxy strategies to bypass OpenCode's IP-based rate limiting:
 *  - "webshare"  → Webshare.io rotating endpoint (free tier: 10 IPs, 1GB/mo)
 *  - "custom"    → User-supplied list of HTTP/SOCKS5 proxies
 *  - "tor"       → Local Tor SOCKS5 proxy with circuit rotation
 *  - "none"      → No proxy (direct connection, default)
 *
 * Uses undici's ProxyAgent / Socks5ProxyAgent as fetch dispatcher.
 */

import net from 'node:net';
import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProxyStrategy = 'none' | 'webshare' | 'custom' | 'tor';

export interface ProxyEntry {
  /** Original proxy URL (e.g. socks5://user:pass@host:1080) */
  url: string;
  /** Protocol parsed from URL */
  protocol: 'http' | 'https' | 'socks5';
  /** Cached undici dispatcher */
  dispatcher: Dispatcher;
  /** Whether this proxy is currently healthy */
  healthy: boolean;
  /** Consecutive failure count */
  failCount: number;
  /** Timestamp when cooldown expires (0 = not in cooldown) */
  cooldownUntil: number;
  /** Last time this proxy was successfully used */
  lastUsedAt: number | null;
  /** Last detected exit IP (from health check) */
  lastIp: string | null;
}

export interface ProxyConfig {
  strategy: ProxyStrategy;
  webshare?: {
    user: string;
    pass: string;
    host: string;
    port: number;
  };
  customList?: string[];
  tor?: {
    socksPort: number;
    controlPort: number;
    controlPassword: string;
  };
}

export interface ProxyStatus {
  strategy: ProxyStrategy;
  totalProxies: number;
  healthyProxies: number;
  proxies: Array<{
    url: string;
    healthy: boolean;
    failCount: number;
    lastUsedAt: number | null;
    lastIp: string | null;
    inCooldown: boolean;
  }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const COOLDOWN_MS = 60_000;             // 60s cooldown after 3 failures
const MAX_FAILURES = 3;                 // failures before cooldown
const HEALTH_CHECK_INTERVAL_MS = 300_000; // 5 min
const HEALTH_CHECK_TIMEOUT_MS = 10_000;   // 10s timeout for health check
const TOR_NEWNYM_COOLDOWN_MS = 10_000;    // Tor requires ~10s between NEWNYM signals

// ─── ProxyManager ────────────────────────────────────────────────────────────

export class ProxyManager {
  private proxies: ProxyEntry[] = [];
  private nextIdx = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastTorRotation = 0;
  readonly config: ProxyConfig;

  constructor(proxyConfig?: ProxyConfig) {
    this.config = proxyConfig || ProxyManager.configFromEnv();
    this.buildPool();

    if (this.proxies.length > 0) {
      console.log(
        `[ProxyManager] Strategy: ${this.config.strategy}, pool: ${this.proxies.length} proxies`,
      );
      // Start periodic health checks
      this.healthCheckTimer = setInterval(() => this.healthCheckAll(), HEALTH_CHECK_INTERVAL_MS);
      // Initial health check (non-blocking)
      this.healthCheckAll().catch(() => {});
    } else {
      console.log('[ProxyManager] Strategy: none — direct connection (no proxy)');
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Get the next available proxy dispatcher for a fetch request.
   * Returns null if no proxy is configured or all proxies are down.
   */
  getDispatcher(): Dispatcher | null {
    if (this.proxies.length === 0) return null;

    const now = Date.now();

    // Try up to N proxies in round-robin
    for (let attempt = 0; attempt < this.proxies.length; attempt++) {
      const idx = this.nextIdx % this.proxies.length;
      this.nextIdx = (this.nextIdx + 1) % this.proxies.length;

      const proxy = this.proxies[idx];

      // Skip if in cooldown
      if (proxy.cooldownUntil > now) continue;

      // Reactivate if cooldown expired
      if (!proxy.healthy && proxy.cooldownUntil <= now && proxy.cooldownUntil > 0) {
        proxy.healthy = true;
        proxy.failCount = 0;
        proxy.cooldownUntil = 0;
      }

      if (proxy.healthy) {
        proxy.lastUsedAt = now;
        return proxy.dispatcher;
      }
    }

    // All proxies exhausted — return null (caller will use direct connection)
    console.warn('[ProxyManager] All proxies exhausted — falling back to direct connection');
    return null;
  }

  /**
   * Report a successful request through proxy at given index.
   * Called by ModelRouter after a successful upstream call.
   */
  reportSuccess(): void {
    // The last used proxy is at (nextIdx - 1)
    const idx = (this.nextIdx - 1 + this.proxies.length) % this.proxies.length;
    const proxy = this.proxies[idx];
    if (proxy) {
      proxy.failCount = 0;
      proxy.healthy = true;
    }
  }

  /**
   * Report a failed request through proxy.
   * After MAX_FAILURES consecutive failures, puts proxy in cooldown.
   * If statusCode is 429, we immediately force an IP rotation for this proxy.
   */
  reportFailure(statusCode?: number): void {
    const idx = (this.nextIdx - 1 + this.proxies.length) % this.proxies.length;
    const proxy = this.proxies[idx];
    if (!proxy) return;

    if (statusCode === 429) {
      console.warn(`[ProxyManager] Received 429 on proxy ${this.maskUrl(proxy.url)}, forcing IP rotation...`);
      this.forceRotate(idx);
      // We don't increment failCount on 429 because it's a rate limit, we just rotate and retry
      return;
    }

    proxy.failCount++;
    if (proxy.failCount >= MAX_FAILURES) {
      proxy.healthy = false;
      proxy.cooldownUntil = Date.now() + COOLDOWN_MS;
      console.warn(
        `[ProxyManager] Proxy ${this.maskUrl(proxy.url)} marked unhealthy after ${proxy.failCount} failures, cooldown ${COOLDOWN_MS / 1000}s`,
      );
    }
  }

  /**
   * Get current proxy pool status for dashboard.
   */
  getStatus(): ProxyStatus {
    const now = Date.now();
    return {
      strategy: this.config.strategy,
      totalProxies: this.proxies.length,
      healthyProxies: this.proxies.filter((p) => p.healthy || p.cooldownUntil <= now).length,
      proxies: this.proxies.map((p) => ({
        url: this.maskUrl(p.url),
        healthy: p.healthy,
        failCount: p.failCount,
        lastUsedAt: p.lastUsedAt,
        lastIp: p.lastIp,
        inCooldown: p.cooldownUntil > now,
      })),
    };
  }

  /**
   * Force an IP rotation for a specific proxy (or the last used one).
   */
  async forceRotate(index?: number): Promise<boolean> {
    const idx = index ?? ((this.nextIdx - 1 + this.proxies.length) % this.proxies.length);
    const proxy = this.proxies[idx];
    if (!proxy) return false;

    if (this.config.strategy === 'tor') {
      return this.rotateTorCircuit(true);
    } else if (this.config.strategy === 'webshare') {
      // For webshare, rotating means killing the old keep-alive agent and creating a new one
      try {
        (proxy.dispatcher as any).close?.();
      } catch { /* ignore */ }
      
      proxy.dispatcher = new ProxyAgent({
        uri: proxy.url,
        keepAliveTimeout: 10_000,
        keepAliveMaxTimeout: 30_000,
      });
      console.log(`[ProxyManager] Webshare agent recreated to force new connection/IP`);
      return true;
    } else {
      // Custom proxy lists can't easily force rotate unless they provide an endpoint, so we just bump failure
      console.log(`[ProxyManager] Cannot force IP rotation for custom proxies.`);
      return false;
    }
  }

  /**
   * Request Tor to build a new circuit (IP rotation).
   * Has a built-in 10s cooldown between rotations, unless 'force' is true.
   */
  async rotateTorCircuit(force = false): Promise<boolean> {
    if (this.config.strategy !== 'tor' || !this.config.tor) return false;

    const now = Date.now();
    if (!force && now - this.lastTorRotation < TOR_NEWNYM_COOLDOWN_MS) {
      return false; // Too soon since last rotation
    }

    try {
      await this.sendTorSignal('NEWNYM');
      this.lastTorRotation = now;
      console.log('[ProxyManager] Tor circuit rotated (SIGNAL NEWNYM)');
      return true;
    } catch (err) {
      console.error('[ProxyManager] Tor rotation failed:', err);
      return false;
    }
  }

  /**
   * Shut down health checks and close dispatchers.
   */
  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    for (const proxy of this.proxies) {
      try {
        (proxy.dispatcher as any).close?.();
      } catch {
        // ignore
      }
    }
    this.proxies = [];
  }

  // ─── Pool Construction ───────────────────────────────────────────────────

  private buildPool(): void {
    switch (this.config.strategy) {
      case 'webshare':
        this.buildWebsharePool();
        break;
      case 'custom':
        this.buildCustomPool();
        break;
      case 'tor':
        this.buildTorPool();
        break;
      case 'none':
      default:
        // No proxies
        break;
    }
  }

  private buildWebsharePool(): void {
    const ws = this.config.webshare;
    if (!ws || !ws.user || !ws.pass) {
      console.warn('[ProxyManager] Webshare strategy requires WEBSHARE_USER and WEBSHARE_PASS');
      return;
    }

    const host = ws.host || 'p.webshare.io';
    const port = ws.port || 1080;

    // Webshare rotating endpoint: each connection gets a different IP
    // We create multiple ProxyAgent instances to maintain separate connections
    const proxyCount = 10; // Webshare free gives 10 IPs
    for (let i = 0; i < proxyCount; i++) {
      const url = `http://${ws.user}-rotate:${ws.pass}@${host}:${port}`;
      this.proxies.push({
        url,
        protocol: 'http',
        dispatcher: new ProxyAgent({
          uri: url,
          keepAliveTimeout: 10_000,
          keepAliveMaxTimeout: 30_000,
        }),
        healthy: true,
        failCount: 0,
        cooldownUntil: 0,
        lastUsedAt: null,
        lastIp: null,
      });
    }
  }

  private buildCustomPool(): void {
    const list = this.config.customList;
    if (!list || list.length === 0) {
      console.warn('[ProxyManager] Custom strategy requires PROXY_LIST env var');
      return;
    }

    for (const proxyUrl of list) {
      const trimmed = proxyUrl.trim();
      if (!trimmed) continue;

      const protocol = this.detectProtocol(trimmed);
      const dispatcher =
        protocol === 'socks5'
          ? new Socks5ProxyAgent(trimmed)
          : new ProxyAgent({ uri: trimmed });

      this.proxies.push({
        url: trimmed,
        protocol,
        dispatcher,
        healthy: true,
        failCount: 0,
        cooldownUntil: 0,
        lastUsedAt: null,
        lastIp: null,
      });
    }
  }

  private buildTorPool(): void {
    const tor = this.config.tor;
    const socksPort = tor?.socksPort || 9050;

    // Single Tor SOCKS5 proxy — IP rotation happens via SIGNAL NEWNYM
    const url = `socks5://127.0.0.1:${socksPort}`;
    this.proxies.push({
      url,
      protocol: 'socks5',
      dispatcher: new Socks5ProxyAgent(url),
      healthy: true,
      failCount: 0,
      cooldownUntil: 0,
      lastUsedAt: null,
      lastIp: null,
    });
  }

  // ─── Health Check ────────────────────────────────────────────────────────

  private async healthCheckAll(): Promise<void> {
    for (const proxy of this.proxies) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

        const res = await fetch('https://api.ipify.org?format=json', {
          dispatcher: proxy.dispatcher,
          signal: controller.signal,
        } as RequestInit);
        clearTimeout(timeout);

        if (res.ok) {
          const data = (await res.json()) as { ip: string };
          proxy.lastIp = data.ip;
          proxy.healthy = true;
          proxy.failCount = 0;
        } else {
          proxy.failCount++;
          if (proxy.failCount >= MAX_FAILURES) {
            proxy.healthy = false;
            proxy.cooldownUntil = Date.now() + COOLDOWN_MS;
          }
        }
      } catch {
        // Health check failed silently — don't penalize too harshly
        // Only mark unhealthy if already failing
        if (proxy.failCount > 0) {
          proxy.failCount++;
          if (proxy.failCount >= MAX_FAILURES) {
            proxy.healthy = false;
            proxy.cooldownUntil = Date.now() + COOLDOWN_MS;
          }
        }
      }
    }

    // For Tor strategy: rotate circuit after health check
    if (this.config.strategy === 'tor') {
      await this.rotateTorCircuit();
    }
  }

  // ─── Tor Control ─────────────────────────────────────────────────────────

  private sendTorSignal(signal: string): Promise<void> {
    const tor = this.config.tor;
    const controlPort = tor?.controlPort || 9051;
    const password = tor?.controlPassword || '';

    return new Promise<void>((resolve, reject) => {
      const socket = net.connect(controlPort, '127.0.0.1', () => {
        socket.write(`AUTHENTICATE "${password}"\r\n`);
        socket.write(`SIGNAL ${signal}\r\n`);
        socket.write('QUIT\r\n');
      });

      let responseData = '';
      socket.on('data', (data) => {
        responseData += data.toString();
      });

      socket.on('end', () => {
        if (responseData.includes('250')) {
          resolve();
        } else {
          reject(new Error(`Tor control response: ${responseData.trim()}`));
        }
      });

      socket.on('error', reject);

      // Timeout after 5s
      setTimeout(() => {
        socket.destroy();
        reject(new Error('Tor control connection timed out'));
      }, 5000);
    });
  }

  // ─── Config Parsing ──────────────────────────────────────────────────────

  static configFromEnv(): ProxyConfig {
    const strategy = (process.env.PROXY_STRATEGY || 'none').toLowerCase() as ProxyStrategy;

    const config: ProxyConfig = { strategy };

    if (strategy === 'webshare') {
      config.webshare = {
        user: process.env.WEBSHARE_USER || '',
        pass: process.env.WEBSHARE_PASS || '',
        host: process.env.WEBSHARE_HOST || 'p.webshare.io',
        port: parseInt(process.env.WEBSHARE_PORT || '1080', 10),
      };
    }

    if (strategy === 'custom') {
      const list = process.env.PROXY_LIST || '';
      config.customList = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (strategy === 'tor') {
      config.tor = {
        socksPort: parseInt(process.env.TOR_SOCKS_PORT || '9050', 10),
        controlPort: parseInt(process.env.TOR_CONTROL_PORT || '9051', 10),
        controlPassword: process.env.TOR_CONTROL_PASSWORD || '',
      };
    }

    return config;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private detectProtocol(url: string): 'http' | 'https' | 'socks5' {
    if (url.startsWith('socks5://') || url.startsWith('socks5h://')) return 'socks5';
    if (url.startsWith('https://')) return 'https';
    return 'http';
  }

  /** Mask credentials in proxy URL for safe logging */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      return parsed.toString();
    } catch {
      return url.replace(/:([^@]+)@/, ':***@');
    }
  }
}
