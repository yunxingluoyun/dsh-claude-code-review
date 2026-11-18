import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import {
  collectReviewContext,
  parseDiffHunks,
  parseGithubRepo,
  parsePrTarget,
  planReviewRoles,
  renderContext,
  renderRolePacket,
  truncateDiff,
  writeReviewPacket,
} from '../lib/review-context.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-test-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Test User'])
  git(root, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(root, 'AGENTS.md'), '# Repository rules\n\nAlways handle errors.\n')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'AGENTS.md'), '# Source rules\n\nUse named exports.\n')
  await writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])
  git(root, ['checkout', '-b', 'feature'])
  await writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1\nexport function read(value) {\n  return value.length\n}\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'feature change'])
  await writeFile(path.join(root, 'src', 'b.js'), 'export const b = 2\n')
  return root
}

let root = ''

before(async () => {
  root = await makeRepo()
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

test('parsePrTarget accepts numbers, shorthands, and URLs', () => {
  assert.deepEqual(parsePrTarget('123'), { repo: undefined, number: 123 })
  assert.deepEqual(parsePrTarget('#123'), { repo: undefined, number: 123 })
  assert.deepEqual(parsePrTarget('owner/repo#123'), { repo: 'owner/repo', number: 123 })
  assert.deepEqual(parsePrTarget('https://github.com/owner/repo/pull/123'), { repo: 'owner/repo', number: 123 })
  assert.equal(parsePrTarget('branch-name'), null)
  assert.equal(parsePrTarget(''), null)
})

test('parseGithubRepo handles https, ssh, and scp remotes', () => {
  assert.equal(parseGithubRepo('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseGithubRepo('git@github.com:owner/repo.git'), 'owner/repo')
  assert.equal(parseGithubRepo('ssh://git@github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseGithubRepo('https://gitlab.com/owner/repo'), '')
})

test('parseDiffHunks reports the new-file line ranges', () => {
  const patch = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' export const a = 1',
    '+export const b = 2',
    ' export const c = 3',
    'diff --git a/new.txt b/new.txt',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
  ].join('\n')
  const hunks = parseDiffHunks(patch)
  assert.deepEqual(hunks.get('src/a.js'), [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 }])
  assert.deepEqual(hunks.get('new.txt'), [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }])
})

test('planReviewRoles scales reviewers with the change size', () => {
  const base = { eligible: true, mode: 'local', discussion: [] }
  const small = planReviewRoles({
    ...base,
    changedFiles: [{ path: 'a.js', status: 'M', additions: 8, deletions: 2 }],
    diff: { lines: 40 },
  })
  assert.deepEqual(small.roles, ['all'])
  const medium = planReviewRoles({
    ...base,
    changedFiles: [{ path: 'a.js', status: 'M', additions: 80, deletions: 20 }],
    diff: { lines: 400 },
  })
  assert.deepEqual(medium.roles, ['guidance-conventions', 'bugs', 'history'])
  const large = planReviewRoles({
    ...base,
    mode: 'pr',
    discussion: [{ kind: 'comment', author: 'x', body: 'y' }],
    changedFiles: [{ path: 'a.js', status: 'M', additions: 300, deletions: 100 }],
    diff: { lines: 1600 },
  })
  assert.deepEqual(large.roles, ['guidance', 'bugs', 'history', 'discussion', 'comments'])
  assert.deepEqual(planReviewRoles({ ...base, eligible: false, changedFiles: [], diff: { lines: 0 } }).roles, [])
})

test('truncateDiff keeps the budget and marks the truncation', () => {
  const text = `${'a'.repeat(100)}\n${'b'.repeat(100)}\n`
  const result = truncateDiff(text, 120)
  assert.equal(result.truncated, true)
  assert.ok(result.text.length < text.length)
  assert.match(result.text, /diff truncated after 120 bytes/)
  const complete = truncateDiff('short\n', 100)
  assert.equal(complete.truncated, false)
  assert.equal(complete.text, 'short\n')
})

test('local collection finds the diff, guidance, and untracked files', async () => {
  const context = await collectReviewContext({
    cwd: root,
    mode: 'local',
    base: 'main',
    includeDiscussion: false,
  })
  assert.equal(context.mode, 'local')
  assert.equal(context.eligible, true)
  assert.equal(context.repoRoot, realpathSync(root))
  const paths = context.changedFiles.map(file => file.path)
  assert.ok(paths.includes('src/a.js'))
  assert.match(context.diff.text, /export function read/)
  assert.match(context.diff.text, /new file mode 100644/)
  assert.match(context.diff.text, /export const b = 2/)
  const guidance = context.guidance.map(file => file.path)
  assert.ok(guidance.includes('AGENTS.md'))
  assert.ok(guidance.includes('src/AGENTS.md'))
  assert.equal(context.untrackedFiles.includes('src/b.js'), true)
  assert.equal(context.discussion.length, 0)
})

test('context rendering and packet writing expose both artifacts', async () => {
  const context = await collectReviewContext({ cwd: root, mode: 'local', base: 'main' })
  const rendered = renderContext(context, '/tmp/diff.patch')
  assert.match(rendered, /# Code review packet/)
  assert.match(rendered, /<guidance path="src\/AGENTS.md">/)
  assert.match(rendered, /Always handle errors\./)
  assert.equal(context.codeContext.files >= 1, true)
  assert.match(context.codeContext.text, /export function read/)
  assert.equal(context.history.available, true)
  assert.match(context.history.text, /L2 /)
  const packet = await writeReviewPacket(context)
  assert.ok(packet.verifyPath.endsWith('verify.md'))
  assert.ok(packet.roles.length >= 1)
  const roleText = await readFile(packet.rolePaths[packet.roles[0]], 'utf8')
  assert.match(roleText, /# Code review role:/)
  assert.match(roleText, /<diff>/)
  assert.match(roleText, /Return only a JSON array/)
  const verifyText = await readFile(packet.verifyPath, 'utf8')
  assert.match(verifyText, /Rubric \(apply verbatim/)
  assert.match(verifyText, /Absolutely certain/)
  const written = await readFile(packet.contextPath, 'utf8')
  assert.match(written, /Diff file: /)
  const diff = await readFile(packet.diffPath, 'utf8')
  assert.match(diff, /export function read/)
  assert.equal(path.dirname(packet.diffPath), packet.dir)
})

test('clean and non-repository trees are ineligible', async () => {
  const clean = await mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-clean-'))
  git(clean, ['init', '-b', 'main'])
  git(clean, ['config', 'user.name', 'Test User'])
  git(clean, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(clean, 'file.txt'), 'one\n')
  git(clean, ['add', '.'])
  git(clean, ['commit', '-m', 'initial'])
  const cleanContext = await collectReviewContext({ cwd: clean, mode: 'local', base: 'main' })
  assert.equal(cleanContext.eligible, false)
  assert.match(cleanContext.reason, /No changes were found/)

  const plain = await mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-plain-'))
  const plainContext = await collectReviewContext({ cwd: plain, mode: 'auto' })
  assert.equal(plainContext.eligible, false)
  assert.match(plainContext.reason, /not inside a git repository/)
  await rm(clean, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})
