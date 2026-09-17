# ompp

Mode presets for the [omp](https://github.com/can1357/oh-my-pi) coding agent.

omp loads every skill, prompt, and MCP server it can find on the machine, all the
time. This wrapper gives you named launch modes so a session starts with only
what that kind of work needs: a curated skill set, a different model or thinking
level, and a matching system prompt.

## Install

```sh
git clone <this repo>
cd oh-my-profile
npm install -g .
```

`npm install -g .` puts `ompp` on your PATH. Node 18+ is enough; bun works too.

## Usage

```sh
ompp                 # interactive mode picker, then launches omp
ompp pentest         # launch omp in the "pentest" mode
ompp writing -p "..." # mode + any omp flags, your flags win over the mode
ompp list            # list modes
ompp pentest --dry-run   # print the omp command line instead of launching
```

## What a mode is

A folder under `modes/`. Every file is optional; whatever exists gets wired
into the omp launch flags:

```
modes/pentest/
  config.yml      settings overlay: model, thinking level, skill allowlist...
  system.md       replaces the system prompt entirely
  append.md       appended to the system prompt (only when system.md is absent)
  skills/         mode-local skills, each with a SKILL.md + description
  .mcp.json       mode-local MCP servers, added on top of your global ones
  prompts/ commands/ rules/ hooks/ tools/   also load from the mode folder
```

How each file maps onto omp:

| File | omp flag | Notes |
| --- | --- | --- |
| `config.yml` | `--config` | Any settings OMP supports: `modelRoles.default`, `defaultThinkingLevel`, `tools.approvalMode`, `skills.includeSkills` (glob allowlist) and so on. |
| `system.md` | `--system-prompt` | Full replacement. The default omp instructions, your global `SYSTEM.md`, and tool policy are gone; write what you need into the file. |
| `append.md` | `--append-system-prompt` | Kept on top of your normal prompt. Use this for most modes. |
| mode-local dirs | `--plugin-dir` | The mode folder doubles as an omp plugin root. |

Adding a mode is `mkdir modes/<name>` plus files. No code, no manifest.

## Precedence

Your flags beat the mode. `ompp pentest --model anthropic/claude-sonnet-4-5`
runs Sonnet even if the mode's `config.yml` says otherwise, and an explicit
`--system-prompt`/`--append-system-prompt` disables the mode's prompt file for
that run. Later `--config` overlays also win, so you can override single keys.

The mode's `append.md` rides on top of omp's default prompt plus your global
`~/.omp/agent/SYSTEM.md` (if you have one). Modes with `system.md` replace all
of it.

## Current limits

- MCP servers can only be added by a mode (`.mcp.json` via `--plugin-dir`), never
  removed. omp has no launch-time MCP filter; a mode that needs fewer servers
  than your global `mcp.json` provides has to live with them.
- `skills/` inside a mode is additive too. To have *fewer* skills in a mode, set
  `skills.includeSkills` in the mode's `config.yml` — that allowlist filters
  all discovered skills, including the global ones.
- The picker needs a TTY; without one it falls back to a numbered prompt.

## Environment

- `OMPP_MODES_DIR` — modes directory (default: `modes/` next to the script).
- `OMPP_OMP_BIN` — omp executable to launch (default: resolved from PATH).
