import { formatDecimal, type CheckoutSession, type TestCard } from '@mockrail/core';

/** Provider corridor codes (e.g. NGN_BANK_TRANSFER) -> page payment methods. */
function methodsFor(corridors: readonly string[]): string[] {
  const methods = corridors.map((c) => (c.endsWith('_CARD') ? 'card' : c.endsWith('BANK_TRANSFER') ? 'bank_transfer' : c.startsWith('MOMO_') ? 'mobile_money' : c === 'CRYPTO' ? 'crypto' : c.toLowerCase()));
  return methods.length ? [...new Set(methods)] : ['card'];
}

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Simulated hosted checkout page. Posts to the control plane, which pays the session. */
export function renderCheckoutPage(input: {
  readonly session: CheckoutSession;
  readonly providerId: string;
  readonly providerName: string;
  readonly testCards: readonly TestCard[];
}): string {
  const { session } = input;
  const amount = `${session.amount.currency} ${formatDecimal(session.amount.amountMinor, session.amount.currency)}`;
  const title = session.lineItems.map((l) => (l.quantity > 1 ? `${l.productName} x${l.quantity}` : l.productName)).join(', ') || 'Payment';
  const methods = methodsFor(session.paymentMethodTypes);
  const trial = session.lineItems.find((l) => l.recurring?.trial)?.recurring?.trial;
  const cards = input.testCards
    .map((c) => `<li><button type="button" class="link" data-card="${escape(c.number)}">${escape(c.number)}</button> ${escape(c.description)}</li>`)
    .join('');
  const closed = session.status !== 'open';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.providerName)} sandbox checkout</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#dfe2e7; --accent:#1f6feb; --bad:#c62828; --good:#1b7f3b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --text:#e8eaee; --muted:#9aa1ad; --line:#2a2f38; --accent:#5b9dff; --bad:#ff6b6b; --good:#4cc47a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--text); display:grid; place-items:center; min-height:100vh; padding:16px; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  .badge { display:inline-block; font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 10px; color:var(--muted); }
  h1 { font-size:20px; margin:12px 0 4px; }
  .amount { font-size:28px; font-weight:650; margin:0 0 20px; font-variant-numeric: tabular-nums; }
  label { display:block; font-size:14px; color:var(--muted); margin:12px 0 4px; }
  input, select { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  button.pay { width:100%; margin-top:20px; padding:12px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button.pay:disabled { opacity:.6; cursor:default; }
  button.link { background:none; border:0; padding:0; color:var(--accent); font:inherit; font-family:ui-monospace, monospace; cursor:pointer; }
  details { margin-top:20px; font-size:14px; color:var(--muted); }
  ul { padding-left:18px; margin:8px 0 0; }
  #result { margin-top:16px; font-size:14px; min-height:1.5em; }
  .bad { color:var(--bad); } .good { color:var(--good); }
</style>
</head>
<body>
<main>
  <span class="badge">${escape(input.providerName)} sandbox &middot; mockrail</span>
  <h1>${escape(title)}</h1>
  <p class="amount">${escape(amount)}</p>
  ${trial ? `<p>Free trial for ${trial.intervalCount} ${escape(trial.interval)}${trial.intervalCount > 1 ? 's' : ''}. Your card is saved, not charged.</p>` : ''}
  ${
    closed
      ? `<p>This checkout session is <strong>${escape(session.status)}</strong>.</p>`
      : `<form id="pay">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="${escape(session.customerDetails?.email ?? session.customerEmail ?? '')}" placeholder="customer@example.com">
    <label for="method">Payment method</label>
    <select id="method" name="method">${methods.map((m) => `<option value="${escape(m)}">${escape(m.replace('_', ' '))}</option>`).join('')}</select>
    <div id="card-fields">
      <label for="card">Card number</label>
      <input id="card" name="card" inputmode="numeric" autocomplete="off" value="4242 4242 4242 4242">
    </div>
    <div id="crypto-fields" hidden>
      <label for="paid">Amount sent (${escape(session.amount.currency)}), leave empty for exact</label>
      <input id="paid" name="paid" inputmode="decimal" placeholder="${escape(formatDecimal(session.amount.amountMinor, session.amount.currency))}">
    </div>
    <button class="pay" type="submit">Pay ${escape(amount)}</button>
  </form>
  <div id="result" role="status"></div>
  ${cards ? `<details><summary>Test cards</summary><ul>${cards}</ul><p>Any other number succeeds.</p></details>` : ''}`
  }
</main>
<script>
  const form = document.getElementById('pay');
  if (form) {
    const method = document.getElementById('method');
    const sync = () => {
      document.getElementById('card-fields').hidden = method.value !== 'card';
      document.getElementById('crypto-fields').hidden = method.value !== 'crypto';
    };
    method.addEventListener('change', sync); sync();
    document.querySelectorAll('[data-card]').forEach((b) => b.addEventListener('click', () => {
      method.value = 'card'; sync(); document.getElementById('card').value = b.dataset.card;
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = document.getElementById('result');
      const button = form.querySelector('button');
      button.disabled = true; result.className = ''; result.textContent = 'Processing...';
      const res = await fetch(location.pathname + '/pay', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: ${JSON.stringify(input.providerId)}, method: method.value,
          card_number: document.getElementById('card').value, amount_paid: document.getElementById('paid').value || undefined,
          email: document.getElementById('email').value || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { result.className = 'bad'; result.textContent = data.error || 'Payment failed'; button.disabled = false; return; }
      result.className = 'good';
      result.textContent = data.charge ? 'Payment submitted. It finalizes in about a second.' : 'Checkout completed.';
      const success = ${JSON.stringify(session.successUrl)};
      if (success) setTimeout(() => { location.href = success; }, 1500);
    });
  }
</script>
</body>
</html>`;
}
