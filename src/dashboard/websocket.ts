import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { TelemetryStore } from './telemetry-store.js';

export class DashboardWebSocket {
  store: TelemetryStore;
  authToken: string | null;
  clients: Set<WebSocket>;
  wss: WebSocketServer;

  constructor(
    httpServer: HttpServer,
    telemetryStore: TelemetryStore,
    authToken: string | null = null,
  ) {
    this.store = telemetryStore;
    this.authToken = authToken;
    this.clients = new Set();

    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually for auth
    httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Auth check
      if (this.authToken) {
        const token = url.searchParams.get('token');
        if (token !== this.authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      // Send initial snapshot
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          data: this.store.getSnapshot(),
        }),
      );

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));

      // Handle client messages (commands, subscriptions)
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* ignore malformed */
        }
      });
    });

    // Heartbeat every 30s
    setInterval(() => {
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', ts: new Date().toISOString() }));
        }
      }
    }, 30000).unref();
  }

  broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
