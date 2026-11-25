# Impeccable for OpenClaw

> **Unofficial community plugin.** It is not made or endorsed by Impeccable's author.
> Impeccable is by [Paul Bakaus](https://github.com/pbakaus/impeccable) (Apache-2.0).
> This package ports it to OpenClaw and tracks upstream releases. Report plugin issues
> [here](https://github.com/TheAngryPit/openclaw-impeccable/issues), not upstream.

A native OpenClaw plugin for [Impeccable](https://impeccable.style), Paul Bakaus's
frontend design skill: one skill with 24 commands (`/impeccable polish`, `audit`,
`critique`, `typeset`, `layout`, …), curated anti-pattern detection, and a design
gate that checks UI edits while the agent works.

Upstream ships Impeccable to about twenty harnesses. Each harness gets a generated
skill copy and a hooks manifest, and every manifest calls the same engine binary.
OpenClaw can already load the Claude bundle, but it does not run Claude
`hooks.json`, so that path keeps the skill and drops the detector loop. This
plugin uses OpenClaw's native surfaces for each part instead.

| Upstream piece | Claude Code / Codex wiring | This plugin |
| --- | --- | --- |
| `impeccable` skill + 45 references | `.claude/skills/…` | Manifest `skills`. Generated from upstream source with an `openclaw` provider profile. Invoked as `/impeccable <cmd>` on channels or `$impeccable` in Control UI |
| Sub-agents (finish reviewer, motion reviewer, …) | `.claude/agents/*.md` | `reference/degraded/*.md`, used as `sessions_spawn` briefs or run inline |
| `impeccable context` (Setup step 1) | shell via `Bash(…)` allow rule | `impeccable_context` tool, with no exec approval. The launcher is the fallback |
| `npx impeccable detect` | shell | `impeccable_detect` tool with a JSON result contract, confined to the workspace |
| PostToolUse `Edit\|Write` → `impeccable hook` | hooks manifest | Agent tool-result middleware on `write` / `edit` / `apply_patch`. Findings are appended to the tool result the model reads next, as upstream's Hermes plugin does |
| Stop → `impeccable hook` deep pass | hooks manifest | `before_agent_finalize`. Findings request a bounded revision (`retry.maxAttempts`) |
| Launcher + pinned checksums | ships in the skill | Vendored unchanged. The plugin only calls it |

The engine stays the single source of policy, as upstream intends. It decides
which files are UI files, whether a project turned the hook off, which ignores apply, and
how to de-duplicate the two passes. With the finish-time pass on, the per-edit pass reports only the engine's
immediate-tier rules, and the rest (side-tab, overused fonts, …) come at finish, as in
Claude Code and Codex. With `gate.onFinish: false`, the per-edit pass reports the full
rule set, as upstream does for Cursor. The plugin passes it Codex-shaped events
(`IMPECCABLE_HOOK_HARNESS=codex`, `IMPECCABLE_PROVIDER_ID=openclaw`).

## Install

```bash
openclaw plugins install clawhub:@theangrypit/openclaw-impeccable --accept-capabilities
openclaw impeccable engine install      # one-time; downloads + sha256-verifies engine 0.1.27 into ~/.impeccable
openclaw impeccable status
```

The capability consent covers:
- the two tools
- tool-result middleware for the `openclaw`, `codex` and `agentsapi` runtimes
- `conversationAccess: read`, which `before_agent_finalize` needs

No config edits are required.

## Use

- `/impeccable` with no arguments shows the context-aware menu.
- `/impeccable init` writes PRODUCT.md, and `/impeccable document` writes DESIGN.md.
- `/impeccable critique landing page`, `/impeccable polish src/app/settings`, and so on.
- The design gate is **on by default** in every project, matching upstream. Turn it off for
  one project with `/impeccable hooks off`, which writes `hook.enabled: false` to that
  project's `.impeccable/config.json`. `/impeccable hooks on` turns it back on. From a
  shell: `openclaw impeccable hooks off --project <dir>`. Set `hook.quiet: true` in that
  config to silence the "no issues found" notes. Set `gate.perEdit`/`gate.onFinish` to
  `false` to turn it off everywhere.
- Like every Impeccable harness, the engine keeps a per-session cache at
  `.impeccable/hook.cache.json` in projects where UI files are edited. Add it to the
  project's `.gitignore`, as upstream does. `.impeccable/config.json` is meant to be
  committed; `config.local.json` is not.

## Coexisting with a regular Impeccable install

People often have Impeccable installed for other harnesses already. Most of that is
shared by design:

- **Project files.** PRODUCT.md, DESIGN.md and `.impeccable/` are harness-neutral. If a project
  turned the hook off from another harness, it's off in OpenClaw too, and the same goes for ignores.
- **Engine.** The launcher reuses `~/.impeccable/bin` and an `impeccable` on PATH.
- **No double checks.** OpenClaw's Codex runtime ignores Codex `hooks.json`. The
  Claude CLI backend loads only user-level settings, and that runs Claude's own loop,
  which this plugin doesn't hook.

The real overlap is the **skill**. Upstream's installer writes `.agents/skills/impeccable`
by default. OpenClaw loads `<workspace>/skills`, `<workspace>/.agents/skills`,
`~/.agents/skills` and `<state>/skills` ahead of plugin skills, so that copy is the one
the model reads. The plugin keeps everything coherent around whichever copy is served:

| Served copy | Launcher the gate and tools run |
| --- | --- |
| This plugin's | bundled |
| User or managed (`~/.agents/skills`, `<state>/skills`) | **that copy's own launcher**, so its skill text and pinned engine match. Falls back to bundled if its engine isn't installed |
| Project or workspace (`<workspace>/.agents/skills`, `<workspace>/skills`) | bundled. A project launcher is repository code, so it never runs automatically (not even for `status`) unless `trustProjectInstalls: true` |

`openclaw impeccable status --project <dir>` lists every visible copy, which one is
served, which launcher runs, and any skill/engine version skew. `impeccable_context`
reports the same in its output. Set `install: "bundled"` to always run the plugin's
own launcher.

## Config (`plugins.entries.impeccable.config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `gate.perEdit` | `true` | Per-edit pass on `write`/`edit`/`apply_patch` |
| `gate.onFinish` | `true` | Deep pass before a run that edited files finishes |
| `gate.maxRevisions` | `1` | Extra model passes the deep pass may request (1–3) |
| `tools` | `true` | Register `impeccable_context` and `impeccable_detect` |
| `install` | `auto` | `auto`: run the served install's launcher when allowed. `bundled`: always the plugin's |
| `trustProjectInstalls` | `false` | Allow running project-level launchers |
| `engineBin` | — | Preinstalled engine binary (sets `IMPECCABLE_BIN`) |
| `editTimeoutMs` / `stopTimeoutMs` | `5000` / `30000` | Engine budgets |

## Safety properties

- **No implicit downloads.** Hooks and tools resolve the engine with the launcher's
  probe mode (`IMPECCABLE_LAUNCHER_PROBE=1`), which never fetches. Only
  `openclaw impeccable engine install` downloads, and the upstream launcher verifies
  the download against the pinned `engine-checksums.txt`.
- **Fail-open.** A missing engine, a timeout, a crash or malformed output never
  blocks an edit or a reply. The tools return the skill's "Launcher unavailable"
  guidance.
- **Cheap when idle.** The deep pass runs only for runs that called an edit tool, so
  chat turns never spawn the engine.
- **Workspace-confined tools.** `impeccable_detect` and `impeccable_context` reject
  targets outside the session workspace. They accept only paths and http(s) URLs.

## Updating from upstream

```bash
git -C ~/src/impeccable pull
node scripts/sync-upstream.mjs ~/src/impeccable    # rewrites skills/impeccable + UPSTREAM.json
npm test
```

The generator reproduces upstream's per-provider build (`compileProviderBlocks`,
`replacePlaceholders`, `stripRuleMarkers`, the degraded roles) without running
upstream code. At commit `b49177d` its output matches upstream's own generic build
apart from the provider values: scripts path and ask-tool phrasing.

## Development

```bash
npm test                                            # node:test, no dependencies
openclaw plugins lint --root .                      # static host compatibility
```

`openclaw plugins validate` applies only to `defineToolPlugin`/`defineFeaturePlugin`
packages, and it reports the same error for pstack. Check this plugin with `lint`
and `plugins inspect impeccable --runtime --json` instead.

See `NOTICE.md` for licensing and attribution.
