"use strict";

/**
 * Picker — ompp's interactive mode chooser.
 *
 * Locality: every user-facing branch of a bare `ompp` run lives in this
 * module — the clack picker on a TTY, the numbered readline prompt when
 * stdin is piped, and the launch / rename / delete / create action loop.
 * The module has no process-level side effects: it never spawns omp,
 * never touches a mode folder, never exits. It returns a typed intent and
 * the caller decides what to do with it.
 *
 *   pick(modes) -> Promise<
 *     | { kind: "launch", mode }    run omp in this mode ({name, source, ...})
 *     | { kind: "create", name }    scaffold a new mode with this name
 *     | { kind: "cancel" }          user bailed out (caller exits 130)
 *   >
 *
 * The old CREATE_OPTION string sentinel and the `{create: name}`
 * shape-sniffing in the caller are gone: the create row is matched by
 * identity against a module-local symbol, and the result is a proper
 * discriminated union.
 *
 * Seams — every dependency is an injectable adapter so a session can be
 * scripted without a PTY, and so the real work stays in the deep modules
 * instead of leaking here:
 *   terminal { isTTY, clack, readlineFactory, stdin, stdout }
 *     isTTY picks the branch; clack is @clack/prompts; readlineFactory
 *     makes the {input} interface for the piped branch.
 *   registry.validateName(name) -> {ok} | {ok: false, reason}
 *     the name rules belong to the registry module; only wording lives here.
 *   store.rename(old, new) / store.remove(name) -> {ok, message?}
 *     the filesystem work belongs to the store module.
 * Uninjected seams default to the real clack/readline and the sibling
 * modules, resolved lazily on first use — requiring this file never needs
 * a TTY, nor the siblings to exist yet.
 */

const CREATE = Symbol("ompp.picker.create");

// --- default adapters --------------------------------------------------------

// The real terminal: clack on a TTY, readline over process stdio.
function defaultTerminal() {
  return {
    isTTY: Boolean(process.stdin && process.stdin.isTTY),
    clack: require("@clack/prompts"),
    readlineFactory: (opts) => require("readline").createInterface(opts),
    stdin: process.stdin,
    stdout: process.stdout,
  };
}

// The sibling modules are resolved lazily (never at require time) and
// either module shape — class or factory — is accepted.
function defaultRegistry() {
  const mod = require("./registry");
  const Ctor = mod.Registry ?? mod.createRegistry ?? mod.default ?? mod;
  if (typeof Ctor !== "function") return Ctor;
  return Ctor.prototype ? new Ctor() : Ctor();
}

function defaultStore(registry) {
  const mod = require("./store");
  const Ctor = mod.ModeStore ?? mod.createModeStore ?? mod.default ?? mod;
  if (typeof Ctor !== "function") return Ctor;
  return Ctor.prototype ? new Ctor({ registry }) : Ctor({ registry });
}

// --- picker -------------------------------------------------------------------

class Picker {
  /**
   * All three seams are optional: ompp.js injects the real adapters,
   * tests inject scripted ones, anything left out defaults to the real
   * thing on first use.
   *
   * @param {{ registry?: object, store?: object, terminal?: object }} [opts]
   */
  constructor(opts = {}) {
    this._registry = opts.registry || null;
    this._store = opts.store || null;
    this._injectedTerminal = opts.terminal || null;
    this._terminal = null;
  }

  /** Registry seam, resolved on first name validation. */
  get registry() {
    this._registry ??= defaultRegistry();
    return this._registry;
  }

  /** Store seam, resolved on first rename/delete. */
  get store() {
    this._store ??= defaultStore(this.registry);
    return this._store;
  }

  /** Terminal seam, resolved once per instance. */
  get terminal() {
    this._terminal ??= this._injectedTerminal || defaultTerminal();
    return this._terminal;
  }

  /**
   * Pick a mode. A TTY runs the clack action loop; piped stdin gets the
   * numbered prompt. Returns the intent — never exits the process.
   *
   * @param {Array<{name: string, source: string}>} modes
   * @returns {Promise<
   *   | { kind: "launch", mode: object }
   *   | { kind: "create", name: string }
   *   | { kind: "cancel" }
   * >}
   */
  pick(modes) {
    return this.terminal.isTTY
      ? this._pickInteractive(modes)
      : this._pickPiped(modes);
  }

  // Non-TTY stdin: clack needs an interactive terminal, so numbered input.
  // Single shot like the original: a bad number or EOF rejects and the
  // caller prints the error and exits 1. An empty mode list cannot be
  // prompted and resolves as a cancel.
  _pickPiped(modes) {
    const term = this.terminal;
    if (!modes.length) return Promise.resolve({ kind: "cancel" });
    return new Promise((resolve, reject) => {
      const rl = term.readlineFactory({ input: term.stdin });
      term.stdout.write("Select a mode:\n");
      modes.forEach((m, i) => term.stdout.write(`  ${i + 1}. ${m.name}\n`));
      term.stdout.write(`Choice [1-${modes.length}]: `);
      let done = false;
      rl.once("line", (line) => {
        done = true;
        rl.close();
        const n = parseInt(line.trim(), 10);
        if (n >= 1 && n <= modes.length) {
          resolve({ kind: "launch", mode: modes[n - 1] });
        } else {
          reject(new Error(`"${line.trim()}" is not a valid choice`));
        }
      });
      rl.once("close", () => {
        if (!done) reject(new Error("no mode selected"));
      });
    });
  }

  // The interactive action loop. r/d used to be raw stdin keypresses that
  // left Windows terminals in raw mode and hung randomly; the second
  // select below is the stable replacement.
  async _pickInteractive(modes) {
    const term = this.terminal;
    const { select, text, confirm, isCancel, cancel } = term.clack;
    // Local copy: deletes re-render this list, not the caller's array.
    const list = modes.slice();
    for (;;) {
      const chosen = await select({
        message: "Pick a mode",
        options: [
          ...list.map((m) => ({ value: m, label: m.name })),
          { value: CREATE, label: "Create a new mode +" },
        ],
      });

      if (isCancel(chosen)) {
        cancel("Cancelled");
        return { kind: "cancel" };
      }

      if (chosen === CREATE) {
        const name = await text({
          message: "New mode name",
          validate: (v) => this._nameError(v),
        });
        if (isCancel(name)) {
          cancel("Cancelled");
          return { kind: "cancel" };
        }
        // The caller scaffolds the folder and stops: the fresh mode is
        // all placeholders, launching it now would run an unconfigured
        // mode.
        return { kind: "create", name };
      }

      const action = await select({
        message: `Mode "${chosen.name}" — what next?`,
        options: [
          { value: "launch", label: "Launch" },
          { value: "rename", label: "Rename" },
          { value: "delete", label: "Delete" },
          { value: "back", label: "Back" },
        ],
      });
      if (isCancel(action) || action === "back") continue;
      if (action === "launch") return { kind: "launch", mode: chosen };

      if (action === "rename") {
        const newName = await text({
          message: `Rename "${chosen.name}" to`,
          validate: (v) => {
            const err = this._nameError(v);
            if (err) return err;
            if (list.some((m) => m.name === v)) return `"${v}" already exists`;
            return undefined;
          },
        });
        if (!isCancel(newName) && newName !== chosen.name) {
          const res = this.store.rename(chosen.name, newName);
          if (res && res.ok) {
            // Shared object: the re-render and the caller both see it.
            chosen.name = newName;
          } else {
            this._log(
              (res && res.message) ||
                `could not rename "${chosen.name}" to "${newName}"`,
            );
          }
        } else {
          cancel("Rename cancelled");
        }
        continue;
      }

      if (action === "delete") {
        const sure = await confirm({
          message: `Delete "${chosen.name}"? This removes its folder.`,
          active: "Delete",
          inactive: "Keep",
        });
        if (!isCancel(sure) && sure) {
          const res = this.store.remove(chosen.name);
          if (!res || res.ok) {
            const idx = list.findIndex((m) => m.name === chosen.name);
            if (idx !== -1) list.splice(idx, 1);
          } else {
            this._log(
              (res && res.message) || `could not delete "${chosen.name}"`,
            );
          }
        } else {
          cancel("Delete cancelled");
        }
        continue;
      }
    }
  }

  // Name rules live in the registry module; only the wording lives here.
  _nameError(value) {
    if (!value) return "Lowercase letters, digits, and dashes only";
    const res = this.registry.validateName(value);
    if (res && res.ok === false) {
      return res.reason === "reserved"
        ? `"${value}" is reserved`
        : "Lowercase letters, digits, and dashes only";
    }
    return undefined;
  }

  _log(message) {
    this.terminal.stdout.write(`${message}\n`);
  }
}

/** One-shot form of the seam: pick(modes, opts) === new Picker(opts).pick(modes). */
function pick(modes, opts) {
  return new Picker(opts).pick(modes);
}

module.exports = { Picker, pick };
