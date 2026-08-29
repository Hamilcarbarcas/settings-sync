/**
 * settings-sync — compare this world against a snapshot of another and pull the
 * differences across. See DESIGN.md for the whole design; the short version is that a
 * world cannot read another world's LevelDB (the server 403s it), so every world publishes
 * a JSON snapshot of itself and comparison is always live-world vs. snapshot.
 */

import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { buildDiff } from "./diff.mjs";
import { applyRows } from "./apply.mjs";
import {
  captureSnapshot, exportSnapshot, importSnapshotFile, listSnapshots, ownSnapshotAge, publishSnapshot
} from "./snapshot.mjs";
import SettingsSyncApp from "./ui/sync-app.mjs";

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "open", {
    name: "SETTINGS_SYNC.Menu.Name",
    label: "SETTINGS_SYNC.Menu.Label",
    hint: "SETTINGS_SYNC.Menu.Hint",
    icon: "fa-solid fa-right-left",
    type: SettingsSyncApp,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.autoPublish, {
    name: "SETTINGS_SYNC.Setting.AutoPublish.Name",
    hint: "SETTINGS_SYNC.Setting.AutoPublish.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.publishInterval, {
    name: "SETTINGS_SYNC.Setting.PublishInterval.Name",
    hint: "SETTINGS_SYNC.Setting.PublishInterval.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, step: 5, integer: true, initial: 60 }),
    default: 60
  });
});

Hooks.once("ready", async () => {
  game.settingsSync = {
    open: () => SettingsSyncApp.open(),
    captureSnapshot,
    publishSnapshot,
    listSnapshots,
    importSnapshotFile,
    exportSnapshot,
    buildDiff,
    applyRows,
    app: SettingsSyncApp
  };

  if ( !game.user.isGM ) return;
  if ( !game.settings.get(MODULE_ID, SETTINGS.autoPublish) ) return;

  // Auto-publish is what makes the target list populate itself: every world you have
  // launched with this module on becomes a comparison target, with no ritual. §3.3
  const intervalMs = game.settings.get(MODULE_ID, SETTINGS.publishInterval) * 60_000;
  try {
    if ( (await ownSnapshotAge()) < intervalMs ) return;
    await publishSnapshot();
    console.error(`${MODULE_ID} | published a snapshot of "${game.world.title}"`);
  }
  catch(err) {
    console.error(`${MODULE_ID} | auto-publish failed`, err);
  }
});
