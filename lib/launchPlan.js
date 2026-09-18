"use strict";
/**
 * Launch plan — the pure seam between "a mode folder + user args" and "the
 * exact omp command line". Nothing here spawns: the caller gets
 * { bin, shell, argv, displayCmd } and decides whether to run it, print it
 * (--dry-run), or throw it away.
 *
 * Mode folder -> omp flags:
 *   config.yml | config.yaml  -> --config                (first match wins)
 *   system.md                 -> --system-prompt        (replaces default prompt)
 *   append.md                 -> --append-system-prompt  (only w/o system.md)
 *   skills/ .mcp.json prompts/ commands/ rules/ hooks/ tools/
 *                             -> --plugin-dir <modeDir>
 * Everything the user passes after the mode name is appended verbatim and
 * wins: a mode flag is only emitted when the user did not supply it.
 *
 *   fsAdapter  fs — needs existsSync
 *   pathLib    path — needs join; delimiter for PATH splitting
 */

const fs = require("fs");

const path = require("path");

// Artifact basenames probed for here. The registry owns the canonical lists;
// they are repeated so this stays a standalone leaf module with no sibling
// require. Keep in sync with lib/registry.js.
const CONFIG_NAMES = ["config.yml", "config.yaml"];

const PLUGIN_ARTIFACTS = [
  "skills",
  ".mcp.json",
  "prompts",
  "commands",
  "rules",
  "hooks",
  "tools",
];

/** Quote one token for cmd.exe: wrap on space/quote, double inner quotes. */
function winQuote(s) {
  if (!/[\s"]/.test(s)) return s;

  return '"' + s.replace(/"/g, '""') + '"';
}

/** Quote one token POSIX-style. Display only: spawn never sees this string. */
function posixQuote(s) {
  if (!/[\s"']/.test(s)) return s;

  return "'" + s.replace(/'/g, "'\\''") + "'";
}

class LaunchPlan {
  /** @param {{platform?: string, env?: object, fsAdapter?: object, pathLib?: object}} [opts] */
  constructor(opts = {}) {
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.fsAdapter = opts.fsAdapter ?? fs;
    this.pathLib = opts.pathLib ?? path;
  }

  /** First existing path among names, or null. */
  firstExisting(dir, names) {
    for (const n of names) {
      const p = this.pathLib.join(dir, n);

      if (this.fsAdapter.existsSync(p)) return p;
    }

    return null;
  }

  /** omp argv for one mode folder: mode flags first, user args verbatim last. */
  buildArgv(modeDir, userArgs) {
    const args = [];

    // An explicit user flag replaces the mode's counterpart instead of
    // racing it, so the mode's copy is simply not emitted.
    const userHas = (flag) =>
      userArgs.some((a) => a === flag || a.startsWith(flag + "="));

    const cfg = this.firstExisting(modeDir, CONFIG_NAMES);

    if (cfg) args.push("--config", cfg);

    const systemMd = this.pathLib.join(modeDir, "system.md");
    const appendMd = this.pathLib.join(modeDir, "append.md");

    if (this.fsAdapter.existsSync(systemMd) && !userHas("--system-prompt")) {
      args.push("--system-prompt", systemMd);
    } else if (
      this.fsAdapter.existsSync(appendMd) &&
      !userHas("--append-system-prompt")
    ) {
      args.push("--append-system-prompt", appendMd);
    }

    if (this.firstExisting(modeDir, PLUGIN_ARTIFACTS)) {
      args.push("--plugin-dir", modeDir);
    }

    args.push(...userArgs);

    return args;
  }

  /**
   * Which omp to run, and whether it needs a shell:
   *   - OMPP_OMP_BIN wins outright (.cmd/.bat on Windows need a shell)
   *   - elsewhere omp is expected on PATH; on Windows Node's spawn does no
   *     PATHEXT resolution, so search PATH for omp.exe/.cmd/.bat ourselves
   *   - last resort: plain "omp" and let the shell find it
   */
  resolveBin() {
    const override = this.env.OMPP_OMP_BIN;

    if (override) {
      const needsShell =
        this.platform === "win32" && /\.(cmd|bat)$/i.test(override);

      return { bin: override, shell: needsShell };
    }

    if (this.platform !== "win32") return { bin: "omp", shell: false };

    const exts = (this.env.PATHEXT || ".exe;.cmd;.bat")
      .split(";")
      .filter(Boolean);

    const pathDirs = (this.env.PATH || "").split(this.pathLib.delimiter);

    for (const dir of pathDirs) {
      const d = dir.replace(/^"|"$/g, "");

      if (!d) continue;

      for (const ext of exts) {
        const cand = this.pathLib.join(d, "omp" + ext.toLowerCase());

        if (!this.fsAdapter.existsSync(cand)) continue;

        return {
          bin: cand,
          shell: /\.(cmd|bat)$/i.test(cand),
        };
      }
    }

    return { bin: "omp", shell: true }; // last resort: let the shell find it
  }

  /** One shell-ready line for logs and --dry-run. On win32 this is exactly
   *  the string spawn(..., { shell: true }) would run; elsewhere it is a
   *  POSIX-quoted rendering of the execve argv. */
  displayCmd(bin, argv) {
    if (this.platform === "win32") {
      return [winQuote(bin), ...argv.map(winQuote)].join(" ");
    }

    return [posixQuote(bin), ...argv.map(posixQuote)].join(" ");
  }

  /**
   * Full plan for one mode. `mode` is a registry entry {name, source, dir};
   * a bare {name, source} also works (dir = source/name) so callers holding
   * pre-registry mode objects are fine. Pure: never spawns, never prints.
   */
  forMode(mode, userArgs = []) {
    const modeDir =
      mode.dir ??
      (mode.source != null && mode.name != null
        ? this.pathLib.join(mode.source, mode.name)
        : null);

    if (!modeDir) {
      throw new TypeError(
        "LaunchPlan.forMode: mode needs a dir (or source + name)",
      );
    }

    const argv = this.buildArgv(modeDir, userArgs);
    const { bin, shell } = this.resolveBin();

    return { bin, shell, argv, displayCmd: this.displayCmd(bin, argv) };
  }

  /** Static convenience: plan one mode without keeping an instance. */
  static forMode(mode, userArgs, opts) {
    return new LaunchPlan(opts).forMode(mode, userArgs);
  }
}

/** Standalone argv builder (defaults to the real fs/path/env/platform). */
function buildArgv(modeDir, userArgs, opts) {
  return new LaunchPlan(opts).buildArgv(modeDir, userArgs);
}

/** Standalone bin resolution. */
function resolveBin(opts) {
  return new LaunchPlan(opts).resolveBin();
}

module.exports = {
  LaunchPlan,
  buildArgv,
  resolveBin,
  winQuote,
  posixQuote,
  CONFIG_NAMES,
  PLUGIN_ARTIFACTS,
};
