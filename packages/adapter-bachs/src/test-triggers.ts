import { createHash } from 'node:crypto';
import type { CurrencyCode, FailureReason, PaymentMethod, PayoutDestination, ScenarioOutcome, SimulatedPayment, SimulatedPaymentInput } from '@mockrail/core';
import { PAYOUT_TRIGGERS, TEST_CARDS } from './constants.js';

/** Card number -> forced outcome. Any number not listed succeeds. */
export function outcomeForCard(cardNumber: string | undefined): ScenarioOutcome | undefined {
  if (!cardNumber) return undefined;
  const digits = cardNumber.replace(/\D/g, '');
  const card = TEST_CARDS.find((c) => c.number === digits);
  return card ? { kind: 'fail', reason: card.reason as FailureReason } : undefined;
}

export function cardPaymentMethod(cardNumber: string | undefined): PaymentMethod {
  const digits = (cardNumber ?? '4242424242424242').replace(/\D/g, '');
  return {
    type: 'card',
    last4: digits.slice(-4).padStart(4, '0'),
    brand: brandFor(digits),
    fingerprint: createHash('sha256').update(digits).digest('hex').slice(0, 16),
  };
}

function brandFor(digits: string): string {
  if (digits.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'mastercard';
  if (/^50|^6[05]/.test(digits)) return 'verve';
  if (/^3[47]/.test(digits)) return 'amex';
  return 'unknown';
}

/** Withdrawal triggers from the Connect testing page; undefined means "no trigger, use scenarios". */
export function outcomeForDestination(destination: PayoutDestination): ScenarioOutcome | undefined {
  if (destination.type === 'bank') {
    const { bankComplete, bankFail } = PAYOUT_TRIGGERS;
    if (destination.bankCode === bankComplete.bankCode && destination.accountNumber === bankComplete.accountNumber) return { kind: 'succeed' };
    if (destination.bankCode === bankFail.bankCode && destination.accountNumber === bankFail.accountNumber) return { kind: 'fail', reason: 'bank_rejected' };
  }
  if (destination.type === 'crypto') {
    const address = destination.cryptoAddress?.toLowerCase();
    if (address === PAYOUT_TRIGGERS.cryptoComplete) return { kind: 'succeed' };
    if (address === PAYOUT_TRIGGERS.cryptoFail) return { kind: 'fail', reason: 'invalid_destination' };
  }
  return undefined;
}

/** Hosted checkout page input -> payment method and forced outcome. */
export function simulateBachsPayment(input: SimulatedPaymentInput, context: { readonly currency: CurrencyCode; readonly amountMinor: bigint }): SimulatedPayment {
  switch (input.method) {
    case 'card': {
      const outcome = outcomeForCard(input.cardNumber);
      return { paymentMethod: cardPaymentMethod(input.cardNumber), ...(outcome ? { outcomeOverride: outcome } : {}) };
    }
    case 'crypto': {
      const paid = input.amountPaidMinor;
      const outcome: ScenarioOutcome | undefined =
        paid !== undefined && paid !== context.amountMinor ? { kind: 'partial', receivedAmount: { amountMinor: paid, currency: context.currency } } : undefined;
      return { paymentMethod: { type: 'crypto', network: 'sandbox', asset: 'USDT' }, ...(outcome ? { outcomeOverride: outcome } : {}) };
    }
    case 'bank_transfer':
      return { paymentMethod: { type: 'bank_transfer', senderName: 'Sandbox Customer', senderAccountNumber: '0123456789', senderBankName: 'Sandbox Sender Bank' } };
    case 'mobile_money':
      return { paymentMethod: { type: 'mobile_money', phone: '+2348000000000', provider: 'sandbox' } };
  }
}
