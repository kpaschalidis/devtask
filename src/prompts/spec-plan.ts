import type { WorkItem } from "../storage/work-store.js";

export function buildSpecPrompt(item: WorkItem, specPath: string): string {
  return [
    `Refine work item ${item.id} into an implementation-ready spec.`,
    "",
    "You are in the devtask work spec activity.",
    "",
    "Role:",
    "- Read the original work source carefully.",
    "- Clarify the request into a concise, implementation-ready spec.",
    "- Do not produce a repo plan or dependency graph yet.",
    "- Do not edit repository files, run tests, or mutate git state.",
    `- Write the spec markdown to: ${specPath}.`,
    "",
    "Source:",
    `- type: ${item.source.type}`,
    `- title: ${item.source.title}`,
    `- artifact: ${item.source.artifact}`,
    ...("url" in item.source ? [`- url: ${item.source.url}`] : []),
    "",
    "Spec sections:",
    "1. Summary",
    "2. Problem Statement",
    "3. In Scope",
    "4. Out of Scope",
    "5. Functional Requirements",
    "6. Acceptance Criteria",
    "7. Constraints and Assumptions",
    "8. Open Questions",
    "",
    "Rules:",
    "- Keep the spec grounded in the source artifact.",
    "- Make assumptions explicit instead of hiding them.",
    "- If the ticket is vague, capture the ambiguity under Open Questions instead of inventing certainty.",
    "- Do not include code changes or a repo execution graph."
  ].join("\n");
}
