import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDevTokenByToken, touchDevToken } from "../db/dev-tokens.js";
import {
  getSkill,
  getSkillFile,
  listEnabledSkills,
  type Skill,
} from "../db/skills.js";

/**
 * Skill-distribution MCP server.
 *
 * Auth: `Authorization: Bearer rwd_<...>` matching a row in
 * `dev_tokens`. The token's `last_used_at` is updated on every
 * successful request so the dashboard can show whether a token is
 * still in active use.
 *
 * Transport: stateless Streamable HTTP (single POST returns a JSON
 * response, no SSE session). One transport + one McpServer instance
 * are created per request — keeps the wire-up trivial and lets
 * multiple developers share the endpoint without server-side state.
 *
 * Resources: each enabled row in the `skills` table is exposed as a
 * resource at `skill://<id>`. The resource body is the SKILL.md file
 * stored in `skill_files` with path "SKILL.md"; companion assets are
 * fetchable at `skill://<id>/<relpath>`.
 */
export const mcpRoutes = new Hono();

const SKILL_URI_PREFIX = "skill://";
const SKILL_MD_PATH = "SKILL.md";

function skillUri(skill: Skill): string {
  return `${SKILL_URI_PREFIX}${skill.id}`;
}

function parseSkillUri(uri: string): { skillId: string; path: string } | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null;
  const rest = uri.slice(SKILL_URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { skillId: rest, path: SKILL_MD_PATH };
  return { skillId: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "runway-skills",
    version: "0.1.0",
  });

  // Always advertise the resources capability, even when there are no
  // skills yet — clients should get an empty resources/list response,
  // not "method not found".
  server.server.registerCapabilities({ resources: { listChanged: false } });

  const skills = listEnabledSkills();
  for (const skill of skills) {
    server.registerResource(
      skill.id,
      skillUri(skill),
      {
        title: skill.name,
        description: skill.description ?? undefined,
        mimeType: "text/markdown",
      },
      async (uri) => {
        const parsed = parseSkillUri(uri.href);
        if (!parsed) throw new Error(`Invalid skill URI: ${uri.href}`);
        const file = getSkillFile(parsed.skillId, parsed.path);
        if (!file) {
          throw new Error(
            `Skill resource not found: ${parsed.skillId}/${parsed.path}`,
          );
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: file.mime_type,
              text: new TextDecoder().decode(file.content),
            },
          ],
        };
      },
    );
  }

  return server;
}

mcpRoutes.all("/mcp", async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const presented = header.slice(7);
  const tokenRow = getDevTokenByToken(presented);
  if (!tokenRow) {
    return c.json({ error: "Invalid developer token" }, 401);
  }
  touchDevToken(tokenRow.id);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
