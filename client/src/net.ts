import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage
} from '@shared/protocol.js';

export interface LinkHandlers {
  onOpen?: () => void;
  onRoom?: (msg: Extract<ServerMessage, { t: 'room' }>) => void;
  onState?: (msg: Extract<ServerMessage, { t: 'state' }>) => void;
  onEvent?: (msg: Extract<ServerMessage, { t: 'event' }>) => void;
  onError?: (msg: Extract<ServerMessage, { t: 'error' }>) => void;
  onClose?: (info: { code: number; willRetry: boolean }) => void;
}

export type LinkStatus = 'idle' | 'connecting' | 'welcome' | 'open' | 'reconnecting' | 'failed';

export class LinkClient {
  private ws: WebSocket | null = null;
  private handlers: LinkHandlers = {};
  private url: string;
  private attempts = 0;
  private retryTimer: number | null = null;
  private closedByUser = false;
  private queued: ClientMessage[] = [];
  seq = 0;
  status: LinkStatus = 'idle';

  constructor(url?: string) {
    if (url) {
      this.url = url;
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const override = new URLSearchParams(location.search).get('server');
      this.url = override ? override : `${proto}//${location.host}/ws`;
    }
  }

  setHandlers(handlers: LinkHandlers): void {
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.status = this.attempts === 0 ? 'connecting' : 'reconnecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.status = 'welcome';
      this.raw({ t: 'hello', v: PROTOCOL_VERSION });
      for (const msg of this.queued) this.raw(msg);
      this.queued = [];
      this.handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.status = 'open';
          break;
        case 'room':
          this.handlers.onRoom?.(msg);
          break;
        case 'state':
          this.handlers.onState?.(msg);
          break;
        case 'event':
          this.handlers.onEvent?.(msg);
          break;
        case 'error':
          this.handlers.onError?.(msg);
          break;
        case 'pong':
          break;
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closedByUser) {
        this.status = 'idle';
        return;
      }
      this.status = 'failed';
      this.handlers.onClose?.({ code: ev.code, willRetry: false });
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.attempts++;
    if (this.attempts > 5) {
      this.status = 'failed';
      this.handlers.onClose?.({ code: 0, willRetry: false });
      return;
    }
    this.status = 'reconnecting';
    this.handlers.onClose?.({ code: 0, willRetry: true });
    const delay = Math.min(8000, 400 * 2 ** this.attempts);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private raw(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queued.push(msg);
  }

  send(msg: ClientMessage): void {
    this.raw(msg);
  }

  sendInput(dir: number, serve: boolean): void {
    this.seq++;
    this.raw({ t: 'input', seq: this.seq, dir, serve });
  }

  close(): void {
    this.closedByUser = true;
    this.queued = [];
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close(1000, 'client left');
    this.ws = null;
    this.status = 'idle';
  }
}
