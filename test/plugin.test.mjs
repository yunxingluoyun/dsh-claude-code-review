import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function mount(config = {}) {
  const registered = {}
  const ctx = {
    tools: { register: (definition) => { registered.tool = definition } },
    workingDirectory: { ensure: async () => registered.cwd },
    logger: { info() {} },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register: (command) => { registered.command = command } } })
      if (names.includes('skills')) callback({ skills: { register: (skill) => { registered.skill = skill } } })
    },
  }
  apply(ctx, config)
  return registered
}

let root = ''

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-claude-code-review-plugin-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Test User'])
  git(root, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(root, 'AGENTS.md'), 'Prefer small functions.\n')
  await writeFile(path.join(root, 'app.js'), 'export const one = 1\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])
  await writeFile(path.join(root, 'app.js'), 'export const one = 1\nexport const two = 2\n')
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

test('apply registers the command, skill, and tool', () => {
  const registered = mount()
  assert.equal(registered.command.name, 'code-review')
  assert.match(registered.command.description, /Review a pull request/)
  assert.equal(registered.skill.name, 'code-review')
  assert.equal(registered.skill.invocation.userInvocable, false)
  assert.equal(registered.skill.invocation.modelInvocable, true)
  assert.match(registered.skill.content, /one self-contained role file per planned reviewer/)
  assert.equal(registered.tool.name, 'code_review_context')
  assert.equal(registered.tool.parameters.type, 'object')
  assert.equal(typeof registered.tool.execute, 'function')
  assert.equal(typeof registered.tool.output.render, 'function')
})

test('the command submits a workflow prompt with options', () => {
  const registered = mount({ threshold: 85 })
  const messages = []
  const result = registered.command.handler({
    agent: { followup: (message) => messages.push(message) },
    rawInput: '123 --post --threshold 90',
  })
  assert.equal(result.kind, 'success')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(typeof messages[0].id, 'string')
  assert.equal(messages[0].source.kind, 'code-review')
  assert.equal(messages[0].source.form, 'notice')
  assert.match(messages[0].source.summary, /Code review: 123, threshold 90/)
  const text = messages[0].content[0].text
  assert.match(text, /Target: 123/)
  assert.match(text, /Post the report to the pull request: yes/)
  assert.match(text, /Confidence threshold: 90/)
  assert.match(text, /"target":"123"/)
})

test('--fast switches the verification mode', () => {
  const registered = mount()
  const messages = []
  registered.command.handler({ agent: { followup: (message) => messages.push(message) }, rawInput: '--fast 123' })
  assert.match(messages[0].content[0].text, /Verification: fast/)
  const fast = registered.command.handler({ agent: { followup: (message) => messages.push(message) }, rawInput: '--thorough' })
  assert.equal(fast.kind, 'success')
  assert.match(messages[1].content[0].text, /Verification: thorough/)
})

test('the command reports invalid options without submitting a message', () => {
  const registered = mount()
  let submitted = 0
  const result = registered.command.handler({
    agent: { followup: () => { submitted += 1 } },
    rawInput: '--nope',
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Unknown option: --nope/)
  assert.equal(submitted, 0)
})

test('help returns usage text', () => {
  const registered = mount()
  const result = registered.command.handler({ agent: { followup: () => {} }, rawInput: '--help' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Usage: \/code-review/)
})

test('the skill body reflects the configured settings', () => {
  const registered = mount({
    threshold: 92,
    verificationMode: 'thorough',
    reviewerProvider: 'deepseek',
    reviewerModel: 'deepseek-chat',
  })
  assert.match(registered.skill.content, /Confidence threshold: 92/)
  assert.match(registered.skill.content, /Verification: thorough/)
  assert.match(registered.skill.content, /provider: "deepseek", model: "deepseek-chat"/)
})

test('invalid configuration fails at activation instead of being ignored', () => {
  assert.throws(() => mount({ threshold: 101 }), /config "threshold" must be a number from 0 to 100/)
  assert.throws(() => mount({ skipDrafts: 'yes' }), /config "skipDrafts" must be true or false/)
  assert.throws(() => mount({ verificationMode: 'quick' }), /config "verificationMode" must be one of/)
  assert.throws(() => mount({ unknownSetting: 1 }), /Unknown dsh-claude-code-review config key "unknownSetting"/)
  assert.equal(mount({ threshold: 0 }).skill.content.includes('Confidence threshold: 0'), true)
})

test('conflicting options and help precedence are handled', () => {
  const registered = mount()
  const help = registered.command.handler({ agent: { followup: () => {} }, rawInput: '--help --nope' })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /Usage: \/code-review/)
  const prBase = registered.command.handler({ agent: { followup: () => {} }, rawInput: '--pr --base main' })
  assert.equal(prBase.kind, 'error')
  assert.match(prBase.text, /--base cannot be combined with --pr/)
  const localTarget = registered.command.handler({ agent: { followup: () => {} }, rawInput: '--local 123' })
  assert.equal(localTarget.kind, 'error')
  assert.match(localTarget.text, /cannot be combined with --local/)
})

test('the command accepts a zero confidence threshold', () => {
  const registered = mount({ threshold: 80 })
  const messages = []
  const result = registered.command.handler({
    agent: { followup: (message) => messages.push(message) },
    rawInput: '--threshold 0 --local',
  })
  assert.equal(result.kind, 'success')
  assert.match(messages[0].content[0].text, /Confidence threshold: 0/)
  assert.match(messages[0].source.summary, /threshold 0/)
})

test('the tool returns a packet for the session working directory', async () => {
  const registered = mount({ threshold: 80 })
  registered.cwd = root
  const controller = new AbortController()
  const value = await registered.tool.execute(
    { mode: 'local', base: 'main', includeDiscussion: false },
    { agent: {}, signal: controller.signal, callId: 'test', name: 'code_review_context', arguments: {} },
  )
  assert.equal(value.eligible, true)
  assert.equal(value.mode, 'local')
  assert.ok(value.summary.includes('Code review packet ready.'))
  assert.ok(value.diffPath.endsWith('diff.patch'))
  assert.ok(value.contextPath.endsWith('context.md'))
  assert.ok(value.roles.length >= 1)
  assert.ok(value.rolePaths[value.roles[0]].endsWith('.md'))
  assert.ok(value.verifyPath.endsWith('verify.md'))
  assert.equal(value.suggestedReviewers, value.roles.length)
  const rendered = registered.tool.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, value.summary)
})
