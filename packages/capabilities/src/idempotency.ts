import { CapabilityConflictError } from './errors.js';

export interface IdempotencyEntry {
  key: string;
  capabilityName: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  result?: any;
  createdAt: number;
}

export class IdempotencyManager {
  private static store = new Map<string, IdempotencyEntry>();
  private static TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  private static makeKey(capabilityName: string, idempotencyKey: string): string {
    return `${capabilityName}:${idempotencyKey}`;
  }

  /**
   * Checks if an idempotency key exists or acquires an in-progress lock.
   * If already completed, returns the cached result.
   * If currently in progress, throws CapabilityConflictError.
   */
  static async checkOrAcquire(
    capabilityName: string,
    idempotencyKey: string,
    correlationId?: string
  ): Promise<{ isDuplicate: boolean; cachedResult?: any }> {
    const compositeKey = this.makeKey(capabilityName, idempotencyKey);
    const existing = this.store.get(compositeKey);

    if (existing) {
      // Check TTL expiry
      if (Date.now() - existing.createdAt > this.TTL_MS) {
        this.store.delete(compositeKey);
      } else if (existing.status === 'COMPLETED') {
        return { isDuplicate: true, cachedResult: existing.result };
      } else if (existing.status === 'IN_PROGRESS') {
        throw new CapabilityConflictError(
          `A request with idempotency key "${idempotencyKey}" is currently being processed.`,
          capabilityName,
          correlationId,
          { idempotencyKey }
        );
      }
    }

    // Acquire lock
    this.store.set(compositeKey, {
      key: idempotencyKey,
      capabilityName,
      status: 'IN_PROGRESS',
      createdAt: Date.now(),
    });

    return { isDuplicate: false };
  }

  /**
   * Saves the result of a completed idempotent execution.
   */
  static async saveResult(
    capabilityName: string,
    idempotencyKey: string,
    result: any
  ): Promise<void> {
    const compositeKey = this.makeKey(capabilityName, idempotencyKey);
    this.store.set(compositeKey, {
      key: idempotencyKey,
      capabilityName,
      status: 'COMPLETED',
      result,
      createdAt: Date.now(),
    });
  }

  /**
   * Releases an in-progress lock upon failure so retries can proceed.
   */
  static async release(capabilityName: string, idempotencyKey: string): Promise<void> {
    const compositeKey = this.makeKey(capabilityName, idempotencyKey);
    this.store.delete(compositeKey);
  }

  /**
   * Clear all records (useful for test isolation).
   */
  static clear(): void {
    this.store.clear();
  }
}
