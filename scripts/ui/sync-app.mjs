/**
 * The Settings Sync window. See DESIGN.md §8.
 *
 * There is deliberately no one-click "Apply all": the pair of buttons is
 * "Select all differences" then "Apply selected", so the list of irreversible writes is
 * visible and ticked before anything runs. Same code path, one extra click.
 */

import { CATEGORY, MODULE_ID, ROW_STATE } from "../constants.mjs";
import { buildDiff } from "../diff.mjs";
import { applyRows } from "../apply.mjs";
import {
  captureSnapshot, exportSnapshot, importSnapshotFile, listSnapshots, publishSnapshot
} from "../snapshot.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default class SettingsSyncApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** Snapshots found in the shared store, plus any imported this session. */
  #snapshots = [];

  /** World id of the currently selected target, or null. */
  #targetId = null;

  /** The current comparison, or null. */
  #diff = null;

  /** Row ids the user has ticked. */
  #selected = new Set();

  /** Category keys the user has collapsed. */
  #collapsed = new Set();

  /** Row ids whose leaf-diff is expanded. */
  #expanded = new Set();

  #filters = { search: "", identical: false, blocked: true, noise: false };

  #loading = true;

  #status = null;

  /* -------------------------------------------- */

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "settings-sync-app",
    classes: ["settings-sync"],
    window: {
      title: "SETTINGS_SYNC.Title",
      icon: "fa-solid fa-right-left",
      resizable: true
    },
    position: { width: 820, height: 760 },
    actions: {
      refresh: SettingsSyncApp.#onRefresh,
      publish: SettingsSyncApp.#onPublish,
      exportSnapshot: SettingsSyncApp.#onExport,
      importSnapshot: SettingsSyncApp.#onImport,
      toggleCategory: SettingsSyncApp.#onToggleCategory,
      toggleDetail: SettingsSyncApp.#onToggleDetail,
      selectCategory: SettingsSyncApp.#onSelectCategory,
      selectAll: SettingsSyncApp.#onSelectAll,
      clearSelection: SettingsSyncApp.#onClearSelection,
      apply: SettingsSyncApp.#onApply
    }
  };

  /** @override */
  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/sync-app.hbs`,
      // The template renders a toolbar, a scrolling body and a footer as siblings. Without
      // `root`, HandlebarsApplicationMixin requires a part to produce exactly one element;
      // with it, the children are spliced straight into `.window-content`, which is what
      // the stylesheet's flex column expects.
      root: true,
      scrollable: [".ss-scroll"]
    }
  };

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /** Reload the snapshot list from the shared store, preserving anything imported. */
  async loadSnapshots() {
    this.#loading = true;
    const imported = this.#snapshots.filter(s => s.__imported);
    const stored = await listSnapshots();
    this.#snapshots = [...stored, ...imported];
    if ( !this.#snapshots.some(s => s.world.id === this.#targetId) ) {
      this.#targetId = this.#snapshots[0]?.world.id ?? null;
    }
    this.#rebuild();
    this.#loading = false;
  }

  /** Recompute the comparison against the selected target. */
  #rebuild() {
    const target = this.#snapshots.find(s => s.world.id === this.#targetId);
    this.#diff = target ? buildDiff(captureSnapshot(), target) : null;
    // Drop selections whose rows no longer exist.
    if ( this.#diff ) {
      const live = new Set(this.#diff.rows.map(r => r.id));
      for ( const id of this.#selected ) if ( !live.has(id) ) this.#selected.delete(id);
    }
    else this.#selected.clear();
  }

  /** Rows that survive the current filters. */
  #visibleRows(rows) {
    const search = this.#filters.search.toLowerCase();
    return rows.filter(row => {
      if ( !this.#filters.identical && (row.state === ROW_STATE.same) ) return false;
      if ( !this.#filters.blocked && row.blocked ) return false;
      if ( !this.#filters.noise && row.noise ) return false;
      if ( search && !`${row.label} ${row.key}`.toLowerCase().includes(search) ) return false;
      return true;
    });
  }

  /** @override */
  async _prepareContext(options) {
    const diff = this.#diff;

    const targets = this.#snapshots.map(s => ({
      id: s.world.id,
      label: s.__imported
        ? game.i18n.format("SETTINGS_SYNC.ImportedTarget", { world: s.world.title })
        : s.world.title,
      selected: s.world.id === this.#targetId
    }));

    const context = {
      loading: this.#loading,
      status: this.#status,
      filters: this.#filters,
      targets,
      hasTargets: targets.length > 0,
      diff: null,
      categories: [],
      selectedCount: this.#selected.size,
      differenceCount: 0
    };

    if ( !diff ) return context;

    const remote = diff.remote;
    const capturedAt = new Date(remote.capturedAt);
    context.diff = {
      worldTitle: remote.world.title,
      system: remote.world.systemTitle ?? remote.world.system,
      systemVersion: remote.world.systemVersion,
      coreVersion: remote.world.coreVersion,
      capturedAbsolute: capturedAt.toLocaleString(),
      capturedRelative: SettingsSyncApp.#relativeTime(remote.capturedAt),
      capturedBy: remote.capturedBy,
      imported: !!remote.__imported,
      warnings: SettingsSyncApp.#warnings(diff)
    };

    context.categories = diff.categories.map(cat => {
      const key = `${cat.id}|${cat.key ?? ""}`;
      const rows = this.#visibleRows(cat.rows).map(row => ({
        ...row,
        selected: this.#selected.has(row.id),
        expanded: this.#expanded.has(row.id),
        blockedText: row.blockedReason ? game.i18n.localize(row.blockedReason) : null,
        cautionText: row.cautionReason ? game.i18n.localize(row.cautionReason) : null,
        noteTexts: (row.notes ?? []).map(n => game.i18n.localize(n)),
        stateLabel: game.i18n.localize(`SETTINGS_SYNC.State.${row.state}`)
      }));
      return {
        key,
        id: cat.id,
        label: cat.label,
        note: cat.note,
        warning: cat.warning,
        differences: cat.differences,
        collapsed: this.#collapsed.has(key),
        selectable: rows.some(r => r.appliable && !r.caution),
        rows,
        empty: rows.length === 0,
        hidden: (rows.length === 0) && (cat.differences > 0)
      };
      // A category with differences but nothing visible is kept, showing "filtered out", so
      // a filter can never silently hide the fact that the two worlds disagree there.
      // The client category is always kept, because its emptiness is itself the point (§4.5).
    }).filter(cat => !cat.empty || (cat.differences > 0) || (cat.id === CATEGORY.client));

    context.differenceCount = diff.rows.filter(r => r.appliable).length;
    return context;
  }

  /* -------------------------------------------- */

  static #warnings(diff) {
    const out = [];
    if ( diff.systemMismatch ) {
      out.push(game.i18n.format("SETTINGS_SYNC.Warning.SystemMismatch",
        { here: diff.local.world.system, there: diff.remote.world.system }));
    }
    else if ( diff.systemVersionMismatch ) {
      out.push(game.i18n.format("SETTINGS_SYNC.Warning.SystemVersion",
        { here: diff.local.world.systemVersion, there: diff.remote.world.systemVersion }));
    }
    if ( diff.coreVersionMismatch ) {
      out.push(game.i18n.format("SETTINGS_SYNC.Warning.CoreVersion",
        { here: diff.local.world.coreVersion, there: diff.remote.world.coreVersion }));
    }
    return out;
  }

  static #relativeTime(timestamp) {
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    const formatter = new Intl.RelativeTimeFormat(game.i18n.lang, { numeric: "auto" });
    const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
    for ( const [unit, size] of units ) {
      if ( Math.abs(seconds) >= size ) return formatter.format(-Math.round(seconds / size), unit);
    }
    return formatter.format(-seconds, "second");
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;

    root.querySelector("[data-control=target]")?.addEventListener("change", event => {
      this.#targetId = event.currentTarget.value;
      this.#selected.clear();
      this.#rebuild();
      this.render();
    });

    root.querySelector("[data-control=search]")?.addEventListener("input",
      foundry.utils.debounce(event => {
        this.#filters.search = event.target.value;
        this.render();
      }, 200));

    for ( const input of root.querySelectorAll("[data-filter]") ) {
      input.addEventListener("change", event => {
        this.#filters[event.currentTarget.dataset.filter] = event.currentTarget.checked;
        this.render();
      });
    }

    for ( const input of root.querySelectorAll(".ss-check") ) {
      input.addEventListener("change", event => {
        const id = event.currentTarget.dataset.rowId;
        if ( event.currentTarget.checked ) this.#selected.add(id);
        else this.#selected.delete(id);
        this.#refreshFooter();
      });
    }

    root.querySelector("[data-control=file]")?.addEventListener("change", async event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if ( !file ) return;
      try {
        const snapshot = await importSnapshotFile(file);
        this.#snapshots = [...this.#snapshots.filter(s => s.world.id !== snapshot.world.id), snapshot];
        this.#targetId = snapshot.world.id;
        this.#selected.clear();
        this.#rebuild();
        this.#status = game.i18n.format("SETTINGS_SYNC.Notify.Imported", { world: snapshot.world.title });
      }
      catch(err) {
        ui.notifications.error(err.message);
      }
      this.render();
    });
  }

  /** Update the footer counts without a full re-render, so ticking a box stays cheap. */
  #refreshFooter() {
    const el = this.element?.querySelector("[data-control=selected-count]");
    if ( el ) el.textContent = String(this.#selected.size);
    const apply = this.element?.querySelector("[data-action=apply]");
    if ( apply ) apply.disabled = this.#selected.size === 0;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onRefresh() {
    this.#status = null;
    await this.loadSnapshots();
    this.render();
  }

  static async #onPublish() {
    try {
      await publishSnapshot({ notify: true });
      await this.loadSnapshots();
    }
    catch(err) {
      ui.notifications.error(err.message);
    }
    this.render();
  }

  static #onExport() {
    exportSnapshot();
  }

  static #onImport() {
    this.element.querySelector("[data-control=file]")?.click();
  }

  static #onToggleCategory(event, target) {
    const key = target.closest("[data-category-key]").dataset.categoryKey;
    if ( this.#collapsed.has(key) ) this.#collapsed.delete(key);
    else this.#collapsed.add(key);
    this.render();
  }

  static #onToggleDetail(event, target) {
    const id = target.closest("[data-row-id]").dataset.rowId;
    if ( this.#expanded.has(id) ) this.#expanded.delete(id);
    else this.#expanded.add(id);
    this.render();
  }

  static #onSelectCategory(event, target) {
    const key = target.closest("[data-category-key]").dataset.categoryKey;
    const category = this.#diff?.categories.find(c => `${c.id}|${c.key ?? ""}` === key);
    if ( !category ) return;
    const rows = this.#visibleRows(category.rows).filter(r => r.appliable && !r.caution);
    const allSelected = rows.every(r => this.#selected.has(r.id));
    for ( const row of rows ) {
      if ( allSelected ) this.#selected.delete(row.id);
      else this.#selected.add(row.id);
    }
    this.render();
  }

  static #onSelectAll() {
    for ( const row of this.#diff?.rows ?? [] ) if ( row.appliable && !row.caution ) this.#selected.add(row.id);
    this.render();
  }

  static #onClearSelection() {
    this.#selected.clear();
    this.render();
  }

  static async #onApply(event, target) {
    const rows = (this.#diff?.rows ?? []).filter(r => this.#selected.has(r.id) && r.appliable);
    if ( !rows.length ) return;

    let content = `<p>${game.i18n.format("SETTINGS_SYNC.Confirm.Body", {
      count: rows.length,
      world: this.#diff.remote.world.title
    })}</p>`;
    const flagged = rows.filter(r => r.caution);
    if ( flagged.length ) {
      const items = flagged.map(r => `<li>${foundry.utils.escapeHTML(r.label)}</li>`).join("");
      content += `<p>${game.i18n.localize("SETTINGS_SYNC.Confirm.Caution")}</p><ul>${items}</ul>`;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SETTINGS_SYNC.Confirm.Title") },
      content,
      yes: { label: game.i18n.localize("SETTINGS_SYNC.Apply") },
      modal: true
    });
    if ( !confirmed ) return;

    target.disabled = true;
    const { applied, failed } = await applyRows(rows);
    target.disabled = false;

    for ( const row of applied ) this.#selected.delete(row.id);
    this.#status = failed.length
      ? game.i18n.format("SETTINGS_SYNC.Notify.AppliedWithErrors", { applied: applied.length, failed: failed.length })
      : game.i18n.format("SETTINGS_SYNC.Notify.Applied", { applied: applied.length });

    if ( failed.length ) {
      for ( const f of failed ) ui.notifications.error(`${f.row.key}: ${f.error}`);
    }

    this.#rebuild();
    this.render();
  }

  /* -------------------------------------------- */

  /**
   * The entry point. Snapshots are loaded *before* the first render because
   * `_prepareContext` runs ahead of `_preFirstRender`, so loading in that hook would
   * always paint one empty frame first.
   * @returns {Promise<SettingsSyncApp>}
   */
  static async open() {
    const app = foundry.applications.instances.get("settings-sync-app") ?? new this();
    await app.loadSnapshots();
    return app.render({ force: true });
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Fallback for anyone who constructs and renders directly rather than via open().
    if ( this.#loading ) {
      await this.loadSnapshots();
      this.render();
    }
  }
}
