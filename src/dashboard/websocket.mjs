import { WebSocketServer } from 'ws';
import { URL } from 'node:url';

export class DashboardWebSocket {
  constructor(httpServer, telemetryStore, authToken = null) {
    this.store = telemetryStore;
    this.authToken = authToken;
    this.clients = new Set();

    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually for auth
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
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

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
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
      ws.on('message', (raw) => {
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

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  getClientCount() {
    return this.clients.size;
  }
}
