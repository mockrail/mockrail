import type { IdGenerator } from '../shared/ids.js';
import type { Store } from '../store/store.js';
import type { DomainEvent, DomainEventType } from './domain-event.js';

export const DOMAIN_EVENTS = 'domain_events';

export type DomainEventHandler = (event: DomainEvent) => void;

interface SequenceRecord {
  readonly id: 'event-sequence';
  readonly value: number;
}

/**
 * Core modules publish domain events here. Events are stored, then handed to subscribers
 * synchronously (the webhook dispatcher is one subscriber).
 */
export class EventBus {
  private readonly handlers = new Set<DomainEventHandler>();

  constructor(
    private readonly store: Store,
    private readonly ids: IdGenerator,
    private readonly nowIso: () => string,
  ) {}

  publish<T extends object>(type: DomainEventType, ownerId: string, data: T): DomainEvent<T> {
    const event: DomainEvent<T> = {
      id: this.ids.next('dev'),
      type,
      occurredAt: this.nowIso(),
      ownerId,
      sequence: this.nextSeq(),
      data,
    };
    this.store.put(DOMAIN_EVENTS, event);
    for (const handler of this.handlers) {
      try {
        handler(event as DomainEvent);
      } catch (error) {
        console.error(`[mockrail] event handler failed for ${type}:`, error);
      }
    }
    return event;
  }

  subscribe(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  list(filter?: { readonly type?: string; readonly ownerId?: string }): DomainEvent[] {
    return this.store
      .list<DomainEvent>(DOMAIN_EVENTS, (e) => (!filter?.type || e.type === filter.type) && (!filter?.ownerId || e.ownerId === filter.ownerId))
      .sort((a, b) => a.sequence - b.sequence);
  }

  get(id: string): DomainEvent | undefined {
    return this.store.get<DomainEvent>(DOMAIN_EVENTS, id);
  }

  private nextSeq(): number {
    const current = this.store.get<SequenceRecord>('meta', 'event-sequence')?.value ?? 0;
    this.store.put<SequenceRecord>('meta', { id: 'event-sequence', value: current + 1 });
    return current + 1;
  }
}
