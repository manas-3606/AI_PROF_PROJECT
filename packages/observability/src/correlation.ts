import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  operationId?: string;
  tenantId?: string;
  actorId?: string;
  actorRole?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return asyncLocalStorage.getStore() || {
    correlationId: crypto.randomUUID(),
  };
}

export function getCorrelationId(): string {
  return getRequestContext().correlationId;
}
