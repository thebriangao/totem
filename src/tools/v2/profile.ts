import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { ProfileOut } from "../../schemas/profile.js";
import { projectProfile } from "../../projections/profile.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerProfile(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_profile",
    "Static account + body data: name, email, height, weight, max HR, resting HR, hidden metrics, stealth mode.",
    {},
    async () => {
      const userId = process.env.WHOOP_USER_ID;
      const bootstrapQuery = userId ? { accountType: "users", id: userId } : {};
      const [bootstrap, hidden_body_comp, hidden_healthspan, stealth] = await Promise.all([
        client.get("/users-service/v2/bootstrap", bootstrapQuery),
        client.get("/users-service/v1/hidden-metrics/BODY_COMP").catch(() => null),
        client.get("/users-service/v1/hidden-metrics/HEALTHSPAN").catch(() => null),
        client.get("/users-service/v1/stealth-mode").catch(() => null),
      ]);
      const projected = projectProfile({ bootstrap, hidden_body_comp, hidden_healthspan, stealth });
      try {
        const out = ProfileOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_profile", e);
        throw e;
      }
    },
  );
}
