import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
  readonly body: { readonly id?: string; readonly type?: string; readonly [key: string]: unknown };
  readonly type: string | undefined;
  readonly receivedAt: Date;
}

export type Responder = number | ((webhook: ReceivedWebhook) => number);

interface Waiter {
  readonly match: (w: ReceivedWebhook) => boolean;
  readonly resolve: (w: ReceivedWebhook) => void;
}

/** A local HTTP endpoint that records every webhook delivery it receives. */
export class WebhookCollector {
  readonly received: ReceivedWebhook[] = [];
  private responder: Responder = 200;
  private waiters: Waiter[] = [];
  private server: Server | null = null;
  url = '';
  /** Set once the endpoint is registered with the sandbox. */
  secret = '';
  endpointId = '';

  async listen(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: ReceivedWebhook['body'] = {};
        try {
          body = JSON.parse(rawBody) as ReceivedWebhook['body'];
        } catch {
          // keep empty body
        }
        const webhook: ReceivedWebhook = { headers: req.headers, rawBody, body, type: typeof body.type === 'string' ? body.type : undefined, receivedAt: new Date() };
        this.received.push(webhook);
        const status = typeof this.responder === 'number' ? this.responder : this.responder(webhook);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
        for (const waiter of [...this.waiters]) {
          if (waiter.match(webhook)) {
            this.waiters = this.waiters.filter((w) => w !== waiter);
            waiter.resolve(webhook);
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/webhooks`;
    return this;
  }

  /** Status code (or function) used to answer deliveries; non-2xx makes the sandbox retry. */
  respondWith(responder: Responder): void {
    this.responder = responder;
  }

  ofType(type: string): ReceivedWebhook[] {
    return this.received.filter((w) => w.type === type);
  }

  /** Resolves with the first delivery (already received or future) of `type` that matches. */
  waitFor(type: string, predicate: (w: ReceivedWebhook) => boolean = () => true, options: { timeoutMs?: number } = {}): Promise<ReceivedWebhook> {
    const match = (w: ReceivedWebhook): boolean => w.type === type && predicate(w);
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        const seen = this.received.map((w) => w.type).join(', ') || 'none';
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for webhook '${type}'. Received: ${seen}`));
      }, timeoutMs);
      const done = (w: ReceivedWebhook): void => {
        clearTimeout(timer);
        resolve(w);
      };
      this.waiters.push({ match, resolve: done });
    });
  }

  clear(): void {
    this.received.length = 0;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
