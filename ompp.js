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
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const os = require("os");

// Modes come from two places, in priority order:
//   1. OMPP_MODES_DIR (explicit override; repo checkout, custom folder)
//   2. ~/.omp/ompp/modes (the user-level home; `ompp create` writes here)
// Same-named modes from OMPP_MODES_DIR win. The folder next to the script
// is never scanned: with a global install it sits inside node_modules, and
// user modes must not live there.
const DEFAULT_MODES_DIR = path.join(os.homedir(), ".omp", "ompp", "modes");
const SOURCES = [];
if (process.env.OMPP_MODES_DIR) SOURCES.push(process.env.OMPP_MODES_DIR);
SOURCES.push(DEFAULT_MODES_DIR);
const RESERVED_NAMES = ["create", "list", "help", "version"];
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

function modeDirOf(name, source) {
  return path.join(source, name);
}

function firstExisting(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function scanSource(source, modes, skipped, seen) {
  if (!fs.existsSync(source)) return;
  const entries = fs
    .readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const dir = modeDirOf(name, source);
    const hasSomething = firstExisting(dir, [
      ...CONFIG_NAMES,
      "system.md",
      "append.md",
      ...PLUGIN_ARTIFACTS,
    ]);
    if (!hasSomething) {
      skipped.push(name);
      continue;
    }
    if (seen.has(name)) {
      // A same-named mode from a higher-priority source already won.
      console.error(
        `[ompp] mode "${name}" exists in several mode folders; using the one in ${modeDirOf(name, SOURCES[0])}`,
      );
      continue;
    }
    seen.add(name);
    modes.push({ name, source });
  }
}

function discoverModes() {
  const modes = [];
  const skipped = [];
  const seen = new Set();
  for (const source of SOURCES) scanSource(source, modes, skipped, seen);
  return { modes, skipped };
}

function buildArgv(modeDir, userArgs) {
  const args = [];
  // An explicit user flag replaces the mode's counterpart instead of racing it.
  const userHas = (flag) =>
    userArgs.some((a) => a === flag || a.startsWith(flag + "="));

  const cfg = firstExisting(modeDir, CONFIG_NAMES);
  if (cfg) args.push("--config", cfg);

  const systemMd = path.join(modeDir, "system.md");
  const appendMd = path.join(modeDir, "append.md");
  if (fs.existsSync(systemMd) && !userHas("--system-prompt")) {
    args.push("--system-prompt", systemMd);
  } else if (fs.existsSync(appendMd) && !userHas("--append-system-prompt")) {
    args.push("--append-system-prompt", appendMd);
  }

  if (firstExisting(modeDir, PLUGIN_ARTIFACTS)) {
    args.push("--plugin-dir", modeDir);
  }

  args.push(...userArgs);
  return args;
}

function resolveBin() {
  const override = process.env.OMPP_OMP_BIN;
  if (override) {
    const needsShell =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(override);
    return { bin: override, shell: needsShell };
  }
  if (process.platform !== "win32") return { bin: "omp", shell: false };
  // Windows: Node's spawn does no PATHEXT resolution, find omp ourselves.
  const exts = (process.env.PATHEXT || ".exe;.cmd;.bat")
    .split(";")
    .filter(Boolean);
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    const d = dir.replace(/^"|"$/g, "");
    if (!d) continue;
    for (const ext of exts) {
      const cand = path.join(d, "omp" + ext.toLowerCase());
      if (!fs.existsSync(cand)) continue;
      return {
        bin: cand,
        shell: /\.(cmd|bat)$/i.test(cand),
      };
    }
  }
  return { bin: "omp", shell: true }; // last resort: let the shell find it
}

function winQuote(s) {
  if (!/[\s"]/ .test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}


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

function revealInFileManager(dir) {
  const cmd =
    process.platform === "win32"
      ? { bin: "explorer", args: [dir] }
      : process.platform === "darwin"
        ? { bin: "open", args: [dir] }
        : { bin: "xdg-open", args: [dir] };
  const child = spawn(cmd.bin, cmd.args, { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    console.error(`[ompp] could not open a file manager: ${err.message}`);
  });
  child.unref();
}

function createMode(name) {
  if (!name) {
    console.error(`[ompp] usage: ompp create <name>`);
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(
      `[ompp] "${name}" is not a valid mode name. Use lowercase letters, digits, and dashes.`,
    );
    return 1;
  }
  if (RESERVED_NAMES.includes(name)) {
    console.error(`[ompp] "${name}" is reserved for ompp commands.`);
    return 1;
  }

  // Always create in the user-level default, regardless of OMPP_MODES_DIR.
  const dir = modeDirOf(name, DEFAULT_MODES_DIR);
  if (fs.existsSync(dir)) {
    console.error(`[ompp] mode "${name}" already exists, opening its folder.`);
    revealInFileManager(dir);
    return 0;
  }

  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yml"), CONFIG_TEMPLATE);
  fs.writeFileSync(path.join(dir, "append.md"), APPEND_TEMPLATE);
  fs.writeFileSync(path.join(dir, "system.md.example"), SYSTEM_TEMPLATE);
  fs.writeFileSync(path.join(dir, ".mcp.json.example"), MCP_TEMPLATE);
  fs.writeFileSync(path.join(dir, "skills", ".gitkeep"), "");

  console.error(`[ompp] created mode "${name}" in ${dir}`);
  revealInFileManager(dir);
  console.error(`[ompp] edit the placeholders, then launch it: ompp ${name}`);
  return 0;
}

async function pickMode(modeNames) {
  const { select, isCancel, cancel } = require("@clack/prompts");
  const chosen = await select({
    message: "Pick a mode",
    options: modeNames.map((name) => ({ value: name, label: name })),
  });
  if (isCancel(chosen)) {
    cancel("Cancelled");
    process.exit(130);
  }
  return chosen;
}

// Non-TTY stdin: clack needs an interactive terminal, so numbered input.
function pickModePiped(modeNames) {
  return new Promise((resolve, reject) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    process.stdout.write("Select a mode:\n");
    modeNames.forEach((m, i) => process.stdout.write(`  ${i + 1}. ${m}\n`));
    process.stdout.write(`Choice [1-${modeNames.length}]: `);
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      const n = parseInt(line.trim(), 10);
      if (n >= 1 && n <= modeNames.length) resolve(modeNames[n - 1]);
      else reject(new Error(`"${line.trim()}" is not a valid choice`));
    });
    rl.once("close", () => {
      if (!done) reject(new Error("no mode selected"));
    });
  });
}



async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "create") {
    return createMode(argv[1]);
  }

  if (argv[0] === "list") {
    const { modes, skipped } = discoverModes();
    if (!modes.length) {
      console.error(
        `You have no modes yet. Create one with "ompp create <name>".`,
      );
      for (const s of SOURCES) console.error(`[ompp] looked in: ${s}`);
      return 1;
    }
    for (const m of modes) console.log(m.name);
    if (skipped.length) {
      console.error(
        `[ompp] skipped folders without recognized files: ${skipped.join(", ")}`,
      );
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

  const { modes, skipped } = discoverModes();
  if (skipped.length) {
    console.error(
      `[ompp] skipped folders without recognized files: ${skipped.join(", ")}`,
    );
  }
  if (!modes.length) {
    console.error(
      `You have no modes yet. Create one with "ompp create <name>".`,
    );
    for (const s of SOURCES) console.error(`[ompp] looked in: ${s}`);
    return 1;
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
  } else {
    try {
      const name = process.stdin.isTTY
        ? await pickMode(modeNames)
        : await pickModePiped(modeNames);
      mode = modes.find((m) => m.name === name);
    } catch (err) {
      console.error(`[ompp] ${err.message}`);
      return 1;
    }
  }

  const modeDir = modeDirOf(mode.name, mode.source);
  const args = buildArgv(modeDir, userArgs);
  const { bin, shell } = resolveBin();

  if (dryRun) {
    console.error(`[ompp] mode: ${mode.name}`);
    console.error(`[ompp] omp: ${bin}${shell ? " (shell)" : ""}`);
    console.error(`[ompp] argv: ${JSON.stringify(args)}`);
    return 0;
  }

  console.error(`[ompp] mode: ${mode.name}`);
  const child = shell
    ? spawn([winQuote(bin), ...args.map(winQuote)].join(" "), {
        stdio: "inherit",
        shell: true,
      })
    : spawn(bin, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`[ompp] failed to start omp: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return 0;
}

main()
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[ompp] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
