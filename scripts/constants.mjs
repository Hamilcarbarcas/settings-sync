/**
 * Shared identifiers and the curated key lists.
 * See DESIGN.md §5 — the lists below are meant to be edited by hand when a key
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
 * Campaign data kept in a setting. Locked like BLOCKED_KEYS. §5.1.
 * @type {string[]}
 */
export const WORLD_STATE_KEYS = [
  "astora-mod.activeRest",
  "astora-mod.activeRestId",
  "astora-mod.activeSofMessageId",
  "astora-mod.currency-ledger-data",
  "astora-mod.lastRest",
  "astora-mod.roll-checks-characters",
  "astora-mod.roll-checks-data",
  "astora-mod.roll-checks-snapshot",
  "astora-mod.tension-pool-data",
  "astora-mod.tension-scale",
  "find-the-culprit.data",
  "moulinette.session_ID",
  "moulinette-navigation-tools.currentFolder",
  "pf1-token-randomizer.encounters"
];

/**
 * Appliable, but flagged and skipped by the select-all buttons. Value is the reason id,
 * `SETTINGS_SYNC.Caution.<reason>`. Settings that reference documents in this world are also
 * flagged automatically. §5.2.
 * @type {Record<string, string>}
 */
export const CAUTION_KEYS = {
  "astora-mod.currency-ledger-whitelist": "documentIds",
  "astora-mod.rest-exclude": "documentIds",
  "astora-mod.rest-restricted": "documentIds",
  "astora-mod.tokenBarPresenceIgnoredUsers": "documentIds",
  "item-piles.defaultItemPileActorID": "documentIds",
  "LockView.userSettings": "documentIds",
  "monks-common-display.playerdata": "documentIds",
  "pf1-roll-requests.npc-blacklist": "documentIds",
  "foundryvtt-simple-calendar.calendar-configuration": "currentDate",
  "foundryvtt-simple-calendar-reborn.calendar-configuration": "currentDate"
};

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
