/**
 * Capturing, publishing and loading world snapshots. See DESIGN.md §3.
 *
 * The one rule that governs this file: setting values are carried as their raw JSON
 * *source strings*, never as parsed values. `Setting#value` is a JSONField, and writing a
 * parsed value back through it is not symmetric — `_cast()` passes a valid JSON string
 * through untouched but `JSON.stringify`s anything else, so the string value `"true"`
 * would come back as the boolean `true`. Strings end to end make the round trip exact.
 */

import { MODULE_ID, STORAGE_DIR, SNAPSHOT_FORMAT } from "./constants.mjs";

/** @returns {typeof foundry.applications.apps.FilePicker} */
function filePicker() {
  return foundry.applications.apps.FilePicker.implementation;
}

/**
 * The stored filename for a world's snapshot.
 *
 * The prefix is not decoration. `Files.upload` refuses to overwrite a file named
 * `world.json`, `module.json`, `system.json` or `template.json` regardless of MIME type,
 * so a world whose id happened to be one of those four would publish once and then fail
 * on every republish. Prefixing puts the name permanently out of that set.
 *
 * @param {string} worldId
 * @returns {string}
 */
function snapshotFilename(worldId) {
  return `snapshot-${worldId}.json`;
}

/* -------------------------------------------- */
/*  Capture                                     */
/* -------------------------------------------- */

/**
 * Serialize a registered setting's default to a JSON source string.
 * Defaults can be DataModel instances, which do not survive JSON.stringify intact.
 * @param {*} value
 * @returns {string|null}
 */
function serializeDefault(value) {
  if ( value === undefined ) return null;
  try {
    return JSON.stringify(value?.toObject instanceof Function ? value.toObject() : value);
  }
  catch(err) {
    return null;
  }
}

/**
 * Describe the settings registered in this world, so that another world can render a
 * readable label — and a default — for settings belonging to modules it does not have.
 * @returns {Record<string, object>}
 */
function captureRegistry() {
  const registry = {};
  for ( const [id, data] of game.settings.settings.entries() ) {
    registry[id] = {
      name: data.name ? game.i18n.localize(data.name) : null,
      hint: data.hint ? game.i18n.localize(data.hint) : null,
      scope: data.scope,
      config: !!data.config,
      type: data.type?.name ?? data.type?.constructor?.name ?? null,
      requiresReload: !!data.requiresReload,
      default: serializeDefault(data.default)
    };
  }
  return registry;
}

/**
 * Client-scope settings are read through the registry rather than by walking localStorage,
 * because localStorage also holds a good deal that is not a setting. The cost is that
 * client settings belonging to modules disabled here are not captured, which is the safe
 * direction to be wrong in.
 * @returns {Record<string, string>}
 */
function captureClientSettings() {
  const out = {};
  const storage = game.settings.storage.get(CONST.SETTING_SCOPES.CLIENT);
  for ( const [id, data] of game.settings.settings.entries() ) {
    if ( data.scope !== CONST.SETTING_SCOPES.CLIENT ) continue;
    const raw = storage.getItem(id);
    if ( raw !== null ) out[id] = raw;
  }
  return out;
}

/**
 * Build a snapshot of the currently running world.
 * @returns {object}
 */
export function captureSnapshot() {
  const moduleConfiguration = game.settings.get("core", "moduleConfiguration") ?? {};

  const modules = {};
  for ( const mod of game.modules ) {
    modules[mod.id] = {
      enabled: moduleConfiguration[mod.id] ?? false,
      version: mod.version ?? null,
      title: mod.title ?? mod.id
    };
  }
  // Modules configured in this world but no longer installed still belong in the map, so
  // the other side can tell "disabled" from "gone".
  for ( const [id, enabled] of Object.entries(moduleConfiguration) ) {
    if ( !(id in modules) ) modules[id] = { enabled, version: null, title: id, uninstalled: true };
  }

  const settings = {};
  const userSettings = {};
  for ( const doc of game.settings.storage.get(CONST.SETTING_SCOPES.WORLD) ) {
    const raw = doc._source.value;
    if ( raw === null || raw === undefined ) continue;
    if ( doc.user === null ) settings[doc.key] = raw;
    else if ( doc.user === game.userId ) userSettings[doc.key] = raw;
    // Other users' user-scope settings are deliberately dropped: user ids are per-world,
    // so the only mapping that means anything is "the human at the keyboard". §4.4.
  }

  return {
    format: SNAPSHOT_FORMAT,
    capturedAt: Date.now(),
    capturedBy: game.user?.name ?? null,
    world: {
      id: game.world.id,
      title: game.world.title,
      system: game.system.id,
      systemTitle: game.system.title,
      systemVersion: game.system.version,
      coreVersion: game.version
    },
    modules,
    settings,
    userSettings,
    clientSettings: captureClientSettings(),
    registry: captureRegistry()
  };
}

/* -------------------------------------------- */
/*  The snapshot store                          */
/* -------------------------------------------- */

/** Ensure the persistent-storage folder exists. Harmless if it already does. */
async function ensureStorage() {
  try {
    await filePicker().createDirectory("data", STORAGE_DIR);
  }
  catch(err) {
    // "EEXIST" is the expected path on every call after the first.
    if ( !/exist/i.test(err.message) ) throw err;
  }
}

/**
 * Write this world's snapshot into the shared store.
 * @param {object} [options]
 * @param {boolean} [options.notify=false]  Show a UI notification on success.
 * @returns {Promise<object>} The snapshot that was written.
 */
export async function publishSnapshot({ notify = false } = {}) {
  if ( !game.user.isGM ) throw new Error("Only a GM can publish a settings snapshot.");
  const snapshot = captureSnapshot();
  const filename = snapshotFilename(game.world.id);
  const json = JSON.stringify(snapshot);
  const file = new File([json], filename, { type: "application/json" });

  await ensureStorage();

  // The second argument is the destination *directory* relative to the package's storage
  // folder, not the filename — `Files.upload` joins `file.name` onto the target itself.
  // Passing a filename here makes the server look for a directory by that name.
  const result = await filePicker().uploadPersistent(MODULE_ID, "", file, {}, { notify: false });

  // `FilePicker.upload` does not throw on a server-side failure: it notifies and returns
  // `false`, `undefined`, or `{}` depending on how it failed. Only a returned `path` means
  // the file actually landed, so anything else has to be turned back into an exception or
  // callers will report success over a failed write.
  if ( !result?.path ) {
    throw new Error(game.i18n.format("SETTINGS_SYNC.Error.PublishFailed", { file: filename }));
  }

  if ( notify ) {
    ui.notifications.info(game.i18n.format("SETTINGS_SYNC.Notify.Published", { world: game.world.title }));
  }
  return snapshot;
}

/**
 * Every snapshot in the shared store, this world's own excluded.
 * Snapshots are few and small enough to fetch eagerly; a separate index file would only
 * add a thing that can go stale.
 * @returns {Promise<object[]>}
 */
export async function listSnapshots() {
  let listing;
  try {
    listing = await filePicker().browse("data", STORAGE_DIR, { extensions: [".json"] });
  }
  catch(err) {
    return [];   // Folder does not exist yet — nothing has ever been published.
  }

  const snapshots = [];
  for ( const path of listing.files ?? [] ) {
    if ( !path.endsWith(".json") ) continue;
    try {
      const response = await foundry.utils.fetchWithTimeout(`${path}?t=${Date.now()}`);
      const snapshot = await response.json();
      if ( !validateSnapshot(snapshot) ) continue;
      if ( snapshot.world.id === game.world.id ) continue;
      snapshot.__path = path;
      snapshots.push(snapshot);
    }
    catch(err) {
      console.error(`${MODULE_ID} | could not read snapshot ${path}`, err);
    }
  }
  snapshots.sort((a, b) => a.world.title.localeCompare(b.world.title));
  return snapshots;
}

/**
 * @param {object} snapshot
 * @returns {boolean} Whether this looks like a snapshot this version can read.
 */
export function validateSnapshot(snapshot) {
  return !!snapshot
    && (snapshot.format === SNAPSHOT_FORMAT)
    && !!snapshot.world?.id
    && !!snapshot.settings
    && !!snapshot.registry;
}

/** When this world last published itself, or 0. */
export async function ownSnapshotAge() {
  try {
    const listing = await filePicker().browse("data", STORAGE_DIR, { extensions: [".json"] });
    const own = (listing.files ?? []).find(p => p.endsWith(`/${snapshotFilename(game.world.id)}`));
    if ( !own ) return Infinity;
    const response = await foundry.utils.fetchWithTimeout(`${own}?t=${Date.now()}`);
    const snapshot = await response.json();
    return Date.now() - (snapshot.capturedAt ?? 0);
  }
  catch(err) {
    return Infinity;
  }
}

/* -------------------------------------------- */
/*  Portable files                              */
/* -------------------------------------------- */

/** Hand the current world's snapshot to the browser as a download. */
export function exportSnapshot(snapshot = captureSnapshot()) {
  const stamp = new Date(snapshot.capturedAt).toISOString().slice(0, 10);
  foundry.utils.saveDataToFile(
    JSON.stringify(snapshot, null, 2),
    "application/json",
    `${snapshot.world.id}-settings-${stamp}.json`
  );
}

/**
 * Read a snapshot from a user-selected file. Held in memory for the session; publishing it
 * into the shared store is a separate, deliberate act.
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function importSnapshotFile(file) {
  const text = await file.text();
  const snapshot = JSON.parse(text);
  if ( !validateSnapshot(snapshot) ) {
    throw new Error(game.i18n.localize("SETTINGS_SYNC.Error.BadSnapshot"));
  }
  snapshot.__imported = true;
  return snapshot;
}
