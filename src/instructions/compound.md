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
