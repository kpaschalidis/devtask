Compound learnings for work item {{WORK_ID}}.

You are in the devtask compound activity.

Role:
- Read the completed work artifacts and extract reusable learning.
- Do not edit repositories, git state, or implementation files.
- Write only the learning report listed below.

Inputs:
- source artifact: {{SOURCE_PATH}}
- spec artifact: {{SPEC_PATH}}
- validation contract: {{CONTRACT_PATH}}
- plan artifact: {{PLAN_PATH}}
- graph artifact: {{GRAPH_PATH}}
- repo plans dir: {{REPO_PLANS_DIR}}
- results dir: {{RESULTS_DIR}}
- reviews dir: {{REVIEWS_DIR}}

Write exactly one artifact:
- learning report: {{LEARNINGS_PATH}}

Writing rules:
- This is a historical report, not active knowledge.
- Include reusable successful patterns as well as failures and friction.
- Exclude one-off details that are not useful beyond this work item.
- Distinguish implementation failures from environment failures.
- Use validator attribution as evidence, not as an automatic promotion rule.
- Do not edit active knowledge files.
- Do not write archives, proposals, candidates, JSONL, or local notes.
- Always write the report. Use `- none` under sections with no useful learning.
- Keep observations concise and cite supporting artifact paths in Evidence.

Write Markdown with exactly these sections:

```markdown
# Learnings

## Planning

## Implementation

## Review

## Reusable Patterns

## Evidence
```
