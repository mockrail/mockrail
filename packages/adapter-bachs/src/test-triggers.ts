import { createHash } from 'node:crypto';
import type { CurrencyCode, FailureReason, FeeRule, PaymentMethod, PayoutDestination, ScenarioOutcome, SimulatedPayment, SimulatedPaymentInput } from '@mockrail/core';
import { COLLECTION_FEES, PAYOUT_TRIGGERS, SAVE_THEN_DECLINE_CARD, TEST_CARDS } from './constants.js';

function digitsOf(cardNumber: string | undefined): string {
  return (cardNumber ?? '4242424242424242').replace(/\D/g, '');
}

/** Card number -> forced outcome for this charge. Any number not listed succeeds. */
export function outcomeForCard(cardNumber: string | undefined): ScenarioOutcome | undefined {
  if (!cardNumber) return undefined;
  const card = TEST_CARDS.find((c) => c.number === digitsOf(cardNumber));
  return card ? { kind: 'fail', reason: card.reason as FailureReason } : undefined;
}

/** Outcome of later off-session charges on a saved card (4000 0000 0000 0341 saves, then declines). */
export function futureOutcomeForCard(cardNumber: string | undefined): ScenarioOutcome | undefined {
  return digitsOf(cardNumber) === SAVE_THEN_DECLINE_CARD ? { kind: 'fail', reason: 'declined' } : outcomeForCard(cardNumber);
}

export function cardPaymentMethod(cardNumber: string | undefined, currency?: string): PaymentMethod {
  const digits = digitsOf(cardNumber);
  return {
    type: 'card',
    last4: digits.slice(-4).padStart(4, '0'),
    brand: brandFor(digits),
    fingerprint: createHash('sha256').update(digits).digest('hex').slice(0, 16),
    expMonth: 12,
    expYear: 2030,
    ...(currency ? { currency } : {}),
  };
}

function brandFor(digits: string): string {
  if (digits.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'mastercard';
  if (/^50|^6[05]/.test(digits)) return 'verve';
  if (/^3[47]/.test(digits)) return 'amex';
  return 'unknown';
}

/** Documented processing fee for a collection method, or null when the docs give none. */
export function collectionFee(method: PaymentMethod['type'], currency: CurrencyCode): FeeRule | null {
  if (method === 'bank_transfer' && currency === 'NGN') return COLLECTION_FEES.NGN_BANK_TRANSFER ?? null;
  if (method === 'card' && currency === 'NGN') return COLLECTION_FEES.NGN_CARD ?? null;
  return null;
}

/** Withdrawal triggers from the Connect testing page; undefined means "no trigger, use scenarios". */
export function outcomeForDestination(destination: PayoutDestination): ScenarioOutcome | undefined {
  if (destination.type === 'bank') {
    const { bankComplete, bankFail } = PAYOUT_TRIGGERS;
    if (destination.bankCode === bankComplete.bankCode && destination.accountNumber === bankComplete.accountNumber) return { kind: 'succeed' };
    if (destination.bankCode === bankFail.bankCode && destination.accountNumber === bankFail.accountNumber) return { kind: 'fail', reason: 'bank_rejected' };
  }
  if (destination.type === 'crypto') {
    const address = destination.walletAddress?.toLowerCase();
    if (address === PAYOUT_TRIGGERS.cryptoComplete) return { kind: 'succeed' };
    if (address === PAYOUT_TRIGGERS.cryptoFail) return { kind: 'fail', reason: 'invalid_destination' };
  }
  return undefined;
}

/** Hosted checkout page input -> payment method, forced outcomes and fee. */
export function simulateBachsPayment(input: SimulatedPaymentInput, context: { readonly currency: CurrencyCode; readonly amountMinor: bigint }): SimulatedPayment {
  const feeRule = collectionFee(input.method, context.currency);
  switch (input.method) {
    case 'card': {
      const outcome = outcomeForCard(input.cardNumber);
      const future = futureOutcomeForCard(input.cardNumber);
      return {
        paymentMethod: cardPaymentMethod(input.cardNumber, context.currency),
        feeRule,
        ...(outcome ? { outcomeOverride: outcome } : {}),
        ...(future ? { futureOutcome: future } : {}),
      };
    }
    case 'crypto': {
      const paid = input.amountPaidMinor;
      const outcome: ScenarioOutcome | undefined =
        paid !== undefined && paid !== context.amountMinor ? { kind: 'partial', receivedAmount: { amountMinor: paid, currency: context.currency } } : undefined;
      return { paymentMethod: { type: 'crypto', network: 'TRC20', asset: 'USDT' }, feeRule, ...(outcome ? { outcomeOverride: outcome } : {}) };
    }
    case 'bank_transfer':
      return {
        paymentMethod: { type: 'bank_transfer', senderName: 'SANDBOX CUSTOMER', senderAccountNumber: '0123456789', senderBankName: 'Sandbox Sender Bank', senderBankCode: '000', sessionId: null, narration: null },
        feeRule,
      };
    case 'mobile_money':
      return { paymentMethod: { type: 'mobile_money', phone: '+233240000000', provider: 'MTN' }, feeRule };
  }
}
