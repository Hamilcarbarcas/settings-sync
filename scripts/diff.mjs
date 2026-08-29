/**
 * The comparison engine. See DESIGN.md §4.
 *
 * Pure functions over two snapshots — the live side is just `captureSnapshot()` — so the
 * whole thing can be exercised from the console without opening the window.
 */

import {
  ABSENT, BLOCKED_KEYS, BLOCKED_PATTERNS, CATEGORY, NOISE_PATTERNS, ROW_STATE
} from "./constants.mjs";

/* -------------------------------------------- */
/*  Value handling                              */
/* -------------------------------------------- */

/**
 * A canonical, key-order-insensitive serialization, used both to compare values and to
 * key them. Object key order varies freely between two worlds that hold the same value.
 * @param {*} value
 * @returns {string}
 */
function canonical(value) {
  if ( Array.isArray(value) ) return `[${value.map(canonical).join(",")}]`;
  if ( value && (typeof value === "object") ) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @param {string} raw  A JSON source string.
 * @returns {{ok: boolean, value: *}}
 */
function parse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  }
  catch(err) {
    return { ok: false, value: raw };
  }
}

/**
 * The value `game.settings.get()` would return on this side: the stored value if a document
 * exists, the registered default if one does not, and ABSENT if neither.
 * @param {object} snapshot
 * @param {string} bucket   "settings" | "userSettings" | "clientSettings"
 * @param {string} key
 * @returns {{stored: boolean, raw: string, value: *}|symbol}
 */
function effective(snapshot, bucket, key) {
  const stored = snapshot[bucket]?.[key];
  if ( stored !== undefined ) return { stored: true, raw: stored, ...parse(stored) };

  const fallback = snapshot.registry?.[key]?.default;
  if ( typeof fallback === "string" ) return { stored: false, raw: fallback, ...parse(fallback) };

  return ABSENT;
}

/**
 * For object values, the changed leaf paths rather than two walls of JSON. §6.
 * @returns {Array<{path: string, here: string, there: string}>|null}
 */
function leafDiff(here, there) {
  const isObj = v => v && (typeof v === "object") && !Array.isArray(v);
  if ( !isObj(here?.value) || !isObj(there?.value) ) return null;

  const a = foundry.utils.flattenObject(here.value);
  const b = foundry.utils.flattenObject(there.value);
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);

  const out = [];
  for ( const path of [...paths].sort() ) {
    if ( canonical(a[path]) === canonical(b[path]) ) continue;
    out.push({
      path,
      here: path in a ? display(a[path]) : "—",
      there: path in b ? display(b[path]) : "—"
    });
  }
  return out.length ? out : null;
}

/**
 * A short human rendering of a value for the row summary.
 * @param {*} value
 * @returns {string}
 */
export function display(value) {
  if ( value === undefined ) return "—";
  if ( value === null ) return "null";
  if ( typeof value === "string" ) return value === "" ? '""' : value;
  if ( Array.isArray(value) ) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if ( typeof value === "object" ) {
    const n = Object.keys(value).length;
    return `{${n} key${n === 1 ? "" : "s"}}`;
  }
  return String(value);
}

/* -------------------------------------------- */
/*  Classification                              */
/* -------------------------------------------- */

function blockedReasonFor(key) {
  if ( BLOCKED_KEYS.includes(key) ) return `SETTINGS_SYNC.Blocked.${key.replace(/\./g, "_")}`;
  if ( BLOCKED_PATTERNS.some(p => p.test(key)) ) return "SETTINGS_SYNC.Blocked.migration";
  return null;
}

const isNoise = key => NOISE_PATTERNS.some(p => p.test(key));

function stateOf(here, there) {
  const hereAbsent = here === ABSENT;
  const thereAbsent = there === ABSENT;
  if ( hereAbsent && thereAbsent ) return ROW_STATE.same;
  if ( hereAbsent ) return ROW_STATE.onlyThere;
  if ( thereAbsent ) return ROW_STATE.onlyHere;
  return canonical(here.value) === canonical(there.value) ? ROW_STATE.same : ROW_STATE.differs;
}

/* -------------------------------------------- */
/*  Rows                                        */
/* -------------------------------------------- */

function buildSettingRow({ local, remote, bucket, scope, key, category, group }) {
  const here = effective(local, bucket, key);
  const there = effective(remote, bucket, key);
  const state = stateOf(here, there);

  const reg = local.registry?.[key] ?? remote.registry?.[key] ?? null;
  const blockedReason = blockedReasonFor(key);

  // If the target simply never touched this setting, and our registered default agrees
  // with the one it fell back to, then "matching the target" means deleting our document
  // rather than writing the default into one. Same effective value, cleaner result.
  const localDefault = local.registry?.[key]?.default;
  const targetAtDefault = (there !== ABSENT) && !there.stored;
  const defaultsAgree = targetAtDefault && (typeof localDefault === "string")
    && (canonical(parse(localDefault).value) === canonical(there.value));
  const unsets = (state === ROW_STATE.onlyHere) || ((state === ROW_STATE.differs) && defaultsAgree);

  return {
    id: `${bucket}|${key}`,
    category,
    group,
    scope,
    key,
    bucket,
    label: reg?.name || key,
    hint: reg?.hint || null,
    registeredHere: !!local.registry?.[key],
    requiresReload: !!local.registry?.[key]?.requiresReload,
    state,
    hereText: here === ABSENT ? "—" : display(here.value),
    thereText: there === ABSENT ? "—" : display(there.value),
    /** The raw JSON source string to write. Null on an `only-here` row, which unsets. */
    applyRaw: there === ABSENT ? null : there.raw,
    /** True when applying means deleting the local document rather than writing one. */
    unsets,
    detail: leafDiff(here === ABSENT ? null : here, there === ABSENT ? null : there),
    blocked: !!blockedReason,
    blockedReason,
    noise: isNoise(key),
    appliable: (state !== ROW_STATE.same) && !blockedReason
  };
}

/**
 * Every key worth considering for one scope: documents on either side, plus everything
 * registered at that scope on either side (so a changed *default* is caught too).
 */
function keysForScope(local, remote, bucket, scope, seen) {
  const keys = new Set([...Object.keys(local[bucket] ?? {}), ...Object.keys(remote[bucket] ?? {})]);
  for ( const snapshot of [local, remote] ) {
    for ( const [id, reg] of Object.entries(snapshot.registry ?? {}) ) {
      if ( reg.scope === scope ) keys.add(id);
    }
  }
  return [...keys].filter(k => !seen.has(k) && seen.add(k));
}

function buildModuleRows(local, remote) {
  const ids = new Set([...Object.keys(local.modules ?? {}), ...Object.keys(remote.modules ?? {})]);
  const rows = [];

  for ( const id of ids ) {
    const mine = local.modules?.[id];
    const theirs = remote.modules?.[id];
    const installedHere = !!mine && !mine.uninstalled;
    const here = mine?.enabled ?? false;
    const there = theirs?.enabled ?? false;

    // Not installed here and off there: nothing to say.
    if ( !installedHere && !there ) continue;

    const state = here === there ? ROW_STATE.same : ROW_STATE.differs;
    const cannotEnable = there && !installedHere;

    const notes = [];
    if ( cannotEnable ) notes.push("SETTINGS_SYNC.Module.NotInstalled");
    else if ( mine?.version && theirs?.version && (mine.version !== theirs.version) ) {
      notes.push("SETTINGS_SYNC.Module.VersionDiffers");
    }

    rows.push({
      id: `module|${id}`,
      category: CATEGORY.modules,
      group: null,
      scope: "module",
      key: id,
      label: mine?.title ?? theirs?.title ?? id,
      hint: id,
      state,
      hereText: game.i18n.localize(here ? "SETTINGS_SYNC.On" : (installedHere ? "SETTINGS_SYNC.Off" : "SETTINGS_SYNC.Absent")),
      thereText: game.i18n.localize(there ? "SETTINGS_SYNC.On" : "SETTINGS_SYNC.Off"),
      enable: there,
      versions: { here: mine?.version ?? null, there: theirs?.version ?? null },
      notes,
      detail: null,
      requiresReload: true,
      blocked: cannotEnable,
      blockedReason: cannotEnable ? "SETTINGS_SYNC.Module.NotInstalled" : null,
      noise: false,
      appliable: (state === ROW_STATE.differs) && !cannotEnable
    });
  }

  rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows;
}

/* -------------------------------------------- */
/*  Assembly                                    */
/* -------------------------------------------- */

/**
 * Compare two snapshots.
 * @param {object} local   A snapshot of the running world.
 * @param {object} remote  The target snapshot.
 * @returns {object}
 */
export function buildDiff(local, remote) {
  const systemMismatch = local.world.system !== remote.world.system;
  const seen = new Set();
  const groups = new Map();   // category|group -> category object

  const category = (id, key, label, extra = {}) => {
    const mapKey = `${id}|${key ?? ""}`;
    if ( !groups.has(mapKey) ) {
      groups.set(mapKey, { id, key, label, rows: [], blocked: false, warning: null, note: null, ...extra });
    }
    return groups.get(mapKey);
  };

  // 1 — Modules.
  category(CATEGORY.modules, null, game.i18n.localize("SETTINGS_SYNC.Category.Modules"))
    .rows.push(...buildModuleRows(local, remote));

  // 2..4 — World-scope settings, split by namespace.
  for ( const key of keysForScope(local, remote, "settings", "world", seen) ) {
    const ns = key.split(".")[0];
    let cat;
    if ( ns === "core" ) {
      cat = category(CATEGORY.core, null, game.i18n.localize("SETTINGS_SYNC.Category.Core"));
    }
    else if ( ns === local.world.system ) {
      cat = category(CATEGORY.system, null,
        game.i18n.format("SETTINGS_SYNC.Category.System", { system: local.world.systemTitle ?? ns }));
      if ( systemMismatch ) {
        cat.blocked = true;
        cat.warning = game.i18n.format("SETTINGS_SYNC.Warning.SystemMismatch",
          { here: local.world.system, there: remote.world.system });
      }
    }
    else {
      const mod = game.modules.get(ns);
      cat = category(CATEGORY.module, ns, mod?.title ?? ns,
        { note: mod ? null : game.i18n.localize("SETTINGS_SYNC.Module.NotInstalled") });
    }

    const row = buildSettingRow({
      local, remote, bucket: "settings", scope: "world", key,
      category: cat.id, group: cat.key
    });
    if ( cat.blocked ) {
      row.blocked = true;
      row.appliable = false;
      row.blockedReason ??= "SETTINGS_SYNC.Blocked.systemMismatch";
    }
    cat.rows.push(row);
  }

  // 5 — User scope, remapped onto the current user. §4.4.
  for ( const key of keysForScope(local, remote, "userSettings", "user", seen) ) {
    category(CATEGORY.user, null, game.i18n.localize("SETTINGS_SYNC.Category.User"),
      { note: game.i18n.localize("SETTINGS_SYNC.Note.UserScope") })
      .rows.push(buildSettingRow({
        local, remote, bucket: "userSettings", scope: "user", key, category: CATEGORY.user, group: null
      }));
  }

  // 6 — Client scope. Shared by every world in this browser. §4.5.
  for ( const key of keysForScope(local, remote, "clientSettings", "client", seen) ) {
    category(CATEGORY.client, null, game.i18n.localize("SETTINGS_SYNC.Category.Client"),
      { warning: game.i18n.localize("SETTINGS_SYNC.Note.ClientScope") })
      .rows.push(buildSettingRow({
        local, remote, bucket: "clientSettings", scope: "client", key, category: CATEGORY.client, group: null
      }));
  }

  // Order: modules, core, system, each module namespace by title, user, client.
  const rank = { [CATEGORY.modules]: 0, [CATEGORY.core]: 1, [CATEGORY.system]: 2,
    [CATEGORY.module]: 3, [CATEGORY.user]: 4, [CATEGORY.client]: 5 };
  const categories = [...groups.values()].sort((a, b) =>
    (rank[a.id] - rank[b.id]) || a.label.localeCompare(b.label));

  for ( const cat of categories ) {
    cat.rows.sort((a, b) => a.label.localeCompare(b.label));
    cat.differences = cat.rows.filter(r => r.state !== ROW_STATE.same).length;
  }

  return {
    local,
    remote,
    systemMismatch,
    systemVersionMismatch: !systemMismatch && (local.world.systemVersion !== remote.world.systemVersion),
    coreVersionMismatch: local.world.coreVersion !== remote.world.coreVersion,
    categories,
    get rows() { return categories.flatMap(c => c.rows); }
  };
}
