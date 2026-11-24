# Notices

## Impeccable

`skills/impeccable/` is generated from Impeccable by Paul Bakaus
(https://github.com/pbakaus/impeccable, https://impeccable.style), licensed under
the Apache License 2.0. Copyright 2025 Paul Bakaus. The exact upstream commit is
recorded in `UPSTREAM.json`.

Modifications made by this package, as required by Apache-2.0 §4(b):
`scripts/sync-upstream.mjs` renders upstream's `skill/` sources for an OpenClaw
target. It substitutes the provider placeholders (`{{scripts_path}}` →
`{baseDir}/scripts`, the ask-tool sentence, the command prefix), removes other
harnesses' conditional blocks and rule markers, generates
`reference/degraded/*.md` from upstream's agent definitions, and appends an
"OpenClaw" section to `SKILL.md`. The scripts in `skills/impeccable/scripts/`
are copied unmodified.

The plugin runtime (`index.mjs`, `src/`, `scripts/`, `test/`) is original to
this package and is also offered under Apache-2.0.

The Impeccable engine binary is not part of this package. The upstream launcher
downloads it from Impeccable's GitHub releases and verifies it against
`skills/impeccable/scripts/engine-checksums.txt` when an operator runs
`openclaw impeccable engine install`.

## Third-party content carried from upstream

### Platform Design Skills

`skills/impeccable/reference/ios.md` and `reference/android.md` are distilled by
upstream from ehmo's `platform-design-skills` (Apple Human Interface Guidelines
and Material Design 3 rules), rewritten in Impeccable's voice.

- Original work: https://github.com/ehmo/platform-design-skills
- License: MIT. Full text in `licenses/platform-design-skills.LICENSE`.

### modern-screenshot

`skills/impeccable/scripts/modern-screenshot.umd.js` is the minified browser
bundle of modern-screenshot, shipped unmodified by upstream for live-mode
screenshots.

- Original work: https://github.com/qq15725/modern-screenshot
- License: MIT, Copyright (c) 2021-present wxm. Full text in
  `licenses/modern-screenshot.LICENSE`.
