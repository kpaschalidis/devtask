import fs from "node:fs";
import type { DevtaskPaths } from "../infra/paths.js";
import type { WorkspaceRepo } from "../storage/workspace-repos.js";
import type { WorkItem } from "../storage/work-store.js";

export function buildGlobalPlanPrompt(
  paths: DevtaskPaths,
  workItem: WorkItem,
  repos: WorkspaceRepo[],
  planPath: string,
  graphPath: string,
  specPath: string,
  memory = ""
): string {
  const hasSpec = fs.existsSync(specPath) && fs.readFileSync(specPath, "utf8").trim().length > 0;
  return [
    `Plan work item ${workItem.id}.`,
    "",
    "You are in the devtask work planning activity.",
    "",
    "Role:",
    "- Read the work source and workspace repo inventory.",
    "- Decide which repos are likely affected.",
    "- Produce a proposed execution graph only.",
    "- Do not create repo tasks.",
    "- Do not implement code.",
    "- Do not edit repository files.",
    "- Do not run tests or mutate git state.",
    `- Write the human-readable plan to: ${planPath}.`,
    `- Write the machine-readable graph JSON to: ${graphPath}.`,
    "",
    "Primary planning input:",
    "",
    ...(hasSpec
      ? [`- spec artifact: ${specPath}`, `- original source artifact: ${workItem.source.artifact}`]
      : [
          `- type: ${workItem.source.type}`,
          `- title: ${workItem.source.title}`,
          `- artifact: ${workItem.source.artifact}`,
          ...("url" in workItem.source ? [`- url: ${workItem.source.url}`] : [])
        ]),
    "",
    "Workspace repos:",
    "",
    ...(repos.length
      ? repos.map((repo) =>
          [
            `- ${repo.id}`,
            `  - kind: ${repo.kind ?? "-"}`,
            `  - path: ${repo.repoPath}`,
            `  - scope: ${repo.scope ?? "."}`
          ].join("\n")
        )
      : ["- (none configured)"]),
    "",
    ...(hasSpec
      ? ["Read the work spec artifact first. Use the original source only for additional context."]
      : ["Read the work source artifact before planning."]),
    "",
    "Markdown plan sections:",
    "1. Summary",
    "2. Source Inputs",
    "3. Affected Repos",
    "4. Proposed Execution Graph",
    "5. Ownership Boundaries",
    "6. Dependencies",
    "7. Validation Plan",
    "8. Risks and Open Questions",
    "",
    "Graph JSON schema:",
    "",
    "```json",
    "{",
    '  "schemaVersion": 1,',
    `  "workId": "${workItem.id}",`,
    '  "tasks": [',
    "    {",
    '      "id": "short-task-id",',
    '      "repoId": "workspace-repo-id",',
    '      "goal": "repo/scope-local goal",',
    '      "owns": ["path/or/scope/**"],',
    '      "dependencies": [',
    "        {",
    '          "task": "other-task-id",',
    '          "type": "run|review|validation",',
    '          "reason": "why this dependency exists"',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "validation": ["check command or validation responsibility"],',
    '  "openQuestions": []',
    "}",
    "```",
    "",
    "Rules:",
    "- Use only configured workspace repos; do not invent repo IDs.",
    "- If no configured repo clearly applies, output an empty tasks array and explain the open question.",
    "- Prefer explicit ownership boundaries over broad repository ownership.",
    "- Dependencies must reference proposed task ids.",
    "- Use dependency type `run` only when the dependent task cannot safely start before the dependency is done.",
    "- Use `validation` when tasks can implement in parallel but final integration validation depends on both.",
    "- Prefer parallel execution unless there is a concrete dependency blocker.",
    "- Keep the graph proposed only; a later materialization step will create repo-local tasks and worktrees.",
    "- The graph file must contain JSON only, with no Markdown fences.",
    "",
    ...(memory ? [memory, ""] : []),
    `Workspace root: ${paths.root}`
  ].join("\n");
}
