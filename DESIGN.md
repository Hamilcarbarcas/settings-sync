# settings-sync — Design

**Status:** design locked, implementation in progress.
**Last revised:** 2026-08-28.

Source of truth. Update this file when decisions change; rejected alternatives live in
Appendix A so the body stays readable. Appendix B lists the core-source facts this design
rests on, with file references, so they can be re-checked against a new Foundry release.

---

## 1. The whole thing in one page

**A world cannot read another world's database. So each world writes a JSON snapshot of
itself to a shared location, and comparison is always "current live world vs. a snapshot".**

```
World B  ──publish──▶  Data/modules/settings-sync/storage/<worldId>.json
                                          │
World A  ──────────────────────────────read
         │
         ▼
   diff(local, snapshot) ──▶ rows ──▶ apply selected ──▶ current world
```

Four consequences follow from that one shape, and they define the whole mod:

| Consequence | Where it's handled |
| --- | --- |
| Comparison is **pull-only** — you can never write into a world that isn't running | §7 |
| The target is **point-in-time**, not live; staleness must be visible | §3.4 |
| A world only appears as a target if it has run once with this mod on | §3.3 auto-publish |
| Anything not in the snapshot can't be compared | §3.2 what is captured |

The comparison itself is not a document diff. It compares **effective values** — the value
`game.settings.get()` would return, which is the stored value if a `Setting` document exists
and the *registered default* if one does not (§4.1). Diffing raw documents instead would
report a difference every time one world happens to sit at a default, which is most of them.

---

## 2. Why a snapshot, and not just reading the other world

A world's settings live at `Data/worlds/<id>/data/settings/` as a LevelDB directory. Two
independent walls stand between a running client and that directory:

**The server refuses to serve it.** Foundry's static middleware rejects, with a bare
`403 Forbidden`, any request whose basename matches `*.db`, `NNNNNN.ldb`, `NNNNNN.log`,
`MANIFEST-NNNNNN`, `CURRENT`, `LOCK`, `LOG`, or `LOG.old` — checked *before* any of the
`express.static` mounts, so it covers the whole user-data tree
(`dist/server/express.mjs`, the private `#t` router). There is no client-side route around
a server-side 403.

**Nothing client-side can open LevelDB anyway.** Even with the bytes in hand, a browser
would need an SSTable reader plus Snappy plus write-ahead-log replay to read a database the
running server may be mid-write on.

A module is client-side code. Both walls are server-side. So the data has to be *put*
somewhere readable by a process that already has it — which is the world itself, while it
runs. That is the snapshot.

---

## 3. Snapshots

### 3.1 Where they live

`Data/modules/settings-sync/storage/snapshot-<worldId>.json`, written with
`FilePicker.uploadPersistent("settings-sync", …, file)` and read back with
`FilePicker.browse("data", "modules/settings-sync/storage")` plus a plain `fetch`.

The `snapshot-` prefix is load-bearing, not decoration. `Files.upload` allows an overwrite
only for a media MIME type — `application/json` qualifies, since `MEDIA_FILE_CATEGORIES`
includes `TEXT` — *except* for four reserved names: `world.json`, `module.json`,
`system.json`, `template.json`. A world whose id was one of those four would publish once
and then fail on every republish. The prefix puts the filename permanently outside that set.

This location is chosen over `Data/settings-sync/` for three reasons: `persistentStorage:
true` in the manifest makes Foundry preserve it across module updates; it is outside every
world, so all worlds on the install see the same set; and `.json` is not on the 403 list, so
`fetch` works.

> **Repo note.** The live module directory is a symlink into this workspace, so `storage/`
> materialises *inside the git repo*. It is in `.gitignore`.

### 3.2 What a snapshot contains

```jsonc
{
  "format": 1,
  "capturedAt": 1756400000000,
  "capturedBy": "Patrick",
  "world":   { "id", "title", "system", "systemVersion", "coreVersion" },
  "modules": { "<moduleId>": { "enabled": bool, "version": "1.2.0", "title": "…" } },
  "settings": {                          // world scope
    "<ns>.<key>": "<raw JSON source string>"
  },
  "userSettings": { "<ns>.<key>": "<raw JSON source string>" },   // capturing user only
  "clientSettings": { "<ns>.<key>": "<raw JSON source string>" },
  "registry": {                          // every setting registered in that world
    "<ns>.<key>": { "name", "hint", "scope", "config", "type", "requiresReload",
                    "default": "<raw JSON source string>" }
  }
}
```

Two details are load-bearing:

**Values are stored as raw JSON *strings*, never as parsed values.** `Setting#value` is a
`JSONField`, whose `initialize()` returns the parsed value while `_source.value` holds the
string. `JSONField#_cast` is *not* symmetric: it passes a valid JSON string through
untouched but `JSON.stringify`s anything else — so handing `Setting.create()` the *parsed*
value of a setting whose content is the string `"true"` stores the boolean `true`. That is
precisely the direct-document path §7.1 uses for unregistered keys, so carrying the source
string end to end is what makes the round trip exact. (The `game.settings.set()` path is
safe either way: `ClientSettings##cleanJSON` stringifies before the field ever sees it.)

**The registry is captured too**, not just the values. It is what lets this world render a
readable label and a default for a setting belonging to a module it does not have enabled —
and it is half of the effective-value comparison in §4.1.

### 3.3 Auto-publish

On `ready`, if the current user is a GM and the world's snapshot is missing or older than
the throttle interval (world setting, default 1 hour), the mod republishes it. This is what
makes the target list populate itself: any world you have launched with the mod enabled is
a target, with no ritual. A manual **Publish now** button covers the impatient case.

Auto-publish can be turned off; the mod then only ever writes a snapshot when asked.

### 3.4 Staleness and portability

The window header always states the snapshot's capture time in both absolute and relative
form, because a snapshot is a photograph and acting on a stale one is the main way this tool
can mislead.

Snapshots are also **exportable and importable as files** (`saveDataToFile` /
`<input type="file">`), which is the path to a different Foundry install or someone else's
server. An imported snapshot is held in memory for the session and can be published into the
local store if you want to keep it.

---

## 4. The comparison model

### 4.1 Effective values

For a key `k`, on each side:

```
effective(k) = document(k) exists ? document(k).value
             : registry(k) exists ? registry(k).default
             : ABSENT
```

Rows are built from `effective(here)` vs `effective(there)`, and compared with a
deep, key-order-insensitive equality (`foundry.utils.objectsEqual` for objects,
`===` otherwise).

This resolves the two failure modes of a naive document diff:

- *False positives.* World A has never touched `pf1.diagonalMovement`, so it has no document;
  world B set it once and set it back. Documents differ, effective values do not. No row.
- *True positives a document diff misses.* A module changed its default between versions and
  neither world has a document. Effective values differ. Row.

`ABSENT` on one side only happens for a setting registered in neither world — an orphan
document from an uninstalled module. Those still diff, on the raw document, and still apply.

### 4.2 Row states and what applying one means

| State | Meaning | Apply action |
| --- | --- | --- |
| `differs` | both sides have an effective value; they are not equal | write the target's value |
| `only-there` | target has a value; here it resolves to `ABSENT` | write the target's value |
| `only-here` | here has a value; target resolves to `ABSENT` | delete the local `Setting` document |
| `same` | equal | none — hidden unless **Show identical** |

`only-here` deserves a note: for a *registered* setting this is the ordinary case of "the
other world is at default", and deleting the document is exactly how you match it — the row
is labelled **Unset** rather than "Delete" for that reason. For an orphan it means removing
a stranded document, which is also right.

### 4.3 Categories

1. **Modules** — derived from `core.moduleConfiguration`, a `{moduleId: bool}` map. Rows are
   module ids, not settings; applying them accumulates into one write of that map (§7.2).
   A module enabled in the target but not installed here is shown and **not appliable** —
   you cannot enable what isn't on disk.
2. **Core** — namespace `core`.
3. **System** — namespace `game.system.id`. If the snapshot's system differs from this
   world's, the whole category is shown collapsed and blocked, with the mismatch stated.
4. **Modules' settings** — one group per namespace, ordered by module title, with unknown
   namespaces grouped last under their raw id and marked *not installed*.
5. **User (yours)** — user-scope settings. See §4.4.
6. **Client (per browser)** — client-scope settings. See §4.5.

### 4.4 User scope is remapped, not matched

User-scope settings are `Setting` documents carrying a `user` foreign key. User ids are
per-world, so the target world's user ids mean nothing here. The only defensible mapping is
one-to-one on the human at the keyboard: the snapshot captures **only the capturing user's**
user-scope settings, and applying writes them to **the current user**. The category header
says so.

### 4.5 Client scope is shared, and the UI must say so

`game.settings.storage` maps client scope to raw `window.localStorage`, keyed
`namespace.key` with no world prefix (`client/helpers/client-settings.mjs`). Every world
served from the same origin therefore *already shares* client settings — a same-install
comparison will show this category empty, always, and that is correct rather than broken.

The category is still built, because across installs it is real, and it carries a permanent
warning line: applying a client row changes that setting for every world in this browser.

---

## 5. The blocklist

Some settings are world *identity*, not preference. Copying them does damage that looks like
a bug days later. These are **visible in the diff, with both values shown, and can never be
selected or applied** — a padlock instead of a checkbox. Visibility without a trigger: you
can see that two worlds differ there and go fix it deliberately somewhere else.

Blocked by exact key:

| Key | Why |
| --- | --- |
| `core.moduleConfiguration` | is the Modules category; a second appliable copy of it would race |
| `core.compendiumConfiguration` | pack ids, including world-local packs that don't exist here |
| `core.time` | the world clock |
| `core.systemMigrationVersion` | copying it makes the system skip or redo migrations |
| `core.rtcWorldSettings` | holds A/V server credentials |

Blocked by pattern:

| Pattern | Why |
| --- | --- |
| `/(migration\|schema)version$/i` | same reason as `core.systemMigrationVersion`, for any package |

Separately, a **noise list** — `core.tourProgress`, `core.nue.*`, and anything matching
`/version$/i` that isn't already blocked — is *appliable* but hidden behind **Show noise**,
because it is churn nobody wants to read past.

The lists live as three exported arrays at the top of `scripts/constants.mjs`, commented, so
adding a key found in the field is a one-line edit.

**Known limitation, stated rather than papered over:** a setting belonging to some module
that stores document IDs in its value cannot be detected automatically, and will be offered
as appliable. The blocklist is a curated list, not an analysis.

---

## 6. Value rendering

Primitives render inline: `false → true`.

Objects and arrays render as a one-line summary plus an expandable body. The body is **not**
two pretty-printed blobs side by side — it is a leaf-path diff, built by flattening both
sides with `foundry.utils.flattenObject` and listing only the paths that changed:

```
  ▾ pf1.experienceConfig                          3 of 11 keys differ
      track            "medium"  →  "fast"
      disableExperienceTracking   true  →  false
      custom.formula   ""  →  "@level * 100"
```

Large PF1 and core config objects are the normal case here, so this is the difference
between a usable row and a wall of JSON.

---

## 7. Applying

### 7.1 Writing one setting

```
registered here?
  yes → game.settings.set(ns, key, parsed)      // validates, fires onChange
        or, for an `only-here` row, delete the Setting document
  no  → Setting document CRUD with the raw source string
        (key validation is only `key.split(".").length >= 2`, so orphan keys are writable)
```

`game.settings.set()` refuses an unregistered key, which is exactly the case for a module
that isn't enabled here — hence the direct-document path. Registration does not overwrite an
existing document, so writing a disabled module's settings now and enabling it afterwards
leaves the written values intact.

### 7.2 Order of operations

1. **Settings first**, so that any module being enabled in the same batch initialises against
   its synced values on the reload rather than one reload later.
2. **`core.moduleConfiguration` once**, as a single merged write of every selected module row.
3. **Then the reload prompt.**

Reload is required if any applied row's registration carries `requiresReload`, or if any
module row was applied at all. It is raised once, at the end, through
`foundry.applications.settings.SettingsConfig.reloadConfirm({world: true})` — the same prompt
core uses, so a world reload propagates to connected players.

### 7.3 Failure handling

Each row is applied independently inside a `try`. A row that throws is marked failed, keeps
its checkbox, and the batch continues; the summary at the end reports applied/failed counts
and the failures stay on screen with their error. One bad module setting must not abort
thirty good ones.

### 7.4 Permissions

GM only, throughout. Writing settings needs `SETTINGS_MODIFY`; `core.permissions` needs a
full GM; publishing a snapshot needs `FILES_UPLOAD`. The menu is registered with
`restricted: true` and every entry point re-checks `game.user.isGM`.

---

## 8. UI

One `ApplicationV2` + `HandlebarsApplicationMixin` window, reached from a
`game.settings.registerMenu` entry in Configure Settings.

```
┌ Settings Sync ────────────────────────────────────────────────────────────┐
│ Compare with [ NAWC D&D — 27 Aug, 14:02 ▾ ]  ⟳ Refresh  ⤒ Import  ⤓ Export │
│ pf1 11.11 · Foundry 13.351 · captured 2 days ago                          │
│ ⚠ System version differs: 11.10 there, 11.11 here                         │
├───────────────────────────────────────────────────────────────────────────┤
│ [search…]      ☐ identical   ☐ blocked   ☐ noise                          │
│                                                                            │
│ ▾ Modules · 4 differences                                        [all]     │
│    ☑ PF1 Lighting              off → on                                    │
│    ☐ Monk's Little Details     on  → off                                   │
│    🔒 Some Mod                  —   → on        not installed here          │
│ ▾ Core · 7                                                       [all]     │
│    ☑ Left-Click to Release Objects       false → true                      │
│    🔒 core.compendiumConfiguration        {…} → {…}   world-specific        │
│ ▸ System — Pathfinder 1e · 12                                              │
│ ▸ PF1 Lighting · 3                                                         │
│ ▸ Client — per browser · 0    ⚠ shared by every world in this browser      │
├───────────────────────────────────────────────────────────────────────────┤
│ 12 of 34 selected          [Select all differences]  [Apply selected]      │
└───────────────────────────────────────────────────────────────────────────┘
```

**Apply all** is deliberately *not* a separate button. It is **Select all differences**
followed by **Apply selected** — the same code path, with the selection visible before it
runs. "Apply all" as a one-click action on a screen containing thirty irreversible writes is
a trap; making the user look at the ticked list first costs one click and prevents the whole
class of accident.

All CSS is scoped under `.settings-sync`; no bare element or utility selectors, because
module CSS is unlayered and outranks core's `@layer`s.

---

## 9. Build order

1. `constants.mjs`, `module.json`, manifest with `persistentStorage`, settings + menu registration.
2. `snapshot.mjs` — capture, publish, list, load, import, export. Verifiable on its own by
   publishing and reading back a snapshot.
3. `diff.mjs` — effective values, categories, row states. Pure functions over two snapshots
   (the local side is just `captureSnapshot()`), so it is testable from the console.
4. `apply.mjs` — the write paths, ordering, reload prompt.
5. `ui/sync-app.mjs` + template + CSS.
6. README, CHANGELOG, release workflow.

---

## Appendix A — rejected alternatives

**Read the target world's LevelDB over HTTP.** Dead at the server: §2. Even if the 403 list
were narrower, it would mean shipping an SSTable reader and a Snappy decompressor to the
browser and replaying a write-ahead log, to read a database that may be open for writing.

**A companion Node CLI, like `pack-tools`.** It *could* read both worlds' LevelDB directly
and produce a true live-to-live diff. Rejected because applying the result still has to
happen inside the running world — a CLI can only write to a world that is *not* running, and
you would be alternating between a terminal and two Foundry restarts to do what the snapshot
approach does in one window. Worth revisiting only if a use case appears that is
read-and-report rather than read-and-apply.

**A shared `Data/settings-sync/` folder instead of module persistent storage.** Works, but
loses the update-survival guarantee that `persistentStorage` gives for free, and puts a
stray directory in the user-data root.

**Diffing `Setting` documents rather than effective values.** Rejected in §4.1: it reports a
difference every time one world sits at a default, which drowns the real ones.

**A hard-blocklist that hides the blocked rows entirely.** Rejected in favour of
visible-but-locked. Knowing that two worlds disagree about their compendium configuration is
useful information even when the fix has to happen elsewhere.

**Pushing into the target world.** Impossible by construction — a snapshot is a file, and the
world it describes is not running. Stated here because it is the first thing anyone asks.

---

## Appendix B — verified against Foundry v13.351

| Fact | Source |
| --- | --- |
| `*.db`, `*.ldb`, `NNNNNN.log`, `MANIFEST-*`, `CURRENT`, `LOCK`, `LOG`, `LOG.old` are 403'd before all static mounts | `dist/server/express.mjs`, private `#t` |
| Enabled modules are the `core.moduleConfiguration` setting | `client/applications/sidebar/apps/module-management.mjs:26` |
| Client scope is raw `window.localStorage`, no world prefix; user scope shares the world store | `client/helpers/client-settings.mjs:42-46` |
| `Setting#value` is parsed, `_source.value` is the JSON string; `_cast` stringifies non-JSON input | `common/data/fields.mjs` `JSONField`, `common/documents/setting.mjs:45` |
| `Setting#key` validation is only `key.split(".").length >= 2` | `common/documents/setting.mjs:42-44` |
| `core.permissions` is full-GM-only to modify | `common/documents/setting.mjs` `#GAMEMASTER_ONLY_KEYS` |
| `FilePicker.uploadPersistent(pkgId, path, file)` targets `data/modules/<id>/storage/` and requires `persistentStorage`. Its `path` is a destination **directory**, not a filename — `Files.upload` joins `file.name` on itself | `client/applications/apps/file-picker.mjs:505`, `dist/files/files.mjs` `Files.upload` |
| `FilePicker.upload` never throws on a server error — it notifies and returns `false`, `undefined`, or `{}`. Only a returned `path` means the write landed | `client/applications/apps/file-picker.mjs:449-490` |
| `requiresReload` is a registration field; world vs. client reload split | `client/applications/settings/config.mjs:247-248` |
