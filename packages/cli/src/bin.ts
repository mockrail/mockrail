#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startServer, VERSION } from '@mockrail/server';

const HELP = `mockrail ${VERSION} - local payments sandbox

Usage:
  mockrail start [options]                 Start the sandbox server
  mockrail clock                           Show virtual time and pending jobs
  mockrail clock advance <duration>        Advance time (e.g. 30d, 1h30m, 500ms) and run due jobs
  mockrail clock freeze [iso-date]         Freeze the clock (now, or at a date)
  mockrail clock unfreeze                  Let the clock run again
  mockrail deposit <account> <amount>      Simulate a bank transfer into a virtual account
  mockrail checkout pay <checkout_id>      Pay a checkout session (use --card for test cards)
  mockrail scenarios list|clear            Show or remove scenario rules
  mockrail scenarios load <file.json>      Load a scenario file
  mockrail scenarios add --operation <op> --outcome <outcome> [--uses n|unlimited]
  mockrail events [--type t] [--webhooks]  List domain events (or provider webhook events)
  mockrail events replay <event_id>        Replay a provider webhook event (single attempt)
  mockrail fidelity sandbox|live           Switch fidelity mode
  mockrail reset                           Clear all state

Start options:
  --port <n>            Port (default 4010, env PORT)
  --host <host>         Host to bind (default 127.0.0.1; use 0.0.0.0 in Docker)
  --providers <list>    Comma-separated adapters (default bachs)
  --store <kind>        memory (default) or sqlite
  --db <path>           SQLite file (default ./mockrail.db)
  --fidelity <mode>     sandbox (default) or live
  --scenarios <file>    Scenario file to load at start
  --seed <n>            Seed for reproducible IDs and chaos
  --frozen [iso-date]   Start with the clock frozen
  --public-url <url>    Base URL used in hosted checkout links
  --no-rate-limit       Disable the provider rate limit
  --quiet               Do not log requests

Client options:
  --url <url>           Sandbox URL (default env MOCKRAIL_URL or http://127.0.0.1:4010)

Outcomes: succeed | fail:<reason> | delay:<duration> | partial:<amount>:<currency>
Operations: charge.create, checkout.pay, subscription.renew, refund.create, payout.create, deposit.receive, *
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    providers: { type: 'string' },
    store: { type: 'string' },
    db: { type: 'string' },
    fidelity: { type: 'string' },
    scenarios: { type: 'string' },
    seed: { type: 'string' },
    frozen: { type: 'boolean' },
    'public-url': { type: 'string' },
    'no-rate-limit': { type: 'boolean' },
    quiet: { type: 'boolean' },
    url: { type: 'string' },
    currency: { type: 'string' },
    sender: { type: 'string' },
    reference: { type: 'string' },
    card: { type: 'string' },
    method: { type: 'string' },
    email: { type: 'string' },
    operation: { type: 'string' },
    outcome: { type: 'string' },
    uses: { type: 'string' },
    prefix: { type: 'string' },
    type: { type: 'string' },
    webhooks: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const str = (name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
const baseUrl = (str('url') ?? process.env.MOCKRAIL_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');

async function control<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/__sandbox${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`Could not reach a sandbox at ${baseUrl}. Start one with \`mockrail start\` or pass --url.`);
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function start(): Promise<void> {
  const frozenAt = flags.frozen ? (positionals[1] ? new Date(positionals[1]) : new Date()) : undefined;
  const store = str('store');
  if (store && store !== 'memory' && store !== 'sqlite') throw new Error('--store must be memory or sqlite');
  const fidelity = str('fidelity');
  if (fidelity && fidelity !== 'sandbox' && fidelity !== 'live') throw new Error('--fidelity must be sandbox or live');
  const server = await startServer({
    port: Number(str('port') ?? process.env.PORT ?? 4010),
    host: str('host') ?? process.env.HOST ?? '127.0.0.1',
    providers: (str('providers') ?? process.env.MOCKRAIL_PROVIDERS ?? 'bachs').split(',').map((p) => p.trim()).filter(Boolean),
    store: (store ?? process.env.MOCKRAIL_STORE ?? 'memory') as 'memory' | 'sqlite',
    ...(str('db') ?? process.env.MOCKRAIL_DB ? { sqlitePath: str('db') ?? process.env.MOCKRAIL_DB } : {}),
    ...(fidelity ? { fidelity: fidelity as 'sandbox' | 'live' } : {}),
    ...(str('scenarios') ? { scenarios: str('scenarios') } : {}),
    ...(str('seed') ? { seed: Number(str('seed')) } : {}),
    ...(frozenAt ? { frozenAt } : {}),
    ...(str('public-url') ?? process.env.MOCKRAIL_PUBLIC_URL ? { publicBaseUrl: str('public-url') ?? process.env.MOCKRAIL_PUBLIC_URL } : {}),
    rateLimit: !flags['no-rate-limit'],
    logRequests: !flags.quiet,
  });
  const providers = [...server.adapters.values()];
  console.log(`\nmockrail ${VERSION} listening on ${server.url}\n`);
  for (const a of providers) console.log(`  ${a.displayName.padEnd(10)} ${server.url}/${a.providerId}/v1/...`);
  console.log(`  Control    ${server.url}/__sandbox/health`);
  console.log(`\n  Fidelity: ${server.sandbox.config.fidelity}   Clock: ${server.sandbox.clock.isFrozen() ? 'frozen' : 'running'}   Store: ${store ?? 'memory'}`);
  console.log(`  Use any sk_sandbox_ key, e.g. Authorization: Bearer sk_sandbox_local\n`);
  const shutdown = (): void => {
    console.log('\nStopping mockrail...');
    server.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const [command, sub, ...rest] = positionals;
  if (flags.version) return console.log(VERSION);
  if (flags.help || !command) return console.log(HELP);

  switch (command) {
    case 'start':
      return start();

    case 'clock': {
      if (!sub) return print(await control('GET', '/clock'));
      if (sub === 'advance') {
        if (!rest[0]) throw new Error('Usage: mockrail clock advance <duration>');
        const result = await control<{ now: string; jobs_run: number; failed: unknown[] }>('POST', '/clock/advance', { by: rest[0] });
        console.log(`Clock is now ${result.now} (${result.jobs_run} job${result.jobs_run === 1 ? '' : 's'} run)`);
        if (result.failed.length) print(result.failed);
        return;
      }
      if (sub === 'freeze') return print(await control('POST', '/clock/freeze', rest[0] ? { at: rest[0] } : {}));
      if (sub === 'unfreeze') return print(await control('POST', '/clock/unfreeze', {}));
      throw new Error(`Unknown clock command '${sub}'.`);
    }

    case 'deposit': {
      const [account, amount] = [sub, rest[0]];
      if (!account || !amount) throw new Error('Usage: mockrail deposit <account_number> <amount> [--currency NGN] [--sender "Name"] [--reference ref]');
      const result = await control<{ held: boolean; charge: { id: string } }>('POST', '/deposits', {
        account_number: account,
        amount,
        ...(str('currency') ? { currency: str('currency') } : {}),
        ...(str('sender') ? { sender_name: str('sender') } : {}),
        ...(str('reference') ? { reference: str('reference') } : {}),
      });
      console.log(`Deposit recorded as ${result.charge.id}${result.held ? ' (held: over the deposit limit)' : ''}`);
      return;
    }

    case 'checkout': {
      if (sub !== 'pay' || !rest[0]) throw new Error('Usage: mockrail checkout pay <checkout_id> [--card 4000000000000002] [--method card]');
      return print(
        await control('POST', `/checkout/${encodeURIComponent(rest[0])}/pay`, {
          method: str('method') ?? 'card',
          ...(str('card') ? { card_number: str('card') } : {}),
          ...(str('email') ? { email: str('email') } : {}),
        }),
      );
    }

    case 'scenarios': {
      if (!sub || sub === 'list') return print(await control('GET', '/scenarios'));
      if (sub === 'clear') return print(await control('DELETE', '/scenarios'));
      if (sub === 'load') {
        if (!rest[0]) throw new Error('Usage: mockrail scenarios load <file.json>');
        const result = await control<{ rules: unknown[] }>('POST', '/scenarios', JSON.parse(readFileSync(rest[0], 'utf8')));
        console.log(`Loaded ${result.rules.length} rule(s).`);
        return;
      }
      if (sub === 'add') {
        if (!str('operation') || !str('outcome')) throw new Error('Usage: mockrail scenarios add --operation payout.create --outcome fail:bank_rejected [--uses 1|unlimited] [--prefix ref_]');
        return print(
          await control('POST', '/scenarios', {
            match: { operation: str('operation'), ...(str('prefix') ? { reference_prefix: str('prefix') } : {}) },
            outcome: str('outcome'),
            uses: str('uses') === 'unlimited' ? 'unlimited' : Number(str('uses') ?? 1),
          }),
        );
      }
      throw new Error(`Unknown scenarios command '${sub}'.`);
    }

    case 'events': {
      if (sub === 'replay') {
        if (!rest[0]) throw new Error('Usage: mockrail events replay <event_id>');
        return print(await control('POST', `/webhooks/events/${encodeURIComponent(rest[0])}/replay`, {}));
      }
      const type = str('type');
      const path = flags.webhooks ? '/webhooks/events' : '/events';
      const data = await control<{ items: { id: string; type: string; occurredAt?: string; createdAt?: string }[] }>('GET', `${path}${type ? `?type=${encodeURIComponent(type)}` : ''}`);
      if (flags.json) return print(data.items);
      for (const e of data.items) console.log(`${e.occurredAt ?? e.createdAt}  ${e.type.padEnd(28)} ${e.id}`);
      if (!data.items.length) console.log('No events yet.');
      return;
    }

    case 'fidelity':
      if (sub !== 'sandbox' && sub !== 'live') throw new Error('Usage: mockrail fidelity sandbox|live');
      return print(await control('POST', '/fidelity', { mode: sub }));

    case 'reset':
      await control('POST', '/reset', {});
      console.log('Sandbox state cleared.');
      return;

    default:
      throw new Error(`Unknown command '${command}'. Run \`mockrail --help\`.`);
  }
}

main().catch((error: unknown) => {
  console.error(`mockrail: ${(error as Error).message}`);
  process.exit(1);
});
