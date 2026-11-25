// `openclaw impeccable …`: operator commands. Installing the engine is the
// only path in this plugin that downloads anything, and it is explicit.

import path from "node:path";
import { engineEnv, runEngine } from "./engine.mjs";
import {
  BUNDLED_INSTALL,
  describeSkew,
  discoverInstalls,
  discoverOtherHarnessInstalls,
  selectInstall,
} from "./installs.mjs";

export function registerImpeccableCli(program, { config, probe, run = runEngine, print = console.log }) {
  const root = program
    .command("impeccable")
    .description("Impeccable design skill: engine setup, project hook switch, detector");

  const selectionFor = (project) => {
    const installs = discoverInstalls({ workspaceDir: path.resolve(project) });
    return { installs, selection: selectInstall(installs, config) };
  };
  const envFor = (install) => engineEnv({ engineBin: config.engineBin, install });

  root
    .command("status")
    .description("Show which Impeccable copy OpenClaw serves, which engine the plugin runs, and other harness installs")
    .option("--project <dir>", "Workspace to resolve project-level installs for", process.cwd())
    .option("--json", "Print JSON")
    .action(async (opts) => {
      const { installs, selection } = selectionFor(opts.project);
      const rows = [];
      for (const install of installs) {
        // Never execute an untrusted project launcher, not even to probe it.
        const mayRun = install.launcher && (install.trusted || config.trustProjectInstalls);
        const engine = mayRun ? await probe({ install, force: true }) : { ok: false, reason: install.launcher ? "untrusted" : "no launcher" };
        rows.push({ ...install, engineReady: engine.ok, engineVersion: engine.version, probed: Boolean(mayRun) });
      }
      const others = discoverOtherHarnessInstalls();
      const skew = describeSkew(selection);
      const status = {
        project: path.resolve(opts.project),
        served: selection.served.skillDir,
        engineFrom: selection.engine.skillDir,
        reason: selection.reason,
        skew,
        installs: rows,
        otherHarnesses: others,
        gate: config.gate,
        mode: config.install,
        trustProjectInstalls: config.trustProjectInstalls,
      };
      if (opts.json) return print(JSON.stringify(status, null, 2));

      print(`project   ${status.project}`);
      print("OpenClaw-visible Impeccable copies (highest precedence first):");
      for (const r of rows) {
        const marks = [r === rows[0] && "served", r.skillDir === selection.engine.skillDir && "engine"].filter(Boolean);
        print(
          `  ${marks.length ? `[${marks.join("+")}]`.padEnd(16) : "".padEnd(16)}${r.scope.padEnd(9)} ` +
            `skill ${String(r.skillVersion ?? "?").padEnd(8)} engine pin ${String(r.enginePin ?? "?").padEnd(7)} ` +
            `${r.engineReady ? `ready (${r.engineVersion})` : r.probed ? "not installed" : "not probed (project launcher)"}  ${r.skillDir}`,
        );
      }
      print(`engine    ${selection.reason}`);
      if (skew) print(`warning   ${skew}`);
      if (rows[0].scope !== "plugin") {
        print(
          `note      the ${rows[0].scope} copy outranks this plugin's skill in OpenClaw, so the model reads that copy's text, which has no OpenClaw section. ` +
            "The gate and the impeccable_* tools still work. To serve the plugin's copy instead, remove that install; `install: bundled` only pins the engine.",
        );
      }
      if (others.length) {
        print("Other harness installs (not loaded by OpenClaw; they share ~/.impeccable and project files):");
        for (const o of others) print(`  ${o.scope.padEnd(20)} skill ${o.skillVersion ?? "?"}  engine pin ${o.enginePin ?? "?"}`);
      }
      print(`gate      per-edit ${config.gate.perEdit ? "on" : "off"} · on-finish ${config.gate.onFinish ? "on" : "off"} · max revisions ${config.gate.maxRevisions}`);
      print("          on by default in every project; `/impeccable hooks off` turns it off for one project (.impeccable/config.json, shared with every harness)");
      if (!rows.find((r) => r.skillDir === selection.engine.skillDir)?.engineReady) {
        print("          engine missing: run `openclaw impeccable engine install`");
      }
    });

  const engine = root.command("engine").description("Manage the Impeccable engine binary");
  engine
    .command("install")
    .description("Download and checksum-verify the pinned engine into ~/.impeccable via the upstream launcher")
    .option("--project <dir>", "Install the engine pinned by the copy the plugin runs for this workspace", process.cwd())
    .option("--bundled", "Install the engine pinned by this plugin's own copy")
    .action(async (opts) => {
      const install = opts.bundled ? BUNDLED_INSTALL : selectionFor(opts.project).selection.engine;
      print(`installing engine ${install.enginePin ?? ""} for the ${install.scope} copy (${install.skillDir})`);
      const r = await run(["engine-probe"], { launcher: install.launcher, cwd: install.skillDir, env: envFor(install), timeoutMs: 300_000 });
      probe.invalidate?.();
      if (r.stdout.trim()) print(r.stdout.trim());
      if (r.stderr.trim()) print(r.stderr.trim());
      const after = await probe({ install, force: true });
      if (!after.ok) {
        process.exitCode = 1;
        return print(`engine install failed${r.error ? `: ${r.error}` : ""}`);
      }
      print(`engine ${after.version} ready`);
    });

  root
    .command("hooks")
    .description("Turn the design gate off or back on for one project (writes its .impeccable/config.json)")
    .argument("<action>", "on | off | status | reset | ignore-rule | ignore-file | ignore-value")
    .argument("[args...]", "action arguments")
    .option("--project <dir>", "Project directory", process.cwd())
    .action(async (action, args, opts) => passthrough(["hooks", action, ...args], opts.project));

  root
    .command("detect")
    .description("Run the detector (same flags as `impeccable detect`)")
    .argument("[args...]", "files, directories, URLs and detect flags")
    .option("--project <dir>", "Working directory", process.cwd())
    .allowUnknownOption(true)
    .action(async (args, opts) => passthrough(["detect", ...args], opts.project));

  async function passthrough(args, cwd) {
    const { selection } = selectionFor(cwd);
    let install = selection.engine;
    if (!(await probe({ install, force: true })).ok) {
      install = BUNDLED_INSTALL;
      if (!(await probe({ install, force: true })).ok) {
        process.exitCode = 1;
        return print("engine not installed: run `openclaw impeccable engine install`");
      }
    }
    const r = await run(args, { launcher: install.launcher, cwd, env: envFor(install), timeoutMs: 300_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error) print(r.error);
    process.exitCode = r.code ?? 1;
  }

  return root;
}
