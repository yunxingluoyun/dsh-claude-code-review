import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, chmod, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import {
  collectReviewContext,
  parseDiffHunks,
  parseGithubRepo,
  parsePrTarget,
  planReviewRoles,
  pruneReviewPackets,
  renderContext,
  renderRolePacket,
  truncateDiff,
  writeReviewPacket,
} from '../lib/review-context.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-test-'))
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

const FAKE_GH = [
  '#!/usr/bin/env node',
  "const args = process.argv.slice(2)",
  "const out = (value) => process.stdout.write(JSON.stringify(value))",
  "if (args[0] === 'repo' && args[1] === 'view') {",
  "  out({ nameWithOwner: process.env.FAKE_GH_CHECKOUT || 'owner/repo', url: 'https://github.com/owner/repo', defaultBranchRef: { name: 'main' } })",
  '  process.exit(0)',
  '}',
  "if (args[0] === 'pr' && args[1] === 'view') {",
  '  out({',
  "    number: 7, title: 'Add two', state: 'OPEN', isDraft: false,",
  "    author: { login: 'alice' }, headRefName: 'feature',",
  '    headRefOid: process.env.FAKE_GH_HEAD, baseRefName: \'main\',',
  "    url: 'https://github.com/owner/repo/pull/7',",
  '    additions: 1, deletions: 0, changedFiles: 1,',
  "    files: [{ path: 'app.js', additions: 1, deletions: 0, changeType: 'MODIFIED' }],",
  '  })',
  '  process.exit(0)',
  '}',
  "if (args[0] === 'pr' && args[1] === 'diff') {",
  "  process.stdout.write(['diff --git a/app.js b/app.js', '--- a/app.js', '+++ b/app.js', '@@ -1 +1,2 @@', ' export const one = 1', '+export const two = 2', ''].join('\\n'))",
  '  process.exit(0)',
  '}',
  "if (args[0] === 'api') {",
  '  const pathname = args[args.length - 1]',
  "  if (pathname.includes('/issues/7/comments')) {",
  "    out([{ user: { login: 'bob' }, body: 'Earlier review note', created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/owner/repo/pull/7#c1' }])",
  '  } else {',
  '    out([])',
  '  }',
  '  process.exit(0)',
  '}',
  'process.exit(1)',
  '',
].join('\n')

async function withFakeGh(run) {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-gh-'))
  await writeFile(path.join(bin, 'gh'), FAKE_GH)
  await chmod(path.join(bin, 'gh'), 0o755)
  const original = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${original ?? ''}`
  try {
    return await run()
  } finally {
    process.env.PATH = original
    await rm(bin, { recursive: true, force: true })
  }
}

async function makePrRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-pr-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(repo, 'app.js'), 'export const one = 1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'initial'])
  git(repo, ['checkout', '-b', 'feature'])
  await writeFile(path.join(repo, 'app.js'), 'export const one = 1\nexport const two = 2\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'add two'])
  git(repo, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
  return repo
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

test('parseDiffHunks does not treat added content as file headers', () => {
  const patch = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' export const a = 1',
    '+++ this is an added line, not a header',
    ' export const c = 3',
    'diff --git a/new.txt b/new.txt',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,1 @@',
    '+hello',
  ].join('\n')
  const hunks = parseDiffHunks(patch)
  assert.deepEqual([...hunks.keys()], ['src/a.js', 'new.txt'])
  assert.deepEqual(hunks.get('src/a.js'), [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 }])
  assert.deepEqual(hunks.get('new.txt'), [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }])
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

test('renamed files keep their change counts instead of null', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-rename-'))
  try {
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(path.join(repo, 'a.js'), 'export const a = 1\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
    git(repo, ['checkout', '-b', 'feature'])
    git(repo, ['mv', 'a.js', 'renamed.js'])
    git(repo, ['commit', '-m', 'rename'])
    const context = await collectReviewContext({ cwd: repo, mode: 'local', base: 'main', includeDiscussion: false })
    const file = context.changedFiles.find(entry => entry.path === 'renamed.js')
    assert.ok(file, 'renamed file is listed')
    assert.equal(file.status, 'R')
    assert.equal(file.additions, 0)
    assert.equal(file.deletions, 0)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('local blame resolves uncommitted lines', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-blame-'))
  try {
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(path.join(repo, 'x.js'), 'export const one = 1\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
    await writeFile(path.join(repo, 'x.js'), 'export const one = 1\nexport const two = 2\n')
    const context = await collectReviewContext({ cwd: repo, mode: 'local', base: 'main', includeDiscussion: false })
    assert.equal(context.eligible, true)
    assert.equal(context.history.available, true)
    assert.match(context.history.text, /Not Committed Yet/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('stale review packets are pruned but fresh ones are kept', async () => {
  const stale = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-stale-'))
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-fresh-'))
  try {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    const removed = await pruneReviewPackets()
    assert.ok(removed >= 1)
    await assert.rejects(stat(stale))
    assert.ok((await stat(fresh)).isDirectory())
  } finally {
    await rm(stale, { recursive: true, force: true })
    await rm(fresh, { recursive: true, force: true })
  }
})

test('pull request mode collects the PR diff, discussion, and evidence', async () => {
  const repo = await makePrRepo()
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  const previous = process.env.FAKE_GH_HEAD
  process.env.FAKE_GH_HEAD = head
  try {
    await withFakeGh(async () => {
      const context = await collectReviewContext({ cwd: repo, mode: 'auto' })
      assert.equal(context.mode, 'pr')
      assert.equal(context.eligible, true)
      assert.equal(context.pr.number, 7)
      assert.equal(context.pr.headSha, head)
      assert.equal(context.discussion.length, 1)
      assert.match(context.discussion[0].body, /Earlier review note/)
      assert.match(context.diff.text, /export const two = 2/)
      assert.equal(context.codeContext.files >= 1, true)
      const packet = await writeReviewPacket(context)
      const roleText = await readFile(packet.rolePaths[packet.roles[0]], 'utf8')
      assert.match(roleText, /Earlier review note/)
    })
  } finally {
    if (previous === undefined) delete process.env.FAKE_GH_HEAD
    else process.env.FAKE_GH_HEAD = previous
    await rm(repo, { recursive: true, force: true })
  }
})

test('a pull request from another repository is not attributed to the checkout', async () => {
  const repo = await makePrRepo()
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  const previousHead = process.env.FAKE_GH_HEAD
  const previousCheckout = process.env.FAKE_GH_CHECKOUT
  process.env.FAKE_GH_HEAD = head
  process.env.FAKE_GH_CHECKOUT = 'someone/else'
  try {
    await withFakeGh(async () => {
      const context = await collectReviewContext({ cwd: repo, mode: 'auto' })
      assert.equal(context.mode, 'pr')
      assert.equal(context.eligible, true)
      assert.equal(context.repo, 'owner/repo')
      assert.equal(context.codeContext.files, 0)
      assert.equal(context.guidance.length, 0)
      assert.ok(context.notes.some(note => note.includes('belongs to owner/repo, not the checked-out repository someone/else')))
    })
  } finally {
    if (previousHead === undefined) delete process.env.FAKE_GH_HEAD
    else process.env.FAKE_GH_HEAD = previousHead
    if (previousCheckout === undefined) delete process.env.FAKE_GH_CHECKOUT
    else process.env.FAKE_GH_CHECKOUT = previousCheckout
    await rm(repo, { recursive: true, force: true })
  }
})

test('clean and non-repository trees are ineligible', async () => {
  const clean = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-clean-'))
  git(clean, ['init', '-b', 'main'])
  git(clean, ['config', 'user.name', 'Test User'])
  git(clean, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(clean, 'file.txt'), 'one\n')
  git(clean, ['add', '.'])
  git(clean, ['commit', '-m', 'initial'])
  const cleanContext = await collectReviewContext({ cwd: clean, mode: 'local', base: 'main' })
  assert.equal(cleanContext.eligible, false)
  assert.match(cleanContext.reason, /No changes were found/)

  const plain = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-plain-'))
  const plainContext = await collectReviewContext({ cwd: plain, mode: 'auto' })
  assert.equal(plainContext.eligible, false)
  assert.match(plainContext.reason, /not inside a git repository/)
  await rm(clean, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})
