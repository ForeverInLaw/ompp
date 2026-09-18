"use strict";
/**
 * Mode registry — the seam between "mode folders on disk" and every
 * consumer that needs to know which modes exist. The rest of ompp asks
 * this module three kinds of questions:
 *
 *   naming    isValidName / isReserved / validateName — pure, no fs
 *   discovery list / getSkipped / resolve / exists — fs-backed scan
 *   plumbing modeDirOf / firstExisting / scanSource / discoverModes —
 *             the original ompp.js functions kept as methods, so the
 *             wiring layer has a 1:1 migration path
 *
 * Modes come from a list of source folders, in priority order:
 *   1. OMPP_MODES_DIR (explicit override; repo checkout, custom folder)
 *   2. ~/.omp/ompp/modes (the user-level home; `ompp create` writes here)
 * Same-named modes from an earlier source win; a loser logs a warning on
 * stderr and is dropped. The folder next to the script is never scanned:
 * with a global install it sits inside node_modules, and user modes must
 * not live there.
 *
 * Adapters (both optional; default to the real fs/path):
 *   fsAdapter  needs existsSync(p) and readdirSync(p, {withFileTypes: true})
 *              returning {name, isDirectory()} entries. An in-memory
 *              adapter is the second consumer that keeps this seam real
 *              instead of hypothetical.
 *   pathLib    needs join.
 *
 * `sources` defaults to defaultSources(): OMPP_MODES_DIR first, then the
 * homedir folder. Pass an explicit array (even []) to pin the registry to
 * exactly those folders.
 *
 * This module never mutates the fs and never spawns: it only reads, so
 * list()/resolve() stay safe to call at any point in a run. Discovery is
 * not cached — a scan reads the disk every time, so a caller that needs
 * both modes and skipped folders should use discoverModes() once rather
 * than list() plus getSkipped() (two passes would also print the
 * duplicate-name warning twice).
 */

const fs = require("fs");

const path = require("path");

const os = require("os");

/** Subcommands ompp itself owns; mode folders may not steal these names. */
const RESERVED_NAMES = ["create", "list", "help", "version"];

/** A mode's settings overlay; first match wins. */
const CONFIG_NAMES = ["config.yml", "config.yaml"];

/** Folders/files that make a directory worth passing to omp as a plugin dir. */
const PLUGIN_ARTIFACTS = [
  "skills",
  ".mcp.json",
  "prompts",
  "commands",
  "rules",
  "hooks",
  "tools",
];

/** A folder holding any of these is a mode; without them it is just clutter. */
const RECOGNIZED_NAMES = [
  ...CONFIG_NAMES,
  "system.md",
  "append.md",
  ...PLUGIN_ARTIFACTS,
];

/** The user-level mode home; `ompp create` always writes here. */
function defaultModesDir(opts) {
  const osLib = (opts && opts.osLib) || os;
  const pathLib = (opts && opts.pathLib) || path;

  return pathLib.join(osLib.homedir(), ".omp", "ompp", "modes");
}

/** Mode source folders in priority order: OMPP_MODES_DIR wins over homedir. */
function defaultSources(opts) {
  const env = (opts && opts.env) || process.env;
  const sources = [];

  if (env.OMPP_MODES_DIR) sources.push(env.OMPP_MODES_DIR);
  sources.push(defaultModesDir(opts));

  return sources;
}

class Registry {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.sources] mode source folders, priority order;
   *        defaults to defaultSources()
   * @param {object} [opts.fsAdapter] existsSync / readdirSync
   * @param {object} [opts.pathLib] join
   */
  constructor(opts) {
    opts = opts || {};
    this.sources = opts.sources || defaultSources(opts);
    this.fs = opts.fsAdapter || fs;
    this.pathLib = opts.pathLib || path;
    // The user-level home every new mode is created in, exposed so the
    // store does not re-derive it. Sources may be pinned to a custom
    // list, but `ompp create` always lands here regardless.
    this.defaultModesDir = defaultModesDir(opts);
  }

  /** Absolute path of a mode folder inside a source. */
  modeDirOf(name, source) {
    return this.pathLib.join(source, name);
  }

  /** First path among `names` that exists under `dir`, or null. */
  firstExisting(dir, names) {
    for (const n of names) {
      const p = this.pathLib.join(dir, n);

      if (this.fs.existsSync(p)) return p;
    }

    return null;
  }

  /** Lowercase letters, digits, dashes; must start alphanumeric. */
  isValidName(name) {
    return /^[a-z0-9][a-z0-9-]*$/.test(name);
  }

  /** True when `name` collides with a built-in ompp subcommand. */
  isReserved(name) {
    return RESERVED_NAMES.includes(name);
  }

  /**
   * The one question every name-taking flow asks ("is this a usable mode
   * name?"), answered with the reason attached so callers print a message
   * instead of re-deriving the two rules at each call site.
   */
  validateName(name) {
    if (!this.isValidName(name)) return { ok: false, reason: "invalid" };

    if (this.isReserved(name)) return { ok: false, reason: "reserved" };

    return { ok: true };
  }

  /**
   * Fold one source folder into the running discovery state. Directories
   * only, sorted; dot/_ folders are invisible; folders without a
   * recognized file land in `skipped`; a name already seen (an earlier,
   * higher-priority source owns it) logs a warning and is dropped.
   */
  scanSource(source, modes, skipped, seen) {
    if (!this.fs.existsSync(source)) return;

    const entries = this.fs
      .readdirSync(source, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const dir = this.modeDirOf(name, source);

      if (this.firstExisting(dir, RECOGNIZED_NAMES) === null) {
        skipped.push(name);
        continue;
      }

      if (seen.has(name)) {
        // A same-named mode from a higher-priority source already won.
        console.error(
          `[ompp] mode "${name}" exists in several mode folders; using the one in ${this.modeDirOf(name, this.sources[0])}`,
        );
        continue;
      }

      seen.add(name);
      modes.push({ name, source, dir });
    }
  }

  /**
   * Full scan of every source: { modes, skipped }. One pass, one set of
   * duplicate-name warnings — callers that want both halves of the
   * result should go through here, not list() + getSkipped().
   */
  discoverModes() {
    const modes = [];
    const skipped = [];
    const seen = new Set();

    for (const source of this.sources) {
      this.scanSource(source, modes, skipped, seen);
    }

    return { modes, skipped };
  }

  /** All launchable modes, source priority applied, each source sorted. */
  list() {
    return this.discoverModes().modes;
  }

  /** Folders that looked like modes but held no recognized file. */
  getSkipped() {
    return this.discoverModes().skipped;
  }

  /**
   * The mode named `name`, or null — the same semantics as list() scoped
   * to one name: the first source holding a qualifying folder wins,
   * silently. Duplicate-name warnings belong to discovery, not to a
   * targeted lookup. Files and dot/_ folders never resolve.
   */
  resolve(name) {
    if (!name || name.startsWith(".") || name.startsWith("_")) return null;

    for (const source of this.sources) {
      if (!this.fs.existsSync(source)) continue;
      const entries = this.fs.readdirSync(source, { withFileTypes: true });
      const hit = entries.find((e) => e.name === name && e.isDirectory());

      if (!hit) continue;
      const dir = this.modeDirOf(name, source);

      if (this.firstExisting(dir, RECOGNIZED_NAMES) === null) continue;

      return { name, source, dir };
    }

    return null;
  }

  /** True when resolve(name) would find a mode. */
  exists(name) {
    return this.resolve(name) !== null;
  }
}

/** Factory for callers that prefer a function over `new`. */
function createRegistry(opts) {
  return new Registry(opts);
}

module.exports = {
  Registry,
  createRegistry,
  defaultSources,
  defaultModesDir,
  RESERVED_NAMES,
  CONFIG_NAMES,
  PLUGIN_ARTIFACTS,
};
