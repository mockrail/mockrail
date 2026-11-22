import type { IncomingMessage, ServerResponse } from 'node:http';
import { SandboxError } from '@mockrail/core';

const MAX_BODY_BYTES = 1024 * 1024;

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new SandboxError('bad_request', 'Request body is larger than 1 MB.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJsonBody(raw: string, contentType: string | undefined): unknown {
  if (!raw.trim()) return undefined;
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SandboxError('bad_request', 'The request body is not valid JSON.');
  }
}

/** JSON with bigint values rendered as strings (core records use bigint minor units). */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}
