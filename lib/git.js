/**
 * Small promise wrapper around child processes used by the review context
 * collector. Every command is executed without a shell so repository text can
 * never be interpreted as a command line.
 */
import { execFile } from 'node:child_process'

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
}

/**
 * Run one command and collect its complete output.
 * @param {string} command executable name or path
 * @param {string[]} args argument vector, never shell-quoted
 * @param {{cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBuffer?: number}} options
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, missing: boolean, timedOut: boolean, aborted: boolean}>}
 */
export function runCommand(command, args, options = {}) {
  const { cwd, signal, timeoutMs = 30_000, maxBuffer = DEFAULT_MAX_BUFFER } = options
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer,
      timeout: timeoutMs,
      signal,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
    }, (error, stdout, stderr) => {
      const output = typeof stdout === 'string' ? stdout : ''
      const errors = typeof stderr === 'string' ? stderr : ''
      if (error === null || error === undefined) {
        resolve({ ok: true, code: 0, stdout: output, stderr: errors, missing: false, timedOut: false, aborted: false })
        return
      }
      const missing = error.code === 'ENOENT'
      const timedOut = error.killed === true || error.code === 'ETIMEDOUT'
      const aborted = error.name === 'AbortError' || error.code === 'ABORT_ERR'
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: output,
        stderr: errors,
        missing,
        timedOut,
        aborted,
      })
    })
  })
}

/** Run git without a pager, colors, or quoted non-ASCII paths. */
export function git(cwd, args, options = {}) {
  return runCommand('git', [
    '-c', 'core.quotepath=false',
    '-c', 'color.ui=false',
    '-c', 'core.pager=cat',
    ...args,
  ], { cwd, ...options })
}

/** Run the GitHub CLI. */
export function gh(cwd, args, options = {}) {
  return runCommand('gh', args, { cwd, ...options })
}

/** First non-empty stderr or stdout line, for compact diagnostics. */
export function firstLine(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0)
  return line ?? ''
}
