#!/usr/bin/env node
/**
 * ompp — mode presets for the omp coding agent.
 *
 * A mode is a folder under modes/. Whatever the folder contains gets wired
 * into the omp launch flags:
 *
 *   config.yml | config.yaml  -> --config               (settings overlay)
 *   system.md                 -> --system-prompt         (replaces default prompt)
 *   append.md                 -> --append-system-prompt  (used when system.md is absent)
 *   skills/ .mcp.json prompts/ commands/ rules/ hooks/ tools/
 *                            -> --plugin-dir             (mode-local skills and MCP)
 *
 * Every file is optional. Everything after the mode name goes to omp as-is;
 * user flags win over the mode.
 *
 * Thin wiring over deep modules in lib/: registry, launchPlan, store,
 * picker, updateChecker. Each seam has an adapter — this file injects the
 * real fs/path/https/process adapters and decides exit codes.
 */
"use strict";

const { spawn } = require("child_process");

const { Registry } = require("./lib/registry");

const { LaunchPlan } = require("./lib/launchPlan");

const { ModeStore } = require("./lib/store");

const { Picker } = require("./lib/picker");

const { checkForUpdate } = require("./lib/updateChecker");

function usage() {
  console.log(`ompp — mode presets for the omp coding agent

Usage:
  ompp                    pick a mode interactively, then launch omp
  ompp <mode> [args...]   launch omp in a mode; everything after <mode>
                          is passed to omp unchanged and wins over the mode
  ompp create <name>      create a new mode with placeholder files
                          and open its folder
  ompp list               list available modes

Modes live in ~/.omp/ompp/modes/ (created for you by "ompp create") and,
if OMPP_MODES_DIR is set, in that folder too. Same-named modes from
OMPP_MODES_DIR win. All files are optional:
  config.yml              settings overlay: model, thinking level,
                         skills.includeSkills allowlist, approval mode, ...
  system.md               replaces the system prompt entirely
  append.md               appended to the system prompt (unless system.md exists)
  skills/                 mode-local skills (SKILL.md needs a description)
  .mcp.json               mode-local MCP servers, added on top of global ones
  prompts/ commands/ rules/ hooks/ tools/   also load from the mode folder

Flags:
  --dry-run               print the omp command line instead of launching
  -h, --help              this help
  -v, --version           version

Environment:
  OMPP_MODES_DIR          extra modes directory (repo checkout or custom)
  OMPP_OMP_BIN            omp executable to launch (default: omp from PATH)`);
}

// Spawn omp in the given mode.
function launchMode(mode, userArgs, dryRun) {
  const plan = new LaunchPlan().forMode(mode, userArgs);

  if (dryRun) {
    console.error(`[ompp] mode: ${mode.name}`);
    console.error(`[ompp] omp: ${plan.bin}${plan.shell ? " (shell)" : ""}`);
    console.error(`[ompp] argv: ${JSON.stringify(plan.argv)}`);

    return 0;
  }

  console.error(`[ompp] mode: ${mode.name}`);
  const { bin, shell, argv } = plan;
  const { LaunchPlan: LP } = require("./lib/launchPlan");
  // Reuse LaunchPlan quoting for the shell branch so wiring and module agree.
  const lp = new LP();

  const child = shell
    ? spawn(lp.displayCmd(bin, argv), { stdio: "inherit", shell: true })
    : spawn(bin, argv, { stdio: "inherit" });

  child.on("error", (err) => {
    console.error(`[ompp] failed to start omp: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  return 0;
}

async function main() {
  await checkForUpdate();

  const argv = process.argv.slice(2);

  // Shared deep modules — real adapters, no pinning.
  const registry = new Registry();
  const store = new ModeStore({ registry });

  if (argv[0] === "create") {
    return store.createCli(argv[1]);
  }

  if (argv[0] === "list") {
    const { modes, skipped } = registry.discoverModes();

    if (!modes.length) {
      console.error(`You have no modes yet. Create one with "ompp create <name>".`);

      for (const s of registry.sources) console.error(`[ompp] looked in: ${s}`);

      return 1;
    }

    for (const m of modes) console.log(m.name);

    if (skipped.length) {
      console.error(`[ompp] skipped folders without recognized files: ${skipped.join(", ")}`);
    }

    return 0;
  }

  if (["-h", "--help", "help"].includes(argv[0])) {
    usage();

    return 0;
  }

  if (["-v", "--version", "version"].includes(argv[0])) {
    console.log(require("./package.json").version);

    return 0;
  }

  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((a) => a !== "--dry-run");

  const { modes, skipped } = registry.discoverModes();

  if (skipped.length) {
    console.error(`[ompp] skipped folders without recognized files: ${skipped.join(", ")}`);
  }

  if (!modes.length && !process.stdin.isTTY) {
    console.error(`You have no modes yet. Create one with "ompp create <name>".`);

    for (const s of registry.sources) console.error(`[ompp] looked in: ${s}`);

    return 1;
  }

  if (!modes.length) {
    // TTY with zero modes: jump straight into picking — the picker offers
    // the "Create a new mode" row so an empty home is not a dead end.
    try {
      const picker = new Picker({ registry, store });
      const picked = await picker.pick([]);

      if (picked.kind === "create") return store.createCli(picked.name);

      if (picked.kind === "cancel") process.exit(130);

      return 1;
    } catch (err) {
      console.error(`[ompp] ${err.message}`);

      return 1;
    }
  }

  const modeNames = modes.map((m) => m.name);
  let mode = null;
  let userArgs = rest;

  if (rest.length && !rest[0].startsWith("-")) {
    const candidate = rest[0];
    const found = modes.find((m) => m.name === candidate);

    if (found) {
      mode = found;
      userArgs = rest.slice(1);
    } else {
      console.error(`[ompp] unknown mode "${candidate}"`);
      console.error(`[ompp] available: ${modeNames.join(", ")}`);

      return 1;
    }
  }

  if (!mode) {
    try {
      const picker = new Picker({ registry, store });
      const picked = await picker.pick(modes);

      if (picked.kind === "create") return store.createCli(picked.name);

      if (picked.kind === "cancel") process.exit(130);
      mode = picked.mode;
    } catch (err) {
      console.error(`[ompp] ${err.message}`);

      return 1;
    }
  }

  return launchMode(mode, userArgs, dryRun);
}

main()
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[ompp] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
