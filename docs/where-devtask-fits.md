# Where devtask Fits

This note captures where `devtask` fits in the current agent tooling market and where it should not compete.

The goal is strategic clarity, not product marketing.

## Short Version

`devtask` should not try to win as another agent desktop shell.

That market is already crowded with tools that optimize:

- parallel worktrees
- background agent runs
- diffs and PR helpers
- single-developer agent supervision
- context retrieval inside one developer workflow

`devtask` should instead focus on the workflow layer:

- provider-neutral work intake
- durable work artifacts
- polyrepo target decomposition
- explicit human gates
- resumable and inspectable stage flow
- local-first execution and recovery
- reviewable context and learning artifacts

The durable gap is not "run multiple agents". The durable gap is:

```text
portable, reviewable, provider-neutral engineering workflow orchestration
```

The business is not "best AI coding app". The business is:

```text
workflow infrastructure for teams operating agents in real software delivery environments
```

## Market Shape

The market splits into two layers:

```text
agent runtimes
  -> generate code and operate tools

workflow/orchestration systems
  -> structure the ticket/spec-to-PR process around those runtimes
```

Examples of agent runtimes:

- Claude Code
- Codex
- Aider
- other editor or terminal coding agents

`devtask` belongs in the second layer. It should orchestrate runtimes, not replace them.

## Competitor Buckets

### 1. Desktop And Workspace Shells

Examples:

- Purple `p0`
- Augment `Intent`
- Conductor
- Divergence
- Emdash
- 1Code
- OpenADE

Common strengths:

- polished UI
- multiple parallel workspaces
- built-in diff review
- background agent supervision
- good single-developer ergonomics
- sometimes strong context retrieval

Common limits:

- often optimized for one developer, not a team operating model
- often tied to specific runtimes or ecosystems
- weaker explicit lifecycle contracts
- weaker provider neutrality
- weaker support for reviewable planning, approval, and recovery artifacts

### 2. Open-Source Orchestration Engines

Examples:

- Composio Agent Orchestrator
- Optio
- Conductor OSS

Common strengths:

- agent-agnostic execution
- CI/review/PR automation
- parallel task handling
- strong building blocks for automation loops

Common limits:

- tasks usually assumed to already exist
- weaker work-intake and planning model
- weaker human gate model
- less emphasis on durable task decomposition artifacts

### 3. Cloud Autonomous Engineers

Examples:

- Devin
- Rovo Dev, increasingly

Common strengths:

- high degree of automation
- managed infrastructure
- integrated agent execution
- attractive "ticket to PR" promise

Common limits:

- less local control
- weaker inspectability
- less adaptable to teams that want strong human checkpoints
- often opinionated deployment and provider assumptions

### 4. Context And Governance Layers

Examples:

- Augment Context Engine
- Atlassian Rovo and Teamwork Graph

Common strengths:

- large-context retrieval
- cross-repo awareness
- stronger search and memory
- org-level policy and knowledge surfaces

Common limits:

- not necessarily the lifecycle owner
- may improve agent quality without solving workflow control

## Where devtask Should Win

`devtask` should be strongest where the others are structurally weaker.

### Product Definition

`devtask` should be defined as:

```text
team workflow infrastructure for agent-driven software delivery
```

That means:

- not another agent shell
- not a better IDE
- not a generic autonomous engineer
- not a proprietary context engine

It means owning the workflow layer around agent runtimes:

- work intake
- decomposition
- execution control
- human gates
- publishing
- recovery
- context and learning artifacts

### Provider Neutrality

`devtask` should stay neutral across:

- source systems: Jira, Linear, GitHub Issues, manual sources
- source control: Bitbucket, GitHub, GitLab
- CI providers
- agent runtimes

This matters because many teams are not fully inside one vendor stack.

### Work As A First-Class Object

Many tools manage sessions or tasks. `devtask` should manage a durable work item:

- source artifact
- work plan
- approved graph
- materialized repo tasks
- repo plans
- checks, reviews, approvals
- commits, PRs, CI state

That object model is harder to copy than a terminal UI.

### Polyrepo Decomposition

The planning problem is not just "run agents in two repos". It is:

- decide which targets are affected
- define boundaries
- define dependencies
- approve the decomposition
- run the resulting repo tasks with explicit gates

That is a workflow problem, not a runtime problem.

### Explicit Human Gates

`devtask` should remain opinionated about:

- plan approval before materialization
- approval before publishing
- reviewable commits and PRs
- no silent policy mutation
- no hidden learning

This is a real requirement for teams that do not want fully autonomous execution.

### Local-First Reliability

`devtask` should keep improving:

- recovery after partial failure
- resumable runs
- stable local artifacts
- deterministic cleanup
- inspectable logs and stage ledgers

This is less flashy than UI, but it is where trust comes from.

Long term, local-first should evolve into:

```text
local execution
  + shared artifacts
  + optional cloud control plane
```

That preserves provider neutrality and local control while leaving room for team visibility, approvals, and policy later.

### Reviewable Context And Learning

The future context and self-improvement layers should strengthen the orchestration model:

- context artifacts with provenance
- memory as compact facts
- skills as reusable procedures
- searchable prior work artifacts
- explicit improvement suggestions

This should improve future work without turning the system into a black box.

## Where devtask Should Not Compete

`devtask` should not aim to be:

- a better IDE than editor-native tools
- a prettier terminal wrapper
- another generic "many agents on one screen" desktop app
- a proprietary context engine company
- a fully autonomous cloud engineer

Those are adjacent surfaces, not the core product.

UI will eventually matter, but it should sit on top of the orchestration engine rather than define the product.

## Strategic Constraint

The strongest threat to the original thesis is Atlassian.

Rovo Dev means the claim "nobody does Jira to Bitbucket agent workflow" is no longer true in Atlassian Cloud.

That changes the strategy.

`devtask` should not rely on:

- Jira + Bitbucket support alone
- "multi-agent" as a differentiator
- desktop orchestration alone

Instead it should differentiate on:

- local-first control
- provider neutrality
- explicit lifecycle contracts
- strong human oversight
- polyrepo decomposition
- shared workflow artifacts
- reviewable context and learning

## Buyer And User

The user is not "any developer who wants a better coding assistant".

The primary user is:

- an engineer or tech lead managing real delivery work with agents
- often across multiple repos or scopes
- often inside mixed vendor environments
- often needing explicit review and approval checkpoints

The likely buyer, later, is:

- engineering management
- platform engineering
- developer productivity or internal tooling owners

The value is not just faster coding. The value is:

- standard workflow
- better oversight
- lower vendor lock-in
- recoverable automation
- reusable execution knowledge
- more predictable ticket-to-PR delivery
- inspectable context and learning

## What This Means For Roadmap

Near term:

- finish the end-to-end work-item architecture
- improve reliability and recovery
- make `work board`, `work next`, and `work exec --auto` strong
- finish publishing and CI lifecycle quality

After that:

- context artifacts
- self-improvement with explicit approval
- work-level CI watch/fix loop
- UI on top of durable state, not instead of it

The roadmap should keep reinforcing the workflow moat, not drift toward generic runtime chrome.

## Business Conclusion

Continuing `devtask` makes sense because the plan is now narrower than the crowded "AI coding" market.

The crowded business is:

- agent shells
- IDE copilots
- generic spec-to-PR tools
- broad autonomous coding assistants

The more viable business is:

- workflow infrastructure
- for teams
- with mixed stacks or vendor neutrality needs
- with polyrepo delivery complexity
- with a need for explicit human oversight

That is a smaller category than "AI coding", but it is more defensible and more aligned with the product we are actually building.

## Decision Rule

Continuing `devtask` makes sense if the question is:

```text
how do we create a reliable, provider-neutral, human-governed workflow engine for agent-driven software delivery?
```

Continuing `devtask` makes less sense if the question is:

```text
how do we build another desktop shell for parallel coding agents?
```

The first is still under-served. The second is already crowded.
