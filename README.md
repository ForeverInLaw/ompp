# ompp

Mode presets for the [omp](https://github.com/can1357/oh-my-pi) coding agent.

omp loads every skill, prompt file, and MCP server it can find on your machine, every session. With 80 skills installed, the system prompt carries 80 descriptions even when three would do, and switching personas means renaming `SYSTEM.md` by hand.

ompp gives each kind of work a name and a folder. Launch a session in a mode and it starts with only what that work needs.

## Install

```sh
git clone git@github.com:ForeverInLaw/ompp.git
cd ompp
npm install -g .
```

Node 18 or newer, that is the whole requirement. bun works too. After install, `ompp` is on your PATH. To update, `git pull` and install again.

## Usage

```sh
ompp                    arrow-key picker, then launches omp
ompp pentest            launch in a mode
ompp writing -p "..."   mode plus any omp flags
ompp list               print mode names
ompp pentest --dry-run  show the omp command line instead of running it
```

Before launch it prints one line to stderr, `[ompp] mode: pentest`, so you always know where you are.

## What a mode is

A folder under `modes/`. Every file is optional, whatever exists gets wired into the launch flags.

```
modes/pentest/
  config.yml      settings overlay
  system.md       full system prompt replacement
  append.md       prompt addendum, used when system.md is absent
  skills/         skills only this mode sees
  .mcp.json       MCP servers only this mode gets
  prompts/ commands/ rules/ hooks/ tools/   also load from the mode folder
```

| File | omp flag | What goes in it |
| --- | --- | --- |
| `config.yml` | `--config` | Any OMP setting. `modelRoles.default`, `defaultThinkingLevel`, `tools.approvalMode`, the `skills.includeSkills` glob allowlist and friends. |
| `system.md` | `--system-prompt` | Replaces the prompt whole. The default omp instructions, your global `SYSTEM.md`, and the built-in tool policy are gone. Write what you need. |
| `append.md` | `--append-system-prompt` | Rides on top of your normal prompt. This is what most modes want. |
| the folder itself | `--plugin-dir` | omp treats the mode folder as a plugin root, so `skills/` and `.mcp.json` inside it load too. |

A new mode is `mkdir modes/<name>` plus files. No manifest, no code. The wrapper reads the folder, so it never needs to change when you add modes. `modes/general` is a working example to copy from.

## Precedence

Your flags beat the mode.

`ompp pentest --model anthropic/claude-sonnet-4-5` runs Sonnet even when the mode's `config.yml` says otherwise. An explicit `--system-prompt` on the command line disables the mode's prompt file for that run. Later `--config` overlays win too, so single keys can be overridden ad hoc.

`append.md` stacks on omp's default prompt plus your global `~/.omp/agent/SYSTEM.md` if you have one. A mode with `system.md` replaces all of it.

## Limits worth knowing

MCP servers can be added by a mode but never removed. omp has no launch-time MCP filter, so a mode that wants fewer servers than your global `mcp.json` provides has to live with them. This is the one gap that would need an omp extension to close.

Mode-local `skills/` are additive as well. To have fewer skills, set `skills.includeSkills` in the mode's `config.yml`. The allowlist filters every discovered skill, global ones included.

The picker needs a TTY. Piped or otherwise headless stdin gets a numbered prompt instead.

## Environment

- `OMPP_MODES_DIR`, where modes live. Default is `modes/` next to the script.
- `OMPP_OMP_BIN`, which omp to launch. Default is omp from PATH.
