import type { BrokerBackend } from "./backend";

const g = globalThis as unknown as { __rcBrokerCache?: Map<string, BrokerBackend> };

export function brokerCache(): Map<string, BrokerBackend> {
  if (g.__rcBrokerCache === undefined) g.__rcBrokerCache = new Map();
  return g.__rcBrokerCache;
}

export function evictBackend(name: string): void {
  brokerCache().delete(name);
}
