Compound learnings for work item {{WORK_ID}}.

You are in the devtask compound activity.

Role:
- Read the completed work artifacts and extract reusable guidance.
- Do not edit repositories, git state, or implementation files.
- Write only the explicit improvement artifacts listed below.

Inputs:
- source artifact: {{SOURCE_PATH}}
- spec artifact: {{SPEC_PATH}}
- plan artifact: {{PLAN_PATH}}
- graph artifact: {{GRAPH_PATH}}
- repo plans dir: {{REPO_PLANS_DIR}}
- results dir: {{RESULTS_DIR}}
- reviews dir: {{REVIEWS_DIR}}

Write these artifacts:
- planning guidance: {{SHARED_PLANNING_PATH}}
- implementation guidance: {{SHARED_IMPLEMENTATION_PATH}}
- review guidance: {{SHARED_REVIEW_PATH}}
- reusable patterns: {{SHARED_PATTERNS_PATH}}
- local notes: {{LOCAL_NOTES_PATH}}

Writing rules:
- Each file must be concise, specific, and reusable beyond this single work item.
- If there is nothing useful for a file, write a short heading and `- none`.
- Planning guidance should focus on scoping, repo boundaries, and dependency lessons.
- Implementation guidance should focus on execution constraints, common pitfalls, and recovery tactics.
- Review guidance should focus on checks, bug patterns, and reviewer attention points.
- Reusable patterns should capture concrete approaches worth repeating.
- Local notes may include machine-local or tentative reminders that should not be promoted to shared guidance.

Use Markdown in every output file.

--- Lesson proposals ---

After writing the guidance files, generate lesson proposals from validator failures.

Proposals output: {{PROPOSALS_PATH}}

For each failed assertion in each result.json under {{RESULTS_DIR}}, determine whether the failure warrants a lesson proposal. Use the `attribution` field on each assertion to decide:

| attribution | action |
|---|---|
| `null` or `environment` | skip — no instruction change warranted |
| `wrong-repo` | propose to planning phase |
| `spec-gap` | propose to planning phase |
| `implementation-gap` | propose to implementation phase |
| `inconclusive` | propose to review phase |

For each assertion that warrants a proposal, write one JSON line to {{PROPOSALS_PATH}} (JSONL format — one valid JSON object per line, no trailing commas, no array wrapper):

```json
{"id":"<workId>-<repoId>-<assertionId>","workId":"<workId>","repoId":"<repoId>","assertionId":"<VAL-XXX>","phase":"planning|implementation|review","lesson":"one sentence: what instruction would have prevented this failure","trigger":"what failed and why, in one sentence","confidence":"high|medium|low","evidence":"<result-file-path>#<assertionId>","proposedAt":"<ISO timestamp>","status":"pending"}
```

Idempotency rules:
- Before writing any proposal, read {{PROPOSALS_PATH}} if it exists. If a proposal with the same `id` already exists, skip it.
- Only write proposals for assertions with status "failed". Skip "passed" and "skipped".
- Do not propose lessons for attribution values `null` or `environment`.
- If there are no failed assertions with a proposable attribution, do not create the file.

Use high confidence when the attribution is clear and the fix is obvious. Use medium when the failure pattern is plausible but may have other causes. Use low when the assertion failed but the lesson is speculative.
