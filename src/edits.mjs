// Which files did a write / edit / apply_patch call touch?
//
// OpenClaw's file tools take workspace-relative or absolute paths. The
// engine decides which of them are UI files; this module only reports what
// was written, so deleted files are left out.

import os from "node:os";
import path from "node:path";

export const EDIT_TOOLS = Object.freeze(["write", "edit", "apply_patch"]);

const PATCH_HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;

/** Paths written by an apply_patch `input` (Add, Update, and Move targets). */
export function parseApplyPatchPaths(input) {
  if (typeof input !== "string") return [];
  const out = [];
  let lastUpdate = -1;
  for (const m of input.matchAll(PATCH_HEADER)) {
    const [, kind, raw] = m;
    if (kind === "Delete File") continue;
    if (kind === "Move to" && lastUpdate >= 0) {
      out[lastUpdate] = raw; // the file now lives at the move target
      lastUpdate = -1;
      continue;
    }
    out.push(raw);
    lastUpdate = kind === "Update File" ? out.length - 1 : -1;
  }
  return out;
}

export function resolveToolPath(raw, cwd) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  else if (p.startsWith("./~/")) p = p.slice(2);
  return path.resolve(cwd, p);
}

/** Absolute, de-duplicated paths an edit tool call wrote. */
export function editedPaths(toolName, args, cwd) {
  if (!args || typeof args !== "object") return [];
  let raws = [];
  if (toolName === "apply_patch") raws = parseApplyPatchPaths(args.input ?? args.patch ?? args.command);
  else if (toolName === "write" || toolName === "edit") raws = [args.path ?? args.file_path];
  const out = [];
  for (const raw of raws) {
    const abs = resolveToolPath(raw, cwd);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}
