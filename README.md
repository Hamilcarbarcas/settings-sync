# Settings Sync

A Foundry VTT module for people who run more than one world and are tired of hand-copying
configuration between them.

Pick another world, see every way it differs from this one — which modules are enabled, and
every core, system and module setting — and pull across the differences, all of them or one
at a time.

System-agnostic. Foundry v13.

---

## Using it

**Configure Settings → Settings Sync → Compare Worlds.** GM only.

1. Choose a world from **Compare with**.
2. Read the differences, grouped into Modules, Core, System, and one group per module.
3. Tick what you want, or press **Select All Differences**.
4. **Apply Selected**.

Foundry will offer to reload when a change needs it.

### Where the target worlds come from

A running world cannot read another world's database — Foundry's file server refuses to
serve database files, by design. So each world publishes a small JSON snapshot of itself
instead, and the comparison is always *this live world* against *a snapshot of that one*.

Publishing happens on its own: when a world loads with this module enabled, it writes its
snapshot (at most once an hour by default). **So a world appears in the list once you have
launched it with Settings Sync on.** There is a **Publish now** button (📷) for when you
have just changed something and want the snapshot to catch up.

Two things follow from this that are worth knowing up front:

- **The comparison only goes one way.** You can pull the other world's settings into this
  one. You can never push into a world that isn't running.
- **A snapshot is a photograph.** Its age is shown in the header; hover for the exact time.

### Moving between installs

The 📤 button downloads this world's snapshot as a file, and 📥 imports one. That is the
path to a different Foundry install, or to someone else's server.

---

## What it compares

| Group | What's in it |
| --- | --- |
| **Modules** | Which modules are enabled. A module enabled there but not installed here is shown and locked — install it first. |
| **Core** | Foundry's own settings. |
| **System** | Your game system's settings. Locked entirely if the two worlds run different systems. |
| **One group per module** | Including modules that aren't enabled here — their settings are written directly and picked up when the module first loads. |
| **User — yours** | User-scope settings. User ids are per-world, so these are the snapshotting user's, applied to you. |
| **Client — per browser** | See the note below. |

Differences are worked out from **effective values** — what `game.settings.get()` would
actually return, falling back to the registered default where a world has never touched a
setting. Comparing stored records instead would flag a difference every time one world sat
at a default, which is most of them.

### Locked settings

A few settings hold state belonging to one particular world rather than a preference.
They're shown, with both values, and cannot be applied:

- `core.compendiumConfiguration` — pack ids, including packs local to that world
- `core.time` — the world clock
- `core.systemMigrationVersion`, and anything else ending in a migration or schema version
- `core.rtcWorldSettings` — audio/video server credentials
- `core.moduleConfiguration` — that's the Modules group; change it there

Campaign data that a module happens to keep in a setting is locked the same way: a currency
ledger, an in-progress rest, a tension pool's current count, saved encounters tied to scenes.
Copying any of these would overwrite this world's history with the other world's.

### Flagged settings

Applying a setting replaces its whole value; nothing is merged. For a setting that holds a
list of actors, users or scenes, that means entries only this world has are lost. These rows
can still be applied, since worlds cloned from one another share document ids, but they carry
a warning icon and are **skipped by both select-all buttons**, so each one has to be ticked by
hand. The confirmation lists any you ticked.

A row is flagged when:

- either world's value references a document in this world, by id or UUID (detected
  automatically); or
- it's on the curated list, which covers id lists whose ids exist only in the other world,
  and Simple Calendar's calendar configuration, which carries the current date inside it.

All of these lists live as commented constants at the top of `scripts/constants.mjs`, so
adding a key is a one-line edit.

### Client settings will look empty, and that's correct

Foundry keeps client-scope settings in browser `localStorage`, keyed without any world
prefix. Every world served from the same address therefore already shares them — so
comparing two worlds on one install will always show that group empty. It's only meaningful
across installs, which is why the group exists at all. Applying a row there changes that
setting for *every* world in this browser.

---

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Publish this world automatically** | on | Write this world's snapshot on load, so other worlds can compare against it. Off means a world only becomes a target when you publish it by hand. |
| **Minimum minutes between snapshots** | 60 | Skip the automatic publish if the snapshot is newer than this. 0 publishes on every load. |

---

## API

`game.settingsSync` exposes the pieces, for macros and console work:

```js
game.settingsSync.open();                       // the window
await game.settingsSync.publishSnapshot();      // publish this world now
const targets = await game.settingsSync.listSnapshots();
const diff = game.settingsSync.buildDiff(game.settingsSync.captureSnapshot(), targets[0]);
diff.rows.filter(r => r.state !== "same");      // everything that differs
await game.settingsSync.applyRows(rows);        // apply a chosen subset
```

`buildDiff` is a pure function over two snapshots, so the whole comparison can be inspected
from the console without opening anything.

---

## Design

[`DESIGN.md`](DESIGN.md) is the source of truth — why it works this way, what was rejected,
and the Foundry core behaviour it relies on, with file references so it can be re-checked
against a new release.

## License

[GPL-3.0](LICENSE)
