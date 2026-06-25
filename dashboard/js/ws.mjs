export class DashboardWebSocket {
  constructor(options = {}) {
    this.token = options.token || localStorage.getItem('dashboard_token');
    this.onEvent = options.onEvent || (() => {});
    this.onSnapshot = options.onSnapshot || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = options.url || `${proto}//${window.location.host}/ws`;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.ws = null;
    this.connected = false;
    this._closed = false;
    this._heartbeatInterval = null;
    this._reconnectTimer = null;
  }

  connect() {
    if (this._closed) return;
    let wsUrl = this.url;
    if (this.token) wsUrl += `?token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('WebSocket construction failed', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.onStatusChange(true);
      this._startHeartbeat();
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.onStatusChange(false);
      this._stopHeartbeat();
      if (!this._closed) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      if (this.ws) {
        try {
          this.ws.close();
        } catch (_) {}
      }
    };

    this.ws.onmessage = (msg) => {
      try {
        const payload = JSON.parse(msg.data);
        if (payload.type === 'snapshot') {
          this.onSnapshot(payload.data);
        } else if (payload.type === 'event') {
          this.onEvent(payload.event);
        } else if (payload.type === 'ping') {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        console.error('Failed to parse WS message', e);
      }
    };
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch (_) {}
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  disconnect() {
    this._closed = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}
