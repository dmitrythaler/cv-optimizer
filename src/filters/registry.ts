import type { Filter } from './base.ts';

const registry: Filter[] = [];

/** Register a filter. Lower `priority` runs first. */
export const register = (filter: Filter): void => {
  if (registry.some((f) => f.name === filter.name)) {
    throw new Error(`duplicate filter name: ${filter.name}`);
  }
  registry.push(filter);
  registry.sort((a, b) => a.priority - b.priority);
};

export const all = (): readonly Filter[] => registry;
