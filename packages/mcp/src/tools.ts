import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig, RunwayClient, Runtime } from "./client.js";
import { tarProject } from "./tar.js";

const RUNTIMES = ["node", "python", "go", "static"] as const;
const SCAN_THRESHOLDS = ["none", "low", "medium", "high", "critical"] as const;

interface DeployResponse {
  status?: string;
  error?: string;
  image_tag?: string;
  deploy_id?: number;
  scan?: {
    status?: string;
    counts?: Record<string, number>;
    findings?: Array<{
      id?: string;
      severity?: string;
      source?: string;
      pkg?: string;
      version?: string;
      fixedVersion?: string;
      title?: string;
      location?: string;
    }>;
    truncated?: boolean;
    total_findings?: number;
    error?: string;
  };
  hint?: string;
  [k: string]: unknown;
}

function formatScanForAgent(scan: DeployResponse["scan"]): string {
  if (!scan) return "No scan data.";
  if (scan.status === "skipped") {
    return `Scan skipped${scan.error ? ` (${scan.error})` : ""}.`;
  }
  const c = scan.counts ?? {};
  const summary = `Scan: ${scan.status?.toUpperCase() ?? "?"} — critical=${c.critical ?? 0} high=${c.high ?? 0} medium=${c.medium ?? 0} low=${c.low ?? 0}`;
  const findings = scan.findings ?? [];
  if (findings.length === 0) return `${summary}. No findings.`;
  const topN = findings.slice(0, 10).map((f) => {
    const where = f.pkg
      ? `${f.pkg}${f.version ? `@${f.version}` : ""}`
      : f.location ?? "";
    const fix = f.fixedVersion ? ` (fix: ${f.fixedVersion})` : "";
    return `  [${f.severity}] ${f.source}/${f.id} ${where}${fix}${f.title ? ` — ${f.title}` : ""}`;
  });
  const truncated =
    scan.truncated || findings.length > topN.length
      ? `\n  … ${((scan.total_findings ?? findings.length) - topN.length)} more`
      : "";
  return [summary, "", ...topN, truncated].filter(Boolean).join("\n");
}

export function registerTools(server: McpServer, client: RunwayClient) {
  server.tool(
    "runway_get_config",
    "Fetch the current Runway app configuration (name, runtime, domain, resource limits, and whether it has been configured yet). Call this before deploy to know what the server expects.",
    {},
    async () => {
      const config = await client.getConfig();
      return {
        content: [{ type: "text", text: JSON.stringify(config, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_configure",
    "Configure a freshly created Runway app. Required on first use: sets the app's human-readable name and the runtime (node, python, go, or static). The server derives the public domain from the name and the configured base domain. Ask the user for both values if you don't already have them.",
    {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe("Human-readable app name, e.g. 'My Bot'"),
      runtime: z
        .enum(RUNTIMES)
        .describe("Runtime the app is built with"),
    },
    async ({ name, runtime }) => {
      const config = await client.configure(name, runtime as Runtime);
      return {
        content: [
          {
            type: "text",
            text: [
              `App configured.`,
              `  name:    ${config.name}`,
              `  runtime: ${config.runtime}`,
              `  domain:  ${config.domain ?? "(no base domain configured on server)"}`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "runway_deploy",
    "Deploy the current project to the Runway server. Tars the working directory (respecting .dockerignore and .gitignore), uploads it, and triggers a build-and-run on the server. The app must be configured first — call runway_get_config to check, then runway_configure if needed. A Dockerfile must exist in the project root.",
    {
      project_root: z
        .string()
        .optional()
        .describe(
          "Absolute path to the project directory to deploy. Defaults to the current working directory."
        ),
    },
    async ({ project_root }) => {
      const config = await client.getConfig();
      if (!config.configured) {
        return {
          content: [
            {
              type: "text",
              text:
                "This Runway app has not been configured yet. Ask the user for a " +
                "name and runtime (one of: node, python, go, static), then call " +
                "runway_configure before retrying the deploy.",
            },
          ],
          isError: true,
        };
      }

      const root = project_root ?? process.cwd();
      let tarBuffer: Buffer;
      try {
        tarBuffer = await tarProject(root);
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to package project at ${root}: ${err?.message ?? err}`,
            },
          ],
          isError: true,
        };
      }

      const result = (await client.deploy(tarBuffer)) as DeployResponse;
      const scanText = formatScanForAgent(result.scan);
      const blocked = result.status === "blocked";
      const lines = [
        `Uploaded ${(tarBuffer.length / 1024).toFixed(1)} KB from ${root}.`,
        "",
        blocked
          ? `DEPLOY BLOCKED by security scan. The previous container is still running; the new image (${result.image_tag ?? "?"}) was built but not started.`
          : `Status: ${result.status ?? "?"}`,
        "",
        scanText,
        "",
        result.hint ? `Hint: ${result.hint}` : "",
        "",
        "Full response:",
        JSON.stringify(result, null, 2),
      ].filter((l) => l !== "");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: blocked,
      };
    }
  );

  server.tool(
    "runway_set_scan_threshold",
    "Configure the minimum severity at which deploys are blocked by the security scan. 'none' never blocks (warn-only); 'low' / 'medium' / 'high' / 'critical' block if any finding meets or exceeds that severity. Scans always run; only the blocking behavior changes.",
    {
      threshold: z
        .enum(SCAN_THRESHOLDS)
        .describe(
          "One of: none (warn-only), low, medium, high, critical"
        ),
    },
    async ({ threshold }) => {
      const config = await client.setScanThreshold(threshold);
      return {
        content: [
          {
            type: "text",
            text: `Scan threshold set to '${config.scan_threshold}'. Deploys will ${
              config.scan_threshold === "none"
                ? "never"
                : `be blocked when any finding is ${config.scan_threshold} or higher`
            }.`,
          },
        ],
      };
    }
  );

  server.tool(
    "runway_get_scan",
    "Fetch the most recent security scan report for the Runway app (vulnerabilities, secrets, Dockerfile misconfigurations). Useful after a blocked deploy or to audit the currently running image.",
    {},
    async () => {
      const scan = await client.getLatestScan();
      return {
        content: [{ type: "text", text: JSON.stringify(scan, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_preflight",
    "Run pre-deploy configuration and security checks on the server.",
    {},
    async () => {
      const result = await client.preflight();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_status",
    "Check the current deployment status of the Runway app (created, running, stopped).",
    {},
    async () => {
      const status = await client.getStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_logs",
    "Fetch recent logs from the deployed Runway app container.",
    {},
    async () => {
      const logs = await client.getLogs();
      return {
        content: [{ type: "text", text: JSON.stringify(logs, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_get_env",
    "Fetch environment variables configured for the Runway app. These are injected into the container at runtime.",
    {},
    async () => {
      const result = await client.getEnv();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_set_env",
    "Set environment variables for the Runway app. Variables are merged with existing ones — pass only the keys you want to add or update. Values are injected into the container on the next deploy. Do not store secrets in code; use this endpoint instead.",
    {
      env: z
        .record(z.string())
        .describe(
          'Key-value pairs to set, e.g. {"DATABASE_URL": "postgres://...", "NODE_ENV": "production"}'
        ),
    },
    async ({ env }) => {
      const result = await client.setEnv(env);
      return {
        content: [
          {
            type: "text",
            text: `Set ${Object.keys(env).length} env var(s).\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "runway_delete_env",
    "Delete a single environment variable from the Runway app.",
    {
      key: z.string().describe("The env var name to remove"),
    },
    async ({ key }) => {
      const result = await client.deleteEnvVar(key);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_get_volumes",
    "Fetch the persistent volume mounts configured for the Runway app. Volumes survive container rebuilds and redeploys.",
    {},
    async () => {
      const result = await client.getVolumes();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_set_volumes",
    "Set persistent volume mount paths for the Runway app. Each path is an absolute path inside the container that will be backed by a named Docker volume. Data in these paths persists across redeploys. This replaces the full list of mounts — include all paths you want.",
    {
      mount_paths: z
        .array(z.string())
        .describe(
          'Absolute container paths to persist, e.g. ["/app/data", "/app/uploads"]'
        ),
    },
    async ({ mount_paths }) => {
      const result = await client.setVolumes(mount_paths);
      return {
        content: [
          {
            type: "text",
            text: `Configured ${mount_paths.length} volume mount(s).\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "runway_set_domain",
    "Set a custom domain for the Runway app. The domain must have a DNS record (CNAME or A) pointing to the Runway server. Traefik will automatically issue a Let's Encrypt TLS certificate for it. Set to null to remove the custom domain.",
    {
      custom_domain: z
        .string()
        .nullable()
        .describe(
          'The custom domain, e.g. "app.example.com". Pass null to remove.'
        ),
    },
    async ({ custom_domain }) => {
      const result = await client.setCustomDomain(custom_domain);
      return {
        content: [
          {
            type: "text",
            text: custom_domain
              ? `Custom domain set to ${custom_domain}. Make sure DNS points to the Runway server.\n\n${JSON.stringify(result, null, 2)}`
              : `Custom domain removed.\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "runway_set_healthcheck",
    "Configure a health check path for the Runway app. The server will periodically GET this path inside the container. If it returns a non-2xx status, the container is marked unhealthy. Set to null to disable health checks.",
    {
      path: z
        .string()
        .nullable()
        .describe(
          'HTTP path to check, e.g. "/health" or "/api/ping". Pass null to disable.'
        ),
    },
    async ({ path }) => {
      const result = await client.setHealthCheck(path);
      return {
        content: [
          {
            type: "text",
            text: path
              ? `Health check configured: GET ${path}\n\n${JSON.stringify(result, null, 2)}`
              : `Health check disabled.\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "runway_rollback",
    "Roll back the Runway app to its previous successful deploy. Stops the current container and starts one with the previous image. Useful when a deploy introduced a bug. Does not affect env vars, volumes, or other config — only the container image.",
    {},
    async () => {
      const result = await client.rollback();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "runway_package",
    "Generate an optimized Dockerfile and .dockerignore tailored to the Runway app's configured runtime. Requires runway_configure to have been called first.",
    {},
    async () => {
      const config = await client.getConfig();
      if (!config.configured || !config.runtime) {
        return {
          content: [
            {
              type: "text",
              text:
                "Cannot generate a Dockerfile until the app is configured. " +
                "Call runway_configure with a name and runtime first.",
            },
          ],
          isError: true,
        };
      }
      const dockerfile = generateDockerfile(config);
      const dockerignore = generateDockerignore(config);

      return {
        content: [
          {
            type: "text",
            text: [
              "Generated Dockerfile and .dockerignore for your project.",
              "",
              "--- Dockerfile ---",
              dockerfile,
              "",
              "--- .dockerignore ---",
              dockerignore,
            ].join("\n"),
          },
        ],
      };
    }
  );
}

function generateDockerfile(config: AppConfig): string {
  const port = config.port;
  const templates: Record<Runtime, string> = {
    node: `FROM node:24-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
    else npm ci; fi

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --if-present

FROM base
WORKDIR /app
COPY --from=build /app .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE ${port}
CMD ["node", "."]`,

    python: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE ${port}
CMD ["python", "main.py"]`,

    go: `FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server ./...

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/server /server
EXPOSE ${port}
USER nonroot:nonroot
ENTRYPOINT ["/server"]`,

    static: `FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html
EXPOSE 80`,
  };

  return templates[config.runtime!];
}

function generateDockerignore(config: AppConfig): string {
  const common = `node_modules
.git
.env
.env.*
*.md
.DS_Store
Thumbs.db
coverage
.nyc_output
dist
`;

  const extras: Record<Runtime, string> = {
    node: `npm-debug.log*\n`,
    python: `__pycache__\n*.pyc\n.venv\nvenv\n`,
    go: `bin\n*.test\n`,
    static: ``,
  };

  return common + extras[config.runtime!];
}
