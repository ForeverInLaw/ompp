"use strict";
/**
 * Mode store — the file-management module behind `ompp create` and the
 * picker's rename/delete actions.
 *
 * Depth: everything file-level about modes lives here — scaffolding
 * templates, rename, delete, reveal in the file manager. Locality: this
 * module knows nothing about prompts, launching, or interaction; names
 * are validated through the registry, so the same rules that guard
 * `ompp <mode>` guard writes too.
 *
 * Adapters (all optional, each defaulting to the real thing):
 *   fsAdapter    { existsSync, mkdirSync, writeFileSync, renameSync, rmSync }
 *   shellAdapter { reveal(dir) }  — platform file manager, detached
 *   registry     { validateName(name), resolve(name), defaultModesDir? }
 *
 * Every mutating method returns a structured result instead of printing:
 *   { ok: true,  dir, message }   — did the thing; message is the log line
 *   { ok: false, reason, message } — refused; reason is one of
 *                                   'missing' | 'invalid' | 'reserved'
 *                                   | 'exists' | 'not-found' | 'same'
 * createCli() is the CLI seam: it prints those lines to stderr and maps
 * them onto exit codes for the `ompp create` path.
 */

const fs = require("fs");

const path = require("path");

const os = require("os");

const { spawn } = require("child_process");

// Placeholder files written into every new mode. A mode is valid the
// moment its folder has anything in it; these give the user something to
// edit instead of a blank directory.
const CONFIG_TEMPLATE = `# Settings overlay for this mode. Every line is optional:
# uncomment what you need. See "omp config list" for all keys.

# modelRoles:
#   default: anthropic/claude-sonnet-4-5
# defaultThinkingLevel: high
# tools:
#   approvalMode: write

# Allowlist of skills this mode can see. Globs are allowed.
# Empty (or absent) means every discovered skill loads.
# skills:
#   includeSkills:
#     - tdd
#     - diagnosing-bugs
`;

const APPEND_TEMPLATE = `# Extra instructions added on top of your normal system prompt.
# This file is plain text: delete these lines and write your own.

Answer directly and briefly. No preamble, no restating the question.
`;

const SYSTEM_TEMPLATE = `# Rename this file to system.md to REPLACE the whole system prompt
# instead of appending. Replacing drops omp's default instructions and
# your global ~/.omp/agent/SYSTEM.md, including tool policy: write
# what you need into the file itself.
`;

const MCP_TEMPLATE = `{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
`;

// [relative path, content] pairs, in write order.
const TEMPLATE_FILES = [
  ["config.yml", CONFIG_TEMPLATE],
  ["append.md", APPEND_TEMPLATE],
  ["system.md.example", SYSTEM_TEMPLATE],
  [".mcp.json.example", MCP_TEMPLATE],
  ["skills/.gitkeep", ""],
];

// Opens a folder in the platform file manager, detached: ompp must not
// wait for it, and a file manager crash must not take ompp down.
const defaultShellAdapter = {
  reveal(dir) {
    const bin =
      process.platform === "win32"
        ? "explorer"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";

    const child = spawn(bin, [dir], { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      console.error(`[ompp] could not open a file manager: ${err.message}`);
    });
    child.unref();
  },
};

class ModeStore {
  /**
   * @param {object}    opts
   * @param {object}    opts.registry          mode catalog: { validateName, resolve }
   * @param {object}    [opts.fsAdapter]       defaults to fs
   * @param {object}    [opts.shellAdapter]    defaults to explorer/open/xdg-open
   * @param {object}    [opts.pathLib]         defaults to path
   * @param {string}    [opts.defaultModesDir] overrides registry.defaultModesDir
   * @param {Function}  [opts.out]             printer for createCli, defaults console.error
   */
  constructor({
    registry,
    fsAdapter,
    shellAdapter,
    pathLib,
    defaultModesDir,
    out,
  } = {}) {
    if (!registry) throw new TypeError("ModeStore requires a registry");
    this.registry = registry;
    this.fsAdapter = fsAdapter || fs;
    this.path = pathLib || path;
    this.shellAdapter = shellAdapter || defaultShellAdapter;
    this.out = out || ((msg) => console.error(msg));
    // Modes are always created in the user-level default dir, never in
    // OMPP_MODES_DIR: an override folder is a checkout the user owns,
    // and `ompp create` must not write into it. A same-named mode in the
    // override still wins at launch time (registry priority).
    this.defaultModesDir =
      defaultModesDir ||
      registry.defaultModesDir ||
      this.path.join(os.homedir(), ".omp", "ompp", "modes");
  }

  // Returns { reason, message } for names the store refuses ('invalid' |
  // 'reserved'), or null when the name can be used. The rules live in
  // the registry; only the CLI-grade wording lives here.
  nameProblem(name) {
    const v = this.registry.validateName(name);

    if (!v || v.ok !== false) return null;

    return v.reason === "reserved"
      ? { reason: "reserved", message: `"${name}" is reserved for ompp commands.` }
      : {
          reason: "invalid",
          message: `"${name}" is not a valid mode name. Use lowercase letters, digits, and dashes.`,
        };
  }

  // Scaffold a new mode in the user-level default modes dir.
  create(name) {
    if (!name) {
      return { ok: false, reason: "missing", message: `usage: ompp create <name>` };
    }

    const problem = this.nameProblem(name);

    if (problem) return { ok: false, ...problem };

    const dir = this.path.join(this.defaultModesDir, name);

    if (this.fsAdapter.existsSync(dir)) {
      return {
        ok: false,
        reason: "exists",
        dir,
        message: `mode "${name}" already exists, opening its folder.`,
      };
    }

    this.fsAdapter.mkdirSync(this.path.join(dir, "skills"), {
      recursive: true,
    });

    for (const [rel, content] of TEMPLATE_FILES) {
      this.fsAdapter.writeFileSync(this.path.join(dir, rel), content);
    }

    return { ok: true, dir, message: `created mode "${name}" in ${dir}` };
  }

  // Rename an existing mode inside its own source folder. The folder
  // moves between names, not between sources.
  rename(oldName, newName) {
    const problem = this.nameProblem(newName);

    if (problem) return { ok: false, ...problem };
    const existing = this.registry.resolve(oldName);

    if (!existing) {
      return {
        ok: false,
        reason: "not-found",
        message: `mode "${oldName}" not found.`,
      };
    }

    if (newName === oldName) {
      return {
        ok: false,
        reason: "same",
        message: `"${oldName}" is already called that.`,
      };
    }

    const to = this.path.join(existing.source, newName);

    if (this.fsAdapter.existsSync(to)) {
      return {
        ok: false,
        reason: "exists",
        message: `mode "${newName}" already exists.`,
      };
    }

    this.fsAdapter.renameSync(existing.dir, to);

    return {
      ok: true,
      dir: to,
      message: `renamed "${oldName}" to "${newName}"`,
    };
  }

  // Delete a mode folder. recursive+force: a half-copied or already
  // missing folder must not turn the picker's "delete" into an error.
  remove(name) {
    const existing = this.registry.resolve(name);

    if (!existing) {
      return {
        ok: false,
        reason: "not-found",
        message: `mode "${name}" not found.`,
      };
    }

    this.fsAdapter.rmSync(existing.dir, { recursive: true, force: true });

    return { ok: true, dir: existing.dir, message: `deleted mode "${name}"` };
  }

  // Open a folder in the platform file manager (detached).
  reveal(dir) {
    this.shellAdapter.reveal(dir);
  }

  // CLI seam for `ompp create <name>`: prints the result lines to stderr
  // and maps them to an exit code. An existing mode is not an error: its
  // folder opens and the command exits 0, exactly like before the split.
  createCli(name) {
    const res = this.create(name);
    this.out(`[ompp] ${res.message}`);

    if (!res.ok) {
      if (res.reason === "exists") {
        this.reveal(res.dir);

        return 0;
      }

      return 1;
    }

    this.reveal(res.dir);
    this.out(`[ompp] edit the placeholders, then launch it: ompp ${name}`);

    return 0;
  }
}

module.exports = { ModeStore };
