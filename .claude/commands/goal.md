You are starting a working session on devtask — a local-first tool for AI-assisted development.

Do this now:
1. Read `.local-only/ROADMAP.md` and identify the top unchecked priority
2. Run `git log --oneline -5` and `git status` to understand current branch and last changes
3. If $ARGUMENTS is provided, treat it as the session focus and override the roadmap default

Then respond with exactly:

**Goal:** one sentence — what we are doing this session
**Context:** 2–3 bullets — what is already done, what is in progress, what is blocked
**First action:** the single concrete next step to take right now

After responding, stay in this mode for the rest of the session:
- Prefer doing over explaining
- Ask only when genuinely blocked on a decision only the user can make
- Keep responses tight — code and diffs over prose
