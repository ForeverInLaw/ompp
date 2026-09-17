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

const MODES_DIR = process.env.OMPP_MODES_DIR || path.join(__dirname, "modes");
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

function firstExisting(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function discoverModes() {
  const modes = [];
  const skipped = [];
  if (!fs.existsSync(MODES_DIR)) return { modes, skipped };
  const entries = fs
    .readdirSync(MODES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const dir = path.join(MODES_DIR, name);
    const hasSomething = firstExisting(dir, [
      ...CONFIG_NAMES,
      "system.md",
      "append.md",
      ...PLUGIN_ARTIFACTS,
    ]);
    if (hasSomething) modes.push(name);
    else skipped.push(name);
  }
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
  ompp list               list available modes

A mode is a folder under modes/. All files are optional:
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
  OMPP_MODES_DIR          modes directory (default: modes/ next to this script)
  OMPP_OMP_BIN            omp executable to launch (default: omp from PATH)`);
}

function pickInteractive(modes) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let idx = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      process.stdout.write("\u001b[?25h"); // show cursor
      if (value === null) reject(new Error("mode selection cancelled"));
      else resolve(value);
    };

    const render = (first) => {
      if (!first) process.stdout.write(`\u001b[${modes.length}A`);
      const body = modes
        .map((m, i) => (i === idx ? "> " + m : "  " + m))
        .map((l) => "\u001b[2K" + l)
        .join("\n");
      process.stdout.write("\u001b[?25l" + body + "\n");
    };

    function onData(buf) {
      // A single read can carry several keys (arrow + Enter glued together,
      // a paste). Walk key by key instead of matching the whole chunk.
      const s = buf.toString();
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === "\u001b") {
          const seq = s.slice(i);
          if (seq.startsWith("\u001b[A") || seq.startsWith("\u001b[B") ||
              seq.startsWith("\u001b[C") || seq.startsWith("\u001b[D")) {
            if (seq.startsWith("\u001b[A")) {
              idx = (idx - 1 + modes.length) % modes.length;
              render(false);
            } else if (seq.startsWith("\u001b[B")) {
              idx = (idx + 1) % modes.length;
              render(false);
            } // C/D: left/right, ignore
            i += 3;
            continue;
          }
          if (seq.length === 1) {
            // Bare escape with nothing after it in this chunk: cancel.
            finish(null);
            process.exit(0);
          }
          i++; // unknown or split sequence, skip the escape byte
          continue;
        }
        if (ch === "\r" || ch === "\n") return finish(modes[idx]);
        if (ch === "\u0003") {
          // Ctrl+C: restore the terminal and bail like a shell would.
          finish(null);
          process.exit(130);
        }
        if (ch === "q") {
          finish(null);
          process.exit(0);
        }
        if (ch === "j") {
          idx = (idx + 1) % modes.length;
          render(false);
        }
        if (ch === "k") {
          idx = (idx - 1 + modes.length) % modes.length;
          render(false);
        }
        i++;
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render(true);
  });
}

function pickByNumber(modes) {
  return new Promise((resolve, reject) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    process.stdout.write("Select a mode:\n");
    modes.forEach((m, i) => process.stdout.write(`  ${i + 1}. ${m}\n`));
    process.stdout.write(`Choice [1-${modes.length}]: `);
    rl.once("line", (line) => {
      rl.close();
      const n = parseInt(line.trim(), 10);
      if (n >= 1 && n <= modes.length) resolve(modes[n - 1]);
      else reject(new Error(`"${line.trim()}" is not a valid choice`));
    });
    rl.once("close", () => {
      reject(new Error("no mode selected"));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "list") {
    const { modes, skipped } = discoverModes();
    if (!modes.length) {
      console.error(
        `[ompp] no modes found in ${MODES_DIR}. Create modes/<name>/ with at least one mode file.`,
      );
      return 1;
    }
    for (const m of modes) console.log(m);
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
      `[ompp] no modes found in ${MODES_DIR}. Create modes/<name>/ with at least one mode file.`,
    );
    return 1;
  }

  let mode = null;
  let userArgs = rest;
  if (rest.length && !rest[0].startsWith("-")) {
    const candidate = rest[0];
    if (modes.includes(candidate)) {
      mode = candidate;
      userArgs = rest.slice(1);
    } else {
      console.error(`[ompp] unknown mode "${candidate}"`);
      console.error(`[ompp] available: ${modes.join(", ")}`);
      return 1;
    }
  } else {
    try {
      mode = process.stdin.isTTY
        ? await pickInteractive(modes)
        : await pickByNumber(modes);
    } catch (err) {
      console.error(`[ompp] ${err.message}`);
      return 1;
    }
  }

  const modeDir = path.join(MODES_DIR, mode);
  const args = buildArgv(modeDir, userArgs);
  const { bin, shell } = resolveBin();

  if (dryRun) {
    console.error(`[ompp] mode: ${mode}`);
    console.error(`[ompp] omp: ${bin}${shell ? " (shell)" : ""}`);
    console.error(`[ompp] argv: ${JSON.stringify(args)}`);
    return 0;
  }

  console.error(`[ompp] mode: ${mode}`);
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
