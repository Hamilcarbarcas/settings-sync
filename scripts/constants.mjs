/**
 * Shared identifiers and the curated key lists.
 * See DESIGN.md §5 — the three arrays below are meant to be edited by hand when a key
 * turns up in the field that belongs on one of them.
 */

export const MODULE_ID = "settings-sync";

/** Persistent-storage folder the snapshots live in, relative to the "data" source. */
export const STORAGE_DIR = `modules/${MODULE_ID}/storage`;

/** Bumped only when the snapshot shape changes incompatibly. */
export const SNAPSHOT_FORMAT = 1;

export const SETTINGS = {
  autoPublish: "autoPublish",
  publishInterval: "publishIntervalMinutes"
};

/**
 * World-identity settings. Shown in the diff with both values, never appliable.
 * @type {string[]}
 */
export const BLOCKED_KEYS = [
  "core.moduleConfiguration",      // is the Modules category; a second copy would race it
  "core.compendiumConfiguration",  // pack ids, including world-local packs
  "core.time",                     // the world clock
  "core.systemMigrationVersion",   // copying it makes the system skip or redo migrations
  "core.rtcWorldSettings"          // holds A/V server credentials
];

/**
 * Same treatment as BLOCKED_KEYS, matched against the full "namespace.key" id.
 * @type {RegExp[]}
 */
export const BLOCKED_PATTERNS = [
  /(migration|schema)version$/i    // any package's own migration bookkeeping
];

/**
 * Appliable, but hidden until "Show noise" is ticked. Churn nobody wants to read past.
 * @type {RegExp[]}
 */
export const NOISE_PATTERNS = [
  /^core\.tourProgress$/,
  /^core\.nue\./,
  /version$/i
];

/** Row states. See DESIGN.md §4.2. */
export const ROW_STATE = {
  same: "same",
  differs: "differs",
  onlyHere: "only-here",
  onlyThere: "only-there"
};

/** Category ids, in display order. */
export const CATEGORY = {
  modules: "modules",
  core: "core",
  system: "system",
  module: "module",
  user: "user",
  client: "client"
};

/** Sentinel for "this side has no effective value at all". */
export const ABSENT = Symbol("absent");
