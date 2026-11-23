/**
 * What a brand-new server (or a member with no apps yet) sees instead of
 * an empty table: the three real steps to a first deploy, and the optional
 * skill-server install.
 *
 * Everything here is a flow that already exists, so nothing is invented:
 *  - "+ New app" creates an app and its deploy instruction (README,
 *    "Deploying an app", option A; /llms.txt is the reference).
 *  - A developer token comes from /account, and the install command is
 *    `claude mcp add runway-skills --transport http <url>/mcp --header ...`
 *    (README option B; the same command /account prints with a real token).
 * Pure: the caller passes the dashboard domain. The base-domain hint for
 * admins already sits above the apps list on the home page, so it is not
 * repeated here.
 */

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmptyStateInput {
  /** DASHBOARD_DOMAIN, or "" when it is not set. */
  dashboardDomain: string;
}

/** URL of the remote MCP skill server, or a placeholder when unknown. */
export function mcpUrl(dashboardDomain: string): string {
  return dashboardDomain ? `https://${dashboardDomain}/mcp` : "https://YOUR-RUNWAY-DOMAIN/mcp";
}

/** The documented install command, with a placeholder instead of a token. */
export function mcpInstallCommand(dashboardDomain: string): string {
  return `claude mcp add runway-skills --transport http ${mcpUrl(dashboardDomain)} --header "Authorization: Bearer rwd_..."`;
}

export function renderEmptyState(input: EmptyStateInput): string {
  const cmd = mcpInstallCommand(input.dashboardDomain);
  return `<div class="card empty" id="empty-state">
    <div class="empty-hero">
      <h2>Deploy your first app</h2>
      <p class="hint">Runway is running. Create an app, hand its deploy instruction to your coding agent, and it builds and ships the project for you.</p>
      <form method="POST" action="/apps" class="inline-form">
        <button type="submit">+ New app</button>
      </form>
    </div>
    <ol class="steps">
      <li><span class="n">1</span><div><b>Create an app</b><small>Press <em>+ New app</em>. You get an app card with its own API key.</small></div></li>
      <li><span class="n">2</span><div><b>Copy the deploy instruction</b><small>Use <em>Copy deploy instruction</em> on the app card.</small></div></li>
      <li><span class="n">3</span><div><b>Paste it in your agent</b><small>Open your project folder in <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">Claude Code</a> and paste it. The URL appears on the card when the app is live.</small></div></li>
    </ol>
    <div class="empty-opt">
      <h3>Optional: connect the skill server</h3>
      <p class="hint">Gives your agent Runway's built-in deploy skills. <a href="/account">Create a developer token on Account</a> and use the command it shows. The shape of it:</p>
      <div class="cp"><code>${esc(cmd)}</code><button type="button" class="ghost" data-copy="${esc(cmd)}" onclick="copyText(this)">Copy</button></div>
    </div>
    <p class="meta">Need more? <a href="https://github.com/wiggertdehaan/Runway#deploying-an-app" target="_blank" rel="noopener noreferrer">Deploy guide</a> &middot; <a href="${esc(input.dashboardDomain ? `https://${input.dashboardDomain}/llms.txt` : "/llms.txt")}" target="_blank" rel="noopener noreferrer">API docs</a></p>
  </div>`;
}
