export interface StoreRecord {
  readonly id: string;
}

export interface StoreSnapshot {
  readonly collections: Readonly<Record<string, readonly StoreRecord[]>>;
}

/**
 * Collection-based record store. Records are cloned on the way in and out,
 * so callers can never mutate stored state by accident.
 */
export interface Store {
  get<T extends StoreRecord>(collection: string, id: string): T | undefined;
  put<T extends StoreRecord>(collection: string, record: T): T;
  delete(collection: string, id: string): boolean;
  list<T extends StoreRecord>(collection: string, filter?: (record: T) => boolean): T[];
  snapshot(): StoreSnapshot;
  restore(snapshot: StoreSnapshot): void;
  clear(): void;
  close(): void;
}

export class MemoryStore implements Store {
  protected collections = new Map<string, Map<string, StoreRecord>>();

  private bucket(collection: string): Map<string, StoreRecord> {
    let map = this.collections.get(collection);
    if (!map) {
      map = new Map();
      this.collections.set(collection, map);
    }
    return map;
  }

  get<T extends StoreRecord>(collection: string, id: string): T | undefined {
    const record = this.collections.get(collection)?.get(id);
    return record ? (structuredClone(record) as T) : undefined;
  }

  put<T extends StoreRecord>(collection: string, record: T): T {
    this.bucket(collection).set(record.id, structuredClone(record));
    return record;
  }

  delete(collection: string, id: string): boolean {
    return this.collections.get(collection)?.delete(id) ?? false;
  }

  list<T extends StoreRecord>(collection: string, filter?: (record: T) => boolean): T[] {
    const map = this.collections.get(collection);
    if (!map) return [];
    const out: T[] = [];
    for (const record of map.values()) {
      const typed = record as T;
      if (!filter || filter(typed)) out.push(structuredClone(typed));
    }
    return out;
  }

  snapshot(): StoreSnapshot {
    const collections: Record<string, StoreRecord[]> = {};
    for (const [name, map] of this.collections) {
      collections[name] = [...map.values()].map((r) => structuredClone(r));
    }
    return { collections };
  }

  restore(snapshot: StoreSnapshot): void {
    this.collections = new Map();
    for (const [name, records] of Object.entries(snapshot.collections)) {
      const map = this.bucket(name);
      for (const record of records) map.set(record.id, structuredClone(record));
    }
  }

  clear(): void {
    this.collections = new Map();
  }

  close(): void {
    // nothing to release
  }
}
