# ompp — profiles for [omp](https://github.com/can1357/oh-my-pi)

omp loads everything every time. Every skill, every MCP server, every system prompt. Every session. Gets noisy fast.

ompp fixes that. Give each kind of work its own profile. `ompp pentest` starts with only what pentesting needs. Nothing extra.

## Install

```sh
npm install -g @nevermorelove/ompp
```

Needs Node 18 or newer. Bun works too.

From source:

```sh
git clone git@github.com:ForeverInLaw/ompp.git && cd ompp && npm install -g .
```

## Use

```sh
ompp                    # pick a mode, then launch
ompp pentest            # launch straight into a mode
ompp writing -p "..."   # mode plus any omp flags
ompp create my-mode     # new mode
ompp list               # list modes
ompp pentest --dry-run  # print the command without running it
```

The picker lets you rename or delete a mode too. It drops you back in the list after, so a wrong click costs nothing.

Before launch it prints `[ompp] mode: pentest` to stderr. You always know where you are.

## Make a mode

```sh
ompp create pentest
```

```
config.yml   omp settings (--config)
append.md    extra prompt text (--append-system-prompt) — you probably want this one
system.md    replace the whole prompt (--system-prompt)
skills/      skills only this mode sees
.mcp.json    MCP servers only this mode gets
prompts/ commands/ rules/ hooks/ tools/   also loaded from the mode folder
```

No manifest, no config to register. Just `mkdir` and files if you prefer.

### System prompts

Each mode can change what the agent reads at startup. Three options:

| File | What it does | When to use it |
|---|---|---|
| `append.md` | added on top of omp defaults + `~/.omp/agent/SYSTEM.md` | almost always — tweak without losing the base prompt |
| `system.md` | replaces the entire prompt, base prompt and global `SYSTEM.md` are ignored | you want full control |
| no file | omp runs as usual | mode only changes config, skills, or MCP |

If both exist, `system.md` wins. Both are ignored if you pass `--system-prompt` or `--append-system-prompt` on the command line — your flags always win.

ompp looks for modes in two places. First match wins.

1. `$OMPP_MODES_DIR` if you set it
2. `~/.omp/ompp/modes/` — your modes

## How overrides work

Your flags always win. If the mode sets a model in `config.yml` and you pass `--model anthropic/claude-sonnet-4-5`, you get Sonnet for that run. Same with `--system-prompt`, it skips the mode file entirely.

`append.md` stacks on top of omp defaults and your global `~/.omp/agent/SYSTEM.md`. `system.md` replaces all of it. Most of the time you want `append.md`.

## Things worth knowing

MCP servers are additive only. A mode can add servers but cannot remove global ones. omp does not have a filter for that yet.

Same story for skills, but there is a workaround. Set `skills.includeSkills` in the mode `config.yml` to allowlist only what you need.

## Env

| Variable | What it does | Default |
|---|---|---|
| `OMPP_MODES_DIR` | extra modes folder, checked first | — |
| `OMPP_OMP_BIN` | which omp to run | `omp` from PATH |
