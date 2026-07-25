# Akron Pulse agent team

Role-based subagents for working on this repo with Claude. Each file defines one role: frontmatter sets its name, when to use it, tool permissions, and model tier; the body is its system prompt. Claude delegates to a role automatically when a task matches its description, or you can address one directly ("have the architect look at this").

## Design principles

**Agents are *who*, skills are *how*.** Prompts stay short and point at repo docs (`CONTRIBUTING.md`, `docs/`) and skills (`.claude/skills/code-reviewer`, the `engineering:*` suite) as the source of truth, so agents don't drift from the code.

**Least privilege.** The architect and code-reviewer are read-only. QA and the data steward can run commands but not edit. Only the developer edits code, and its only git write permission is local commits on the `agents/nightly` branch in the `.worktrees/nightly/` worktree - never a push, never the maintainer's checkout. The maintainer reviews and merges every commit.

**Separation of duties mirrors a real team.** The developer cannot approve their own work (code-reviewer verdict required), QA verifies independently and re-runs checks rather than trusting reports, and destructive data operations require explicit maintainer approval.

## The team

| Agent | Model | Access | Responsibility |
|---|---|---|---|
| architect | opus | read-only | ADRs, system design, trade-off analysis |
| developer | sonnet | full edit | Features, bug fixes, scrapers |
| code-reviewer | opus | read + inspect | Pre-commit review: security, correctness, conventions |
| qa | sonnet | read + run | Test suite, sanity tests, scraper health, regressions |
| data-steward | sonnet | read + run | Dedupe, venue hygiene, geo scope, categorization audits |
| support | haiku | draft-only | Submission and partner-email triage, draft replies |
| analyst | opus | read-only | Weekly analytics review, supply/demand gaps, strategic recommendations |

## Typical flow

architect (design) → developer (implement) → code-reviewer (approve, iterating with developer) → developer commits locally on `agents/nightly` → maintainer reviews and merges. qa runs independent verification; data-steward and support run on demand or on a schedule.

## Nightly pipelines

Two Cowork scheduled tasks orchestrate the team unattended:

1. **nightly-qa-pipeline** (1am): runs `npm run scrape:all`, then qa checks site availability, search, event submission, email signup, and pipeline health. Findings flow qa → architect → developer → code-reviewer → local commit on `agents/nightly`.
2. **nightly-data-pipeline** (5am): data-steward audits event/venue data, applies scoped in-the-moment data fixes with a full mutation log, then root-causes each issue through the same architect → developer → code-reviewer → commit chain.

Both cap themselves at two code fixes per night, never touch migrations or RLS unattended, and end with a report of findings, fixes, commits, and anything needing the maintainer.
