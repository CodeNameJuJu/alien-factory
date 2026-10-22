// Reconnecting WebSocket to the Agent Office server.
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

export type Handler = (msg: ServerMessage) => void;

export class Net {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  connected = false;
  onMessage: Handler = () => {};
  onConnection: (up: boolean) => void = () => {};

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onConnection(true);
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.onConnection(false);
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }
}
