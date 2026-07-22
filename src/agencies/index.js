import { defaultAdapter } from "./_default.js";
import { muniAdapter } from "./muni.js";

/**
 * Only register adapters that need non-default behavior.
 * Everyone else uses _default (Sheet supplies URLs).
 */
const adapters = {
  muni: muniAdapter,
};

/**
 * @param {string} slug
 * @returns {import('./types.js').AgencyAdapter}
 */
export function getAdapter(slug) {
  const key = String(slug || "").toLowerCase();
  if (adapters[key]) return adapters[key];
  return {
    ...defaultAdapter,
    slug: key,
    notes: `Default GTFS-RT matching for "${key}".`,
  };
}

export function listAdapterSlugs() {
  return Object.keys(adapters);
}
