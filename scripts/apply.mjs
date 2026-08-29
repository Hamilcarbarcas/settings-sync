/**
 * Writing the selected differences into this world. See DESIGN.md §7.
 *
 * Ordering matters: settings are written before `core.moduleConfiguration`, so that a
 * module enabled in the same batch initialises against its synced values on the reload
 * rather than one reload later. Registration never overwrites an existing document, so a
 * value written now for a currently-disabled module survives its first init.
 */

import { CATEGORY, MODULE_ID } from "./constants.mjs";

/**
 * Write one setting row.
 * @param {object} row
 */
async function applySettingRow(row) {
  const separator = row.key.indexOf(".");
  const namespace = row.key.slice(0, separator);
  const key = row.key.slice(separator + 1);
  const config = game.settings.settings.get(row.key);

  // --- Registered here: go through the settings API, which validates and fires onChange.
  if ( config ) {
    if ( row.unsets ) return unsetRegistered(row, config);
    // `game.settings.set` stringifies the value itself (ClientSettings##cleanJSON), so
    // handing it the parsed form is exact — unlike a raw document write.
    return game.settings.set(namespace, key, JSON.parse(row.applyRaw));
  }

  // --- Not registered here (a disabled or uninstalled module's setting). Write the raw
  // JSON source string straight to storage; `Setting#key` validation is only
  // "at least one dot", so orphan keys are perfectly writable.
  if ( row.scope === "client" ) {
    const storage = game.settings.storage.get(CONST.SETTING_SCOPES.CLIENT);
    if ( row.unsets ) storage.removeItem(row.key);
    else storage.setItem(row.key, row.applyRaw);
    return;
  }

  const user = row.scope === "user" ? game.userId : null;
  const doc = game.settings.storage.get(CONST.SETTING_SCOPES.WORLD).getSetting(row.key, user);

  if ( row.unsets ) return doc?.delete();
  if ( doc ) return doc.update({ value: row.applyRaw });
  return foundry.documents.Setting.implementation.create({ key: row.key, user, value: row.applyRaw });
}

/**
 * Match "the other world is at its default" by removing the local document.
 * Deleting a Setting has no `_onDelete` hook in core, so the registration's onChange has to
 * be fired by hand or listeners would never learn the value moved.
 */
async function unsetRegistered(row, config) {
  if ( config.scope === CONST.SETTING_SCOPES.CLIENT ) {
    game.settings.storage.get(CONST.SETTING_SCOPES.CLIENT).removeItem(row.key);
  }
  else {
    const user = config.scope === CONST.SETTING_SCOPES.USER ? game.userId : null;
    await game.settings.storage.get(CONST.SETTING_SCOPES.WORLD).getSetting(row.key, user)?.delete();
  }
  if ( config.onChange instanceof Function ) {
    try {
      config.onChange(config.default, {});
    }
    catch(err) {
      console.error(`${MODULE_ID} | onChange threw after unsetting ${row.key}`, err);
    }
  }
}

/**
 * Apply a set of rows, one at a time, so that one bad write cannot abort thirty good ones.
 * @param {object[]} rows
 * @param {object} [options]
 * @param {boolean} [options.reload=true]  Raise core's reload prompt when anything applied
 *                                         needs it.
 * @returns {Promise<{applied: object[], failed: Array<{row: object, error: string}>}>}
 */
export async function applyRows(rows, { reload = true } = {}) {
  if ( !game.user.isGM ) throw new Error("Only a GM can apply settings.");

  const settingRows = rows.filter(r => r.appliable && (r.category !== CATEGORY.modules));
  const moduleRows = rows.filter(r => r.appliable && (r.category === CATEGORY.modules));

  const applied = [];
  const failed = [];
  let requiresReload = false;

  for ( const row of settingRows ) {
    try {
      await applySettingRow(row);
      applied.push(row);
      requiresReload ||= row.requiresReload;
    }
    catch(err) {
      console.error(`${MODULE_ID} | failed to apply ${row.key}`, err);
      failed.push({ row, error: err.message });
    }
  }

  // One merged write of the module map, rather than one per module.
  if ( moduleRows.length ) {
    try {
      const configuration = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration") ?? {});
      for ( const row of moduleRows ) configuration[row.key] = row.enable;
      await game.settings.set("core", "moduleConfiguration", configuration);
      applied.push(...moduleRows);
      requiresReload = true;
    }
    catch(err) {
      console.error(`${MODULE_ID} | failed to write module configuration`, err);
      for ( const row of moduleRows ) failed.push({ row, error: err.message });
    }
  }

  if ( reload && requiresReload && applied.length ) {
    foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true });
  }

  return { applied, failed };
}
