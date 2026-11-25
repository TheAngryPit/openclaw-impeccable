import { registerImpeccableCli } from "./src/cli.mjs";
import { resolveConfig } from "./src/config.mjs";
import { createEngineProbe } from "./src/engine.mjs";
import { EDIT_TOOLS } from "./src/edits.mjs";
import { createEngineSelector } from "./src/installs.mjs";
import { createDesignGate } from "./src/gate.mjs";
import { createTools } from "./src/tools.mjs";

export const PLUGIN_ID = "impeccable";

export default {
  id: PLUGIN_ID,
  name: "Impeccable for OpenClaw (unofficial)",
  description: "Impeccable frontend design skill, detector tools and design gate for OpenClaw",
  register(api) {
    const config = resolveConfig(api.pluginConfig ?? {});
    const probe = createEngineProbe({ engineBin: config.engineBin });
    const engineFor = createEngineSelector({ config, probe });
    const logger = api.logger;

    if (config.tools) {
      for (const factory of createTools({ config, engineFor })) {
        const name = factory({}).name;
        api.registerTool(factory, { name, workspaceAccess: "execute" });
      }
    }

    if (config.gate.perEdit || config.gate.onFinish) {
      const gate = createDesignGate({ config, engineFor, logger });
      api.registerAgentToolResultMiddleware(gate.toolResultMiddleware, { matcher: [...EDIT_TOOLS] });
      api.on("before_agent_finalize", gate.beforeAgentFinalize, { timeoutMs: config.stopTimeoutMs + 5000 });
    }

    api.registerCli(({ program }) => registerImpeccableCli(program, { config, probe }), {
      descriptors: [
        { name: "impeccable", description: "Impeccable design skill: engine setup, project hook switch, detector", hasSubcommands: true },
      ],
    });
  },
};
