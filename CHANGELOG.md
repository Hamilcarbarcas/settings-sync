# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **Compare this world against another and pull across the differences.** A **Compare Worlds** button in Configure Settings opens a single window listing every way this world and another disagree — which modules are enabled, and every core, system and module setting — with a checkbox on each difference and one button to apply the ticked ones.
  - **Worlds offer themselves up automatically.** A world cannot read another world's database — Foundry's file server refuses to serve LevelDB files at all — so each world instead publishes a small JSON snapshot of itself into the module's persistent storage on load. The practical effect is that any world you have launched with this module enabled simply appears in the target list, with no export step to remember. Automatic publishing can be turned off, and throttled (default: at most once an hour).
  - **Snapshots are portable.** Export one as a file and import it in a world on a different Foundry install, or someone else's server.
  - **Differences are compared by effective value, not by stored value.** A setting nobody has ever touched has no database record, only a registered default. Comparing records would report a difference every time one world happens to sit at a default, which is most of them; comparing the value `game.settings.get()` would actually return reports only the real ones — and still catches the case where a module changed its *default* between versions and neither world has a record.
  - **Object settings show which keys changed**, not two walls of JSON. A large config object expands into just the leaf paths that differ, old value beside new.
  - **Settings for modules you don't have enabled still sync.** They are written straight to the settings database, and picked up intact when that module first initialises — so enabling a module and importing its configuration in the same batch works in one reload rather than two.
  - **Applying is per-row or wholesale.** "Select all differences" then "Apply selected"; there is deliberately no one-click *Apply all*, so the list of irreversible writes is on screen and ticked before anything runs. A row that fails is reported and skipped without aborting the rest of the batch.
- **World-identity settings are shown but locked.** A handful of settings hold state that belongs to one particular world rather than a preference — the compendium configuration's pack ids, the world clock, migration bookkeeping, the A/V server credentials. These appear in the diff with both values visible and a padlock instead of a checkbox: you can see that the two worlds disagree, but the tool will not copy them.
- **Campaign data kept in settings is locked too.** Some modules store a ledger, an in-progress rest, a tension pool's count or saved encounters as a world setting. These are now padlocked like the world-identity settings, so a sync can't overwrite one world's history with another's.
- **Settings that reference documents are flagged.** Applying replaces a setting's whole value, so syncing a list of actors or users drops entries only this world has. Such rows, detected automatically or from a curated list, get a warning icon and are skipped by the select-all buttons; tick them by hand, and the confirmation names them. Simple Calendar's configuration is flagged too, since it carries the current date.
- **Client-scope settings are labelled honestly.** Foundry stores them in browser localStorage with no world prefix, so every world served from the same address already shares them. That category will always be empty when comparing two worlds on one install — which is correct rather than broken, and the window says so rather than leaving you wondering.
