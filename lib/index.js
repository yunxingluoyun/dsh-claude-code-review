/**
 * DSH code review: a Host plugin that ports Claude Code's `/code-review`
 * workflow to DeepSeek Harness.
 *
 * It registers three things:
 * - the user-invocable `/code-review` command;
 * - the model-invocable `code-review` skill with the same methodology;
 * - the `code_review_context` tool that gathers eligibility, diff, repository
 *   guidance, and prior discussion into a review packet.
 */
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_LIMITS,
  collectReviewContext,
  renderSummary,
  writeReviewPacket,
} from './review-context.js'
import { REVIEW_DESCRIPTION, buildCommandPrompt, buildSkillContent } from './prompt.js'

export const inject = ['tools', 'workingDirectory']

const USAGE = `Usage: /code-review [target] [options]

target  a pull request number, #number, owner/repo#number, or GitHub pull request URL.
        Omit it to use the pull request for the current branch, or local changes when
        the branch has no pull request.

Options:
  --local              review local changes against a base branch (no target)
  --pr                 require a pull request and fail when there is none
  --base <ref>         local comparison base (implies --local; not valid with --pr)
  --post               post the report as a pull request comment when issues qualify
  --force              review even when the context is ineligible
  --threshold <0-100>  confidence threshold (default: the configured value, normally 80)
  --fast               skip the independent verification pass (faster, less reliable)
  --thorough           one verifier per finding instead of one per batch
  -h, --help           show this help`

const TOOL_DESCRIPTION = `Collect the context for an automated code review of a pull request or of local changes.

Returns eligibility, the reason, any warnings, the repository and full head commit, the changed files, and a review packet directory containing:
- roles/<role>.md: one self-contained file per planned reviewer, holding the diff, AGENTS.md/CLAUDE.md guidance, blame, and prior discussion that role needs;
- verify.md: target, guidance, diff, and the confidence rubric for the verification pass;
- context.md and diff.patch: reference copies of the target facts and the authoritative diff.

The tool also plans how many independent reviewers the change deserves: one combined reviewer for small changes, three for medium ones, and the full five for large changes. The tool is read-only. It runs git and, for pull requests, the GitHub CLI (gh), and never posts comments.`

function numberInRange(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

// The bundle is installed by linking this directory, so it deliberately has no
// runtime dependencies (a bare `import` of a DSH package would not resolve from
// here). Validate the config here instead of exporting a Config schema, so a
// typo fails at activation rather than being silently ignored.
const SETTING_KEYS = new Set([
  'maxDiffBytes', 'maxGuidanceBytes', 'maxGuidanceFileBytes',
  'maxDiscussionItems', 'maxDiscussionChars', 'maxDiscussionPages',
  'gitTimeoutMs', 'ghTimeoutMs', 'skipDrafts', 'skipAlreadyReviewed', 'base',
  'threshold', 'maxCodeContextBytes', 'maxHunkContextLines', 'maxContextFiles',
  'maxContextHunks', 'maxFileBytes', 'maxBlameFiles', 'maxBlameHunks',
  'maxBlameLines', 'smallDiffLines', 'smallDiffFiles', 'mediumDiffLines',
  'verificationMode', 'reviewerProvider', 'reviewerModel', 'reviewerReasoningEffort',
  'verifierProvider', 'verifierModel', 'verifierReasoningEffort',
])

function configNumber(source, key, min, max, fallback) {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`dsh-claude-code-review config "${key}" must be a number from ${min} to ${max}; got ${JSON.stringify(value)}.`)
  }
  return Math.round(number)
}

function configBoolean(source, key, fallback) {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-claude-code-review config "${key}" must be true or false; got ${JSON.stringify(value)}.`)
  }
  return value
}

function configString(source, key, fallback = '') {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw new Error(`dsh-claude-code-review config "${key}" must be a string; got ${JSON.stringify(value)}.`)
  }
  return value
}

function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  for (const key of Object.keys(source)) {
    if (!SETTING_KEYS.has(key)) {
      throw new Error(`Unknown dsh-claude-code-review config key "${key}". Supported keys: ${[...SETTING_KEYS].sort().join(', ')}.`)
    }
  }
  const verificationMode = configString(source, 'verificationMode', 'balanced')
  if (!['fast', 'balanced', 'thorough'].includes(verificationMode)) {
    throw new Error(`dsh-claude-code-review config "verificationMode" must be one of fast, balanced, or thorough; got ${JSON.stringify(verificationMode)}.`)
  }
  return {
    maxDiffBytes: configNumber(source, 'maxDiffBytes', 10_000, 2_000_000, DEFAULT_LIMITS.maxDiffBytes),
    maxGuidanceBytes: configNumber(source, 'maxGuidanceBytes', 0, 1_000_000, DEFAULT_LIMITS.maxGuidanceBytes),
    maxGuidanceFileBytes: configNumber(source, 'maxGuidanceFileBytes', 1_000, 1_000_000, DEFAULT_LIMITS.maxGuidanceFileBytes),
    maxDiscussionItems: configNumber(source, 'maxDiscussionItems', 0, 200, DEFAULT_LIMITS.maxDiscussionItems),
    maxDiscussionChars: configNumber(source, 'maxDiscussionChars', 200, 100_000, DEFAULT_LIMITS.maxDiscussionChars),
    maxDiscussionPages: configNumber(source, 'maxDiscussionPages', 1, 50, DEFAULT_LIMITS.maxDiscussionPages),
    gitTimeoutMs: configNumber(source, 'gitTimeoutMs', 1_000, 600_000, DEFAULT_LIMITS.gitTimeoutMs),
    ghTimeoutMs: configNumber(source, 'ghTimeoutMs', 1_000, 600_000, DEFAULT_LIMITS.ghTimeoutMs),
    skipDrafts: configBoolean(source, 'skipDrafts', false),
    skipAlreadyReviewed: configBoolean(source, 'skipAlreadyReviewed', false),
    base: configString(source, 'base'),
    // 0 is a valid threshold: report every finding, however uncertain.
    threshold: configNumber(source, 'threshold', 0, 100, 80),
    maxCodeContextBytes: configNumber(source, 'maxCodeContextBytes', 0, 2_000_000, DEFAULT_LIMITS.maxCodeContextBytes),
    maxHunkContextLines: configNumber(source, 'maxHunkContextLines', 0, 40, DEFAULT_LIMITS.maxHunkContextLines),
    maxContextFiles: configNumber(source, 'maxContextFiles', 1, 200, DEFAULT_LIMITS.maxContextFiles),
    maxContextHunks: configNumber(source, 'maxContextHunks', 0, 500, DEFAULT_LIMITS.maxContextHunks),
    maxFileBytes: configNumber(source, 'maxFileBytes', 1_000, 2_000_000, DEFAULT_LIMITS.maxFileBytes),
    maxBlameFiles: configNumber(source, 'maxBlameFiles', 0, 200, DEFAULT_LIMITS.maxBlameFiles),
    maxBlameHunks: configNumber(source, 'maxBlameHunks', 0, 500, DEFAULT_LIMITS.maxBlameHunks),
    maxBlameLines: configNumber(source, 'maxBlameLines', 0, 2_000, DEFAULT_LIMITS.maxBlameLines),
    smallDiffLines: configNumber(source, 'smallDiffLines', 1, 10_000, DEFAULT_LIMITS.smallDiffLines),
    smallDiffFiles: configNumber(source, 'smallDiffFiles', 1, 100, DEFAULT_LIMITS.smallDiffFiles),
    mediumDiffLines: configNumber(source, 'mediumDiffLines', 1, 100_000, DEFAULT_LIMITS.mediumDiffLines),
    verificationMode,
    reviewerRoute: routeFrom(source, 'reviewer'),
    verifierRoute: routeFrom(source, 'verifier'),
  }
}

function routeFrom(source, prefix) {
  return {
    provider: configString(source, `${prefix}Provider`),
    model: configString(source, `${prefix}Model`),
    reasoningEffort: configString(source, `${prefix}ReasoningEffort`),
  }
}

/** One-line account of a started review, collapsed on the Chat context row. */
function reviewNotice(parsed) {
  const target = parsed.target !== ''
    ? parsed.target
    : parsed.mode === 'local'
      ? 'local changes'
      : 'current branch or local changes'
  const speed = parsed.verificationMode === 'balanced' ? '' : `, ${parsed.verificationMode}`
  const text = `Code review: ${target}, threshold ${parsed.threshold}${speed}`
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

class UsageError extends Error {}

function parseCommandInput(rawInput, defaultThreshold, defaultVerificationMode) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(token => token !== '')
  const parsed = {
    target: '',
    mode: 'auto',
    base: '',
    post: false,
    force: false,
    threshold: defaultThreshold,
    verificationMode: defaultVerificationMode,
    help: false,
  }
  const value = (index, flag) => {
    const next = tokens[index + 1]
    if (next === undefined || next.startsWith('-')) throw new UsageError(`${flag} requires a value.`)
    return next
  }
  // Help wins over malformed trailing options: `--help --nope` still shows usage.
  if (tokens.includes('--help') || tokens.includes('-h')) {
    return { ...parsed, help: true }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--local') {
      parsed.mode = 'local'
    } else if (token === '--pr') {
      parsed.mode = 'pr'
    } else if (token === '--post') {
      parsed.post = true
    } else if (token === '--force') {
      parsed.force = true
    } else if (token === '--fast') {
      parsed.verificationMode = 'fast'
    } else if (token === '--thorough') {
      parsed.verificationMode = 'thorough'
    } else if (token === '--base') {
      parsed.base = value(index, '--base')
      index += 1
      if (parsed.mode === 'auto') parsed.mode = 'local'
    } else if (token.startsWith('--base=')) {
      parsed.base = token.slice('--base='.length)
      if (parsed.base === '') throw new UsageError('--base requires a value.')
      if (parsed.mode === 'auto') parsed.mode = 'local'
    } else if (token === '--threshold') {
      parsed.threshold = parseThreshold(value(index, '--threshold'))
      index += 1
    } else if (token.startsWith('--threshold=')) {
      parsed.threshold = parseThreshold(token.slice('--threshold='.length))
    } else if (token.startsWith('-')) {
      throw new UsageError(`Unknown option: ${token}`)
    } else if (parsed.target === '') {
      parsed.target = token
    } else {
      throw new UsageError(`Unexpected argument: ${token}. Only one target is accepted.`)
    }
  }
  if (parsed.mode === 'pr' && parsed.base !== '') {
    throw new UsageError('--base cannot be combined with --pr; pull request mode uses the pull request base.')
  }
  if (parsed.mode === 'local' && parsed.target !== '') {
    throw new UsageError('A pull request target cannot be combined with --local.')
  }
  return parsed
}

function parseThreshold(raw) {
  const threshold = Number(raw)
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    throw new UsageError('--threshold must be an integer from 0 to 100.')
  }
  return threshold
}

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'code-review',
      description: REVIEW_DESCRIPTION,
      input: { hint: '[<target>] [--local|--pr] [--base <ref>] [--post] [--force] [--threshold <n>]' },
      handler: ({ agent, rawInput }) => {
        let parsed
        try {
          parsed = parseCommandInput(rawInput, settings.threshold, settings.verificationMode)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `${message}\n\n${USAGE}` }
        }
        if (parsed.help) return { kind: 'success', text: USAGE }
        try {
          agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: buildCommandPrompt({
                ...parsed,
                reviewerRoute: settings.reviewerRoute,
                verifierRoute: settings.verifierRoute,
              }),
            }],
            // Not a human message: Chat renders the long methodology as a
            // collapsed context notice instead of a user bubble.
            source: { kind: 'code-review', form: 'notice', summary: reviewNotice(parsed) },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `Could not start the code review: ${message}` }
        }
        return {
          kind: 'success',
          text: parsed.target === ''
            ? 'Code review started.'
            : `Code review started for ${parsed.target}.`,
        }
      },
    })
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register({
      name: 'code-review',
      description: REVIEW_DESCRIPTION,
      whenToUse: 'Use for a pull request, a branch diff, or uncommitted local changes, especially before merging or when the user runs /code-review.',
      source: 'runtime',
      content: buildSkillContent(settings),
      // The command is the single user-facing entry; the skill serves model
      // requests made in ordinary prose.
      invocation: { modelInvocable: true, userInvocable: false },
    })
  })

  ctx.tools.register({
    name: 'code_review_context',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description: 'Pull request number, #number, owner/repo#number, or GitHub pull request URL. Omit to use the current branch pull request, then local changes.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'pr', 'local'],
          description: 'auto detects a pull request for the current branch and falls back to local changes; pr requires one; local compares the working tree against a base.',
        },
        base: {
          type: 'string',
          description: 'Local mode only: ref to compare against. Defaults to origin/HEAD, then main or master.',
        },
        includeGuidance: {
          type: 'boolean',
          description: 'Collect AGENTS.md and CLAUDE.md files for the changed directories. Defaults to true.',
        },
        includeDiscussion: {
          type: 'boolean',
          description: 'Collect prior pull request reviews and comments. Defaults to true.',
        },
        includeCodeContext: {
          type: 'boolean',
          description: 'Include per-hunk surrounding code windows and blame in the role packets. Defaults to true.',
        },
        maxDiffBytes: {
          type: 'number',
          description: 'Maximum diff bytes kept in the packet. Defaults to the configured maxDiffBytes (120000 when unset).',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('code_review_context requires an agent session; it cannot run as a standalone service call.')
      }
      if (exec.signal.aborted) {
        const error = new Error('code review cancelled')
        error.name = 'AbortError'
        throw error
      }
      let cwd
      try {
        cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not resolve the session working directory: ${message}`)
      }
      const context = await collectReviewContext({
        cwd,
        target: typeof args.target === 'string' ? args.target : '',
        mode: args.mode === 'pr' || args.mode === 'local' ? args.mode : 'auto',
        base: typeof args.base === 'string' && args.base !== '' ? args.base : settings.base,
        includeGuidance: args.includeGuidance !== false,
        includeDiscussion: args.includeDiscussion !== false,
        includeCodeContext: typeof args.includeCodeContext === 'boolean' ? args.includeCodeContext : undefined,
        maxDiffBytes: typeof args.maxDiffBytes === 'number'
          ? numberInRange(args.maxDiffBytes, 10_000, 2_000_000, settings.maxDiffBytes)
          : settings.maxDiffBytes,
        maxGuidanceBytes: settings.maxGuidanceBytes,
        maxGuidanceFileBytes: settings.maxGuidanceFileBytes,
        maxDiscussionItems: settings.maxDiscussionItems,
        maxDiscussionChars: settings.maxDiscussionChars,
        maxDiscussionPages: settings.maxDiscussionPages,
        maxCodeContextBytes: settings.maxCodeContextBytes,
        maxHunkContextLines: settings.maxHunkContextLines,
        maxContextFiles: settings.maxContextFiles,
        maxContextHunks: settings.maxContextHunks,
        maxFileBytes: settings.maxFileBytes,
        maxBlameFiles: settings.maxBlameFiles,
        maxBlameHunks: settings.maxBlameHunks,
        maxBlameLines: settings.maxBlameLines,
        smallDiffLines: settings.smallDiffLines,
        smallDiffFiles: settings.smallDiffFiles,
        mediumDiffLines: settings.mediumDiffLines,
        gitTimeoutMs: settings.gitTimeoutMs,
        ghTimeoutMs: settings.ghTimeoutMs,
        skipDrafts: settings.skipDrafts,
        skipAlreadyReviewed: settings.skipAlreadyReviewed,
        signal: exec.signal,
      })
      const paths = await writeReviewPacket(context)
      const summary = renderSummary(context, paths)
      return {
        mode: context.mode,
        eligible: context.eligible,
        reason: context.reason,
        warnings: context.warnings,
        notes: context.notes,
        repo: context.repo,
        repoRoot: context.repoRoot,
        headSha: context.headSha,
        prNumber: context.pr === null ? null : context.pr.number,
        baseRef: context.baseRef,
        changedFiles: context.changedFiles.length,
        untrackedFiles: context.untrackedFiles.length,
        guidanceFiles: context.guidance.length,
        discussionItems: context.discussion.length,
        diffBytes: context.diff.bytes,
        diffTruncated: context.diff.truncated,
        changedLines: context.plan?.changedLines ?? 0,
        suggestedReviewers: context.plan?.roles?.length ?? 0,
        roles: context.plan?.roles ?? [],
        rolePaths: paths.rolePaths,
        verifyPath: paths.verifyPath,
        packetDir: paths.dir,
        contextPath: paths.contextPath,
        diffPath: paths.diffPath,
        summary,
      }
    },
  })

  ctx.logger?.info('dsh-claude-code-review: /code-review, code-review skill, and code_review_context are registered')
}
