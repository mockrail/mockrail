import { SandboxError, type AuthPolicy, type AuthResult } from '@mockrail/core';
import { BACHS } from './constants.js';

/** `Authorization: Bearer <key>`; only `sk_sandbox_` keys are accepted by a sandbox. */
export const bachsAuth: AuthPolicy = {
  actingAccountHeader: 'x-account-id',
  authenticate(headers): AuthResult {
    const header = headers.authorization;
    if (!header) return deny('Missing Authorization header. Send `Authorization: Bearer sk_sandbox_...`.');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return deny('Malformed Authorization header. Use `Bearer <key>`.');
    const key = match[1];
    if (key.startsWith(BACHS.liveKeyPrefix)) return deny('Live keys (sk_live_) cannot be used against the sandbox. Use an sk_sandbox_ key.');
    if (!key.startsWith(BACHS.sandboxKeyPrefix) || key.length <= BACHS.sandboxKeyPrefix.length) {
      return deny('Invalid API key. Sandbox keys start with sk_sandbox_.');
    }
    return { ok: true, apiKey: key };
  },
};

function deny(message: string): AuthResult {
  return { ok: false, error: new SandboxError('unauthorized', message) };
}
