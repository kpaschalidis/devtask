import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { buildWorkBoard, type RepoTaskBoardRow } from "./work-board.js";
import { buildWorkspaceBoard } from "./workspace-board.js";
import { getWorkspaceById, listRegisteredWorkspaces } from "../services/workspace-service.js";

export interface GenerateBoardHtmlOptions {
  workspaceId?: string;
  outDir?: string;
}

export interface BoardHtmlReport {
  workspaceId: string;
  workspaceRoot: string;
  outputPath: string;
  workCount: number;
}

export interface WorkspaceBoardPageRow {
  workId: string;
  title: string;
  source: string;
  status: string;
  repos: string;
  updatedAt: string;
  next: string;
  repoTasks: RepoTaskBoardRow[];
}

export interface WorkspaceBoardPageData {
  workspaceId: string;
  workspaceRoot: string;
  generatedAt: string;
  rows: WorkspaceBoardPageRow[];
}

export interface BoardIndexPageEntry {
  workspaceId: string;
  workspaceRoot: string;
  workCount: number;
}

export async function generateBoardHtmlReports(options: GenerateBoardHtmlOptions = {}): Promise<BoardHtmlReport[]> {
  const outDir = path.resolve(options.outDir ?? "devtask-board-html");
  const workspaces = resolveTargetWorkspaces(options.workspaceId);
  const generatedAt = new Date().toISOString();
  const reports: BoardHtmlReport[] = [];

  fs.mkdirSync(path.join(outDir, "workspaces"), { recursive: true });

  for (const workspace of workspaces) {
    const pageData = await loadWorkspaceBoardPage(resolveWorkspacePaths(workspace.path), generatedAt);
    const outputPath = path.join(outDir, "workspaces", `${workspace.id}.html`);
    fs.writeFileSync(outputPath, renderWorkspaceBoardHtml(pageData, { live: false }));
    reports.push({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      outputPath,
      workCount: pageData.rows.length
    });
  }

  fs.writeFileSync(path.join(outDir, "index.html"), renderIndexHtml(toIndexEntries(reports), generatedAt, { live: false }));
  return reports.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

export async function loadBoardIndexData(workspaceId?: string): Promise<{ generatedAt: string; entries: BoardIndexPageEntry[] }> {
  const workspaces = resolveTargetWorkspaces(workspaceId);
  const entries: BoardIndexPageEntry[] = [];

  for (const workspace of workspaces) {
    const pageData = await loadWorkspaceBoardPage(resolveWorkspacePaths(workspace.path), new Date().toISOString());
    entries.push({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      workCount: pageData.rows.length
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    entries: entries.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  };
}

export async function loadWorkspaceBoardPage(paths: DevtaskPaths, generatedAt: string): Promise<WorkspaceBoardPageData> {
  const rows = await buildWorkspaceBoard(paths);
  return {
    workspaceId: paths.workspaceId ?? path.basename(paths.root),
    workspaceRoot: paths.root,
    generatedAt,
    rows: await Promise.all(
      rows.map(async (row) => ({
        ...row,
        repoTasks: await buildWorkBoard(paths, row.workId)
      }))
    )
  };
}

export function resolveTargetWorkspaces(workspaceId?: string): Array<{ id: string; path: string }> {
  if (workspaceId) {
    const workspace = getWorkspaceById(workspaceId);
    return [{ id: workspace.id, path: workspace.path }];
  }

  const workspaces = listRegisteredWorkspaces();
  if (workspaces.length > 0) {
    return workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path }));
  }

  const current = resolveWorkspacePaths();
  return [{ id: current.workspaceId ?? path.basename(current.root), path: current.root }];
}

export function renderIndexHtml(
  reports: BoardIndexPageEntry[],
  generatedAt: string,
  options: { live: boolean; workspaceId?: string } = { live: false }
): string {
  const body = reports.length === 0
    ? `<p class="empty">No workspaces were available.</p>`
    : reports
      .map(
        (report) => `
          <a class="workspace-card" href="${escapeHtml(workspaceHref(report.workspaceId, options.live))}">
            <span class="workspace-id">${escapeHtml(report.workspaceId)}</span>
            <span class="workspace-meta">${escapeHtml(report.workCount.toString())} work items</span>
            <span class="workspace-path">${escapeHtml(report.workspaceRoot)}</span>
          </a>`
      )
      .join("\n");

  return renderHtmlDocument("Devtask Board", `
    <header class="page-header">
      <div>
        <p class="eyebrow">Devtask Board</p>
        <h1>Workspace Reports</h1>
        <p class="subtle" data-generated-at>Generated ${escapeHtml(formatTimestamp(generatedAt))}</p>
      </div>
      ${options.live ? `<button class="refresh-button" type="button" data-refresh-button>Refresh</button>` : ""}
    </header>
    <section class="card-grid" data-index-grid>
      ${body}
    </section>
    ${options.live ? renderLiveIndexScript(options.workspaceId) : ""}
  `);
}

export function renderWorkspaceBoardHtml(
  data: WorkspaceBoardPageData,
  options: { live: boolean } = { live: false }
): string {
  const summary = summarizeWorkspace(data.rows);
  const workCards = renderWorkspaceRows(data.rows);

  return renderHtmlDocument(`Devtask Board · ${data.workspaceId}`, `
    <header class="page-header">
      <div>
        <p class="eyebrow">Devtask Board</p>
        <h1 data-workspace-title>${escapeHtml(data.workspaceId)}</h1>
        <p class="subtle" data-workspace-root>${escapeHtml(data.workspaceRoot)}</p>
      </div>
      ${options.live ? `<button class="refresh-button" type="button" data-refresh-button>Refresh</button>` : ""}
      <div class="summary-row" data-summary-row>
        ${renderSummaryCards(summary)}
      </div>
      <p class="subtle" data-generated-at>Generated ${escapeHtml(formatTimestamp(data.generatedAt))}</p>
      <p><a class="back-link" href="${options.live ? "/" : "../index.html"}">All workspaces</a></p>
    </header>
    <section class="work-list" data-work-list>
      ${workCards}
    </section>
    ${options.live ? renderLiveWorkspaceScript(data.workspaceId) : ""}
  `);
}

function renderWorkspaceRows(rows: WorkspaceBoardPageRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No work items in this workspace.</p>`;
  }

  return rows
    .map(
      (row) => `
        <section class="work-card">
          <div class="work-card-header">
            <div>
              <p class="eyebrow">${escapeHtml(row.workId)}</p>
              <h2>${escapeHtml(row.title)}</h2>
            </div>
            <span class="status-chip status-${escapeClass(row.status)}">${escapeHtml(row.status)}</span>
          </div>
          <div class="meta-grid">
            <div><span class="label">Source</span><span>${escapeHtml(row.source)}</span></div>
            <div><span class="label">Repos</span><span>${escapeHtml(row.repos)}</span></div>
            <div><span class="label">Updated</span><span>${escapeHtml(formatTimestamp(row.updatedAt))}</span></div>
            <div><span class="label">Next</span><code>${escapeHtml(row.next)}</code></div>
          </div>
          ${renderRepoTaskTable(row.repoTasks)}
        </section>`
    )
    .join("\n");
}

function renderRepoTaskTable(rows: RepoTaskBoardRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No repo tasks.</p>`;
  }

  const body = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.repo)}</td>
          <td>${escapeHtml(row.phase)}</td>
          <td><span class="status-chip status-${escapeClass(row.status)}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.blocked)}</td>
          <td>${escapeHtml(row.check)}</td>
          <td>${escapeHtml(row.review)}</td>
          <td>${escapeHtml(row.pr)}</td>
          <td><code>${escapeHtml(row.next)}</code></td>
        </tr>`
    )
    .join("\n");

  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>Phase</th>
            <th>Status</th>
            <th>Blocked</th>
            <th>Check</th>
            <th>Review</th>
            <th>PR</th>
            <th>Next</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function summarizeWorkspace(rows: WorkspaceBoardPageRow[]): {
  total: number;
  executing: number;
  blocked: number;
  materialized: number;
} {
  return rows.reduce(
    (summary, row) => ({
      total: summary.total + 1,
      executing: summary.executing + (row.status === "executing" ? 1 : 0),
      blocked: summary.blocked + (row.status.includes("blocked") || row.repoTasks.some((task) => task.status === "blocked") ? 1 : 0),
      materialized: summary.materialized + (row.status === "materialized" ? 1 : 0)
    }),
    { total: 0, executing: 0, blocked: 0, materialized: 0 }
  );
}

function toIndexEntries(reports: BoardHtmlReport[]): BoardIndexPageEntry[] {
  return reports.map((report) => ({
    workspaceId: report.workspaceId,
    workspaceRoot: report.workspaceRoot,
    workCount: report.workCount
  }));
}

function renderSummaryCards(summary: ReturnType<typeof summarizeWorkspace>): string {
  return [
    ["Work Items", summary.total.toString()],
    ["Executing", summary.executing.toString()],
    ["Blocked", summary.blocked.toString()],
    ["Materialized", summary.materialized.toString()]
  ]
    .map(
      ([label, value]) => `<div class="summary-card"><span class="metric">${escapeHtml(value)}</span><span class="label">${escapeHtml(label)}</span></div>`
    )
    .join("");
}

function renderLiveIndexScript(workspaceId?: string): string {
  const apiPath = workspaceId ? `/api/index?workspace=${encodeURIComponent(workspaceId)}` : "/api/index";
  return `<script>
const refreshButton = document.querySelector("[data-refresh-button]");
const grid = document.querySelector("[data-index-grid]");
const generatedAt = document.querySelector("[data-generated-at]");
async function refreshIndex() {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing...";
  try {
    const response = await fetch(${JSON.stringify(apiPath)}, { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to refresh board");
    const data = await response.json();
    generatedAt.textContent = "Generated " + formatTimestamp(data.generatedAt);
    grid.innerHTML = data.entries.length === 0
      ? '<p class="empty">No workspaces were available.</p>'
      : data.entries.map((entry) => \`
          <a class="workspace-card" href="\${workspaceHref(entry.workspaceId)}">
            <span class="workspace-id">\${escapeHtml(entry.workspaceId)}</span>
            <span class="workspace-meta">\${escapeHtml(String(entry.workCount))} work items</span>
            <span class="workspace-path">\${escapeHtml(entry.workspaceRoot)}</span>
          </a>\`).join("");
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
  }
}
function workspaceHref(id) { return "/workspaces/" + encodeURIComponent(id); }
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function formatTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
refreshButton.addEventListener("click", refreshIndex);
</script>`;
}

function renderLiveWorkspaceScript(workspaceId: string): string {
  return `<script>
const refreshButton = document.querySelector("[data-refresh-button]");
const titleNode = document.querySelector("[data-workspace-title]");
const rootNode = document.querySelector("[data-workspace-root]");
const summaryRow = document.querySelector("[data-summary-row]");
const generatedAt = document.querySelector("[data-generated-at]");
const workList = document.querySelector("[data-work-list]");
async function refreshWorkspace() {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing...";
  try {
    const response = await fetch("/api/workspaces/" + encodeURIComponent(${JSON.stringify(workspaceId)}), { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to refresh workspace");
    const data = await response.json();
    titleNode.textContent = data.workspaceId;
    rootNode.textContent = data.workspaceRoot;
    generatedAt.textContent = "Generated " + formatTimestamp(data.generatedAt);
    summaryRow.innerHTML = renderSummary(data.rows);
    workList.innerHTML = renderRows(data.rows);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
  }
}
function renderSummary(rows) {
  const summary = rows.reduce((acc, row) => {
    acc.total += 1;
    if (row.status === "executing") acc.executing += 1;
    if (row.status.includes("blocked") || row.repoTasks.some((task) => task.status === "blocked")) acc.blocked += 1;
    if (row.status === "materialized") acc.materialized += 1;
    return acc;
  }, { total: 0, executing: 0, blocked: 0, materialized: 0 });
  return [
    ["Work Items", summary.total],
    ["Executing", summary.executing],
    ["Blocked", summary.blocked],
    ["Materialized", summary.materialized]
  ].map(([label, value]) => \`<div class="summary-card"><span class="metric">\${escapeHtml(String(value))}</span><span class="label">\${escapeHtml(label)}</span></div>\`).join("");
}
function renderRows(rows) {
  if (rows.length === 0) return '<p class="empty">No work items in this workspace.</p>';
  return rows.map((row) => \`
    <section class="work-card">
      <div class="work-card-header">
        <div>
          <p class="eyebrow">\${escapeHtml(row.workId)}</p>
          <h2>\${escapeHtml(row.title)}</h2>
        </div>
        <span class="status-chip status-\${escapeClass(row.status)}">\${escapeHtml(row.status)}</span>
      </div>
      <div class="meta-grid">
        <div><span class="label">Source</span><span>\${escapeHtml(row.source)}</span></div>
        <div><span class="label">Repos</span><span>\${escapeHtml(row.repos)}</span></div>
        <div><span class="label">Updated</span><span>\${escapeHtml(formatTimestamp(row.updatedAt))}</span></div>
        <div><span class="label">Next</span><code>\${escapeHtml(row.next)}</code></div>
      </div>
      \${renderRepoTasks(row.repoTasks)}
    </section>\`).join("");
}
function renderRepoTasks(rows) {
  if (rows.length === 0) return '<p class="empty">No repo tasks.</p>';
  return \`<div class="table-shell"><table><thead><tr><th>Repo</th><th>Phase</th><th>Status</th><th>Blocked</th><th>Check</th><th>Review</th><th>PR</th><th>Next</th></tr></thead><tbody>\${rows.map((row) => \`
    <tr>
      <td>\${escapeHtml(row.repo)}</td>
      <td>\${escapeHtml(row.phase)}</td>
      <td><span class="status-chip status-\${escapeClass(row.status)}">\${escapeHtml(row.status)}</span></td>
      <td>\${escapeHtml(row.blocked)}</td>
      <td>\${escapeHtml(row.check)}</td>
      <td>\${escapeHtml(row.review)}</td>
      <td>\${escapeHtml(row.pr)}</td>
      <td><code>\${escapeHtml(row.next)}</code></td>
    </tr>\`).join("")}</tbody></table></div>\`;
}
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function escapeClass(value) { return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-"); }
function formatTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
refreshButton.addEventListener("click", refreshWorkspace);
</script>`;
}

function workspaceHref(workspaceId: string, live: boolean): string {
  return live ? `/workspaces/${encodeURIComponent(workspaceId)}` : `./workspaces/${workspaceId}.html`;
}

function renderHtmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: #fffdf8;
        --panel-strong: #fffaf0;
        --text: #1f1f1a;
        --muted: #6b665c;
        --line: #ddd2bf;
        --accent: #0d5c63;
        --accent-soft: #dff0ef;
        --warning: #9a3412;
        --warning-soft: #ffedd5;
        --danger: #8b1e3f;
        --danger-soft: #fde2ea;
        --shadow: 0 18px 40px rgba(56, 45, 18, 0.08);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(13, 92, 99, 0.08), transparent 28%),
          linear-gradient(180deg, #f8f3ea 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }

      .page-header {
        margin-bottom: 24px;
        display: grid;
        gap: 16px;
      }

      .eyebrow,
      .label,
      th {
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-size: 12px;
      }

      .eyebrow,
      .subtle,
      .label {
        color: var(--muted);
      }

      h1, h2, p {
        margin: 0;
      }

      h1 {
        font-size: clamp(2rem, 4vw, 3.4rem);
        line-height: 1;
        margin: 6px 0 10px;
      }

      h2 {
        font-size: 1.45rem;
        line-height: 1.15;
      }

      .card-grid,
      .work-list {
        display: grid;
        gap: 18px;
      }

      .workspace-card,
      .work-card,
      .summary-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        box-shadow: var(--shadow);
      }

      .workspace-card {
        display: grid;
        gap: 8px;
        padding: 20px;
        color: inherit;
        text-decoration: none;
      }

      .workspace-id {
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 1rem;
        font-weight: 700;
      }

      .workspace-meta,
      .workspace-path,
      .subtle,
      code {
        font-size: 0.95rem;
      }

      .workspace-path,
      code {
        word-break: break-word;
      }

      .summary-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin: 0;
      }

      .summary-card {
        padding: 16px;
        background: var(--panel-strong);
      }

      .metric {
        display: block;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 2rem;
        font-weight: 700;
        color: var(--accent);
      }

      .work-card {
        padding: 20px;
      }

      .work-card-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
        margin-bottom: 16px;
      }

      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }

      .meta-grid div {
        display: grid;
        gap: 4px;
      }

      .status-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 6px 10px;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.85rem;
        font-weight: 600;
        background: var(--accent-soft);
        color: var(--accent);
      }

      .status-blocked,
      .status-failed,
      .status-plan-failed {
        background: var(--danger-soft);
        color: var(--danger);
      }

      .status-paused,
      .status-pending {
        background: var(--warning-soft);
        color: var(--warning);
      }

      .refresh-button {
        justify-self: start;
        appearance: none;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fffdf8;
        border-radius: 999px;
        padding: 10px 16px;
        font: 600 0.95rem "Avenir Next", "Segoe UI", sans-serif;
        cursor: pointer;
      }

      .refresh-button:disabled {
        opacity: 0.7;
        cursor: wait;
      }

      .table-shell {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 14px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 720px;
        background: var(--panel);
      }

      th,
      td {
        text-align: left;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }

      tbody tr:last-child td {
        border-bottom: 0;
      }

      .back-link {
        color: var(--accent);
      }

      .empty {
        padding: 20px;
        border: 1px dashed var(--line);
        border-radius: 16px;
        background: rgba(255, 253, 248, 0.75);
      }

      @media (max-width: 700px) {
        main {
          padding: 24px 14px 48px;
        }

        .work-card-header {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>
`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeClass(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
