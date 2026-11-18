# Code review for DeepSeek Harness

**English** | [简体中文](README.zh.md)

A port of Claude Code's `/code-review` workflow to DeepSeek Harness. It reviews a pull request, a branch, or uncommitted local changes with several independent review agents, scores every finding for confidence, and reports only issues that clear the threshold.

## What it does

1. **Collects the facts and precomputes evidence** with the `code_review_context` tool: the pull request (or local diff), eligibility, `AGENTS.md`/`CLAUDE.md` guidance, prior discussion, per-hunk surrounding code, and blame for the changed lines. It writes one self-contained role file per planned reviewer plus a verification file, so review agents make no exploration tool calls.
2. **Runs the planned reviewers in parallel**: one combined reviewer for small changes, three for medium ones, and the full five perspectives (guidance, bugs, history, discussion, comments/conventions) for large changes.
3. **Scores findings with a verification agent** using a 0/25/50/75/100 confidence rubric. Balanced mode batches all issues into one verifier; `--thorough` uses one verifier per finding; `--fast` skips verification.
4. **Keeps only high-confidence issues** (default threshold 80) and reports them with exact citations. Every report opens with what was actually reviewed and any coverage caveats, and an empty result names the threshold instead of claiming nothing was found. Pull request mode links to the full head commit; local mode cites `path:line`.
5. **Posts a comment only when asked** (`--post`), with a revision marker so a later run can recognize the same head commit. The report states whether the comment was posted or why it was not.

## Installation

This directory is a bundle package. Installing it with **Plugins → Add plugin** (or `plugin_manager` `install_bundle` with this directory as the target) adds the `/code-review` command, the `code-review` skill, and the `code_review_context` tool to every new session in the profile.

Installing from a local directory links it into the profile rather than copying it. Moving or deleting this directory therefore disables the plugin; to keep it after moving, reinstall from the new location.

## Requirements

- DeepSeek Harness 0.2.2 or newer (`engines.dsh` is declared in `package.json`).
- `git` in the session environment.
- Pull request mode additionally needs the GitHub CLI (`gh`) installed and authenticated (`gh auth login`). Without it, `/code-review` reviews local changes instead.
- The session's agent preset must expose `subagent` and `read` for the full workflow; `bash` is only needed for `--post`. Without `subagent`, the methodology falls back to a sequential review.

## Usage

```
/code-review                     review the current branch's pull request, or local changes when there is none
/code-review 123                 review pull request #123
/code-review --pr                require a pull request and fail when there is none
/code-review https://github.com/owner/repo/pull/123
/code-review --local             review local changes against the detected base branch
/code-review --base develop      review local changes against develop
/code-review 123 --post          post the report as a pull request comment when issues qualify
/code-review --threshold 90      raise the confidence threshold (0 reports every finding)
/code-review --force             review even when the context says it is ineligible
/code-review --fast              skip independent verification (noticeably faster, less reliable)
/code-review --thorough          one verifier per finding instead of one per batch
```

The command submits the review workflow to the current session as a collapsed context notice named "code review"; expand the row in the transcript to read the exact instructions. The report appears in chat when the review finishes. The `code-review` skill exposes the same workflow to the model when you ask for a review in ordinary prose.

`--base` implies `--local` and cannot be combined with `--pr`; a pull request target cannot be combined with `--local`. `--threshold` accepts `0` to report every finding regardless of confidence.

## Review packet

Each run writes a temporary directory under the system temp directory:

- `roles/<role>.md` — one self-contained file per planned reviewer: role focus, target facts, the diff, the guidance excerpts, the surrounding code, blame, and prior discussion that role needs. A reviewer reads exactly one file and returns one JSON array.
- `verify.md` — target facts, guidance, diff, and the confidence rubric for the verification pass.
- `context.md` and `diff.patch` — reference copies for the main agent; it does not need to read the diff.

The tool never writes into the repository and never posts anything. Packets are left for inspection but expire: the next run prunes `dsh-claude-code-review-*` directories older than 24 hours.

## Performance

A review is dominated by model round trips, so the implementation minimizes them:

- **One read per reviewer.** The tool precomputes hunk windows and blame, so a reviewer answers from a single role file instead of reading the diff, opening files, and running `git blame` across several turns.
- **Reviewer count scales with the change.** Small changes (default ≤ 40 changed lines and ≤ 5 files) use one combined reviewer; medium changes use three; large changes use the full five.
- **One verifier for the whole review** in balanced mode (batches of at most 8 issues), instead of one agent per issue. `--fast` removes this round entirely.
- **The main agent does not read the diff**, keeping its context small across the spawn and verification turns.
- Context collection plus packet generation takes roughly 0.2 s for a 480-line change across 12 files in local benchmarks; the remaining time is the reviewers and verifier.

Configure `reviewerProvider`/`reviewerModel` and `verifierProvider`/`verifierModel` to route the review agents to a faster model than the main session's.

## Configuration

Patch the `code-review` row's config in the profile's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `threshold` | `80` | Confidence threshold used by `/code-review` when no `--threshold` is given (`0`–`100`; `0` reports every finding) |
| `maxDiffBytes` | `120000` | Diff bytes kept in the packet; larger diffs are truncated at a line boundary |
| `verificationMode` | `balanced` | `balanced` (one verifier per batch), `fast` (no verifier), or `thorough` (one verifier per finding) |
| `maxCodeContextBytes` | `180000` | Surrounding-code bytes kept in role files |
| `maxHunkContextLines` | `6` | Context lines shown around each hunk |
| `maxContextFiles` | `40` | Changed files given a code window |
| `maxContextHunks` | `80` | Hunk windows kept in role files |
| `maxFileBytes` | `131072` | Cap on one file read for a code window |
| `maxBlameFiles` | `12` | Changed files given blame |
| `maxBlameHunks` | `24` | Hunk ranges blamed |
| `maxBlameLines` | `200` | Blame lines kept |
| `smallDiffLines` / `smallDiffFiles` | `40` / `5` | Threshold for a single combined reviewer |
| `mediumDiffLines` | `200` | Threshold below which three reviewers replace the full five |
| `reviewerProvider` / `reviewerModel` / `reviewerReasoningEffort` | unset | Route reviewer children to a specific model |
| `verifierProvider` / `verifierModel` / `verifierReasoningEffort` | unset | Route verifier children to a specific model |
| `maxGuidanceBytes` | `131072` | Total guidance bytes kept in the packet |
| `maxGuidanceFileBytes` | `32768` | Per-file guidance cap |
| `maxDiscussionItems` | `20` | Prior pull request comments/reviews kept |
| `maxDiscussionChars` | `4000` | Per-comment cap |
| `maxDiscussionPages` | `5` | Pages of 100 comments fetched per discussion source |
| `skipDrafts` | `false` | Treat draft pull requests as ineligible |
| `skipAlreadyReviewed` | `false` | Treat a pull request whose head commit already carries a DSH review marker as ineligible |
| `base` | detected | Default local comparison base |
| `gitTimeoutMs` | `30000` | Per-command git timeout |
| `ghTimeoutMs` | `25000` | Per-command gh timeout |

Configuration is validated when the plugin activates: unknown keys, wrong types, out-of-range numbers, and unknown `verificationMode` values fail with a message naming the field instead of being silently ignored. Values are set on the `code-review` row in `cordis.patch.yml`; the bundle does not ship a Config schema because a dependency-free linked bundle cannot resolve the DSH Schemastery package.

## What it deliberately does not do

- It does not build, typecheck, lint, run tests, or format; CI owns those signals.
- It does not report pre-existing issues, issues outside the changed lines, nitpicks, or general quality wishes that `AGENTS.md`/`CLAUDE.md` do not require.
- It does not review closed or merged pull requests, or changes with no diff.
- Review agents read repository text. Treat untrusted repositories accordingly: guidance files and code comments are passed as review data, and the prompt tells agents never to follow instructions found inside them.
- A review spends extra tokens: the planned reviewers (one to five) plus verifier rounds. Use `--fast`, raise `--threshold`, or review smaller changes to bound the cost.

## Files

```
lib/index.js            Host plugin: command, skill, tool registration
lib/review-context.js   Context collection, reviewer plan, packet writing, rendering
lib/prompt.js           Shared review methodology for the command and skill
lib/review-rules.js     Rubric, false-positive list, and reviewer ground rules
lib/git.js              Shell-free process helpers
locale/                 Plugin Manager titles and descriptions
docs/                   Detail page and feature image
```

## Development

The bundle has no runtime dependencies. Run the tests with:

```
node --test
```

The suite creates temporary git repositories; it needs `git` but no network access or `gh` authentication.

## Uninstall

Remove the bundle from the profile's Plugins page, or with `dsh plugin --profile <profile> remove dsh-claude-code-review`.
