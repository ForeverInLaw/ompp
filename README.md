# ompp

Mode presets for the [omp](https://github.com/can1357/oh-my-pi) coding agent.

omp loads every skill, prompt file, and MCP server it can find on your machine, every session. With 80 skills installed, the system prompt carries 80 descriptions even when three would do, and switching personas means renaming `SYSTEM.md` by hand.

ompp gives each kind of work a name and a folder. Launch a session in a mode and it starts with only what that work needs.

## Install

```sh
npm install -g @nevermorelove/ompp
```

Node 18 or newer, that is the whole requirement. bun works too. The binary is
named `ompp` even though the package is scoped. You can also install from
source:

```sh
git clone git@github.com:ForeverInLaw/ompp.git
cd ompp
npm install -g .
```

```sh
ompp                    arrow-key picker, then launches omp
ompp pentest            launch in a mode
ompp writing -p "..."   mode plus any omp flags
ompp create pentest     make a new mode with placeholder files,
                         then open its folder in your file manager
ompp list               print mode names
ompp pentest --dry-run  show the omp command line instead of running it
```

Before launch it prints one line to stderr, `[ompp] mode: pentest`, so you always know where you are.

Modes are read from two places, and same-named modes from the first win:

1. `OMPP_MODES_DIR`, if you set it (a repo checkout, any custom folder)
2. `~/.omp/ompp/modes/`, the user-level home for your own modes

`ompp create` always writes to `~/.omp/ompp/modes/`, so you never edit files
inside an installed package. The first `ompp create` makes the folder for you.

```
~/.omp/ompp/modes/pentest/
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

A new mode is `ompp create <name>` (or plain `mkdir` plus files). No manifest,
no code. The wrapper reads the folder, so it never needs to change when you
add modes.

## Precedence

Your flags beat the mode.

`ompp pentest --model anthropic/claude-sonnet-4-5` runs Sonnet even when the mode's `config.yml` says otherwise. An explicit `--system-prompt` on the command line disables the mode's prompt file for that run. Later `--config` overlays win too, so single keys can be overridden ad hoc.

`append.md` stacks on omp's default prompt plus your global `~/.omp/agent/SYSTEM.md` if you have one. A mode with `system.md` replaces all of it.

## Limits worth knowing

MCP servers can be added by a mode but never removed. omp has no launch-time MCP filter, so a mode that wants fewer servers than your global `mcp.json` provides has to live with them. This is the one gap that would need an omp extension to close.

Mode-local `skills/` are additive as well. To have fewer skills, set `skills.includeSkills` in the mode's `config.yml`. The allowlist filters every discovered skill, global ones included.

## Environment

- `OMPP_MODES_DIR`, an extra modes directory that wins over the bundled one.
- `OMPP_OMP_BIN`, which omp to launch. Default is omp from PATH.
