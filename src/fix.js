/**
 * Pure-ish helpers behind `@hrg/dsh-md-fix-tables`.
 *
 * Everything in this module is free of Harness imports, so it can be unit-tested with plain
 * `bun test` (see `test/fix.test.js`); `src/index.js` is the thin Cordis plugin on top.
 *
 * The job: given one finished tool call (`write`/`edit`), find the Markdown files it touched, run
 * the `md-fix-tables` CLI on each of them **in place**, and describe what changed so the tool result
 * can tell the model.
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Extensions treated as Markdown unless the plugin config says otherwise. */
export const DEFAULT_EXTENSIONS = ['.md', '.markdown']

/** Argument keys that may carry a file path; checked in this order. */
export const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'files', 'paths', 'target', 'targets']

/** Longest file the fixer is run on, unless configured otherwise (2 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

const isString = value => typeof value === 'string'

/** One path-like value: a string, or an object carrying a path under one of {@link PATH_KEYS}. */
export function pathFromValue(value) {
  if (isString(value)) return value
  if (!value || typeof value !== 'object') return undefined
  for (const key of PATH_KEYS) {
    const inner = value[key]
    if (isString(inner)) return inner
  }
  return undefined
}

/**
 * File paths a tool call mentions, filtered by extension and (when they exist) by file-ness.
 *
 * Only the documented path-bearing argument keys are read — never a recursive scan — so a Markdown
 * document passed as `content` can never be mistaken for a path.
 *
 * @param {unknown} args parsed tool arguments
 * @param {string[]} extensions accepted lowercase extensions, e.g. `['.md']`
 * @param {(path: string) => string|undefined} [resolvePath] resolver hook (cwd handling); identity by default
 * @returns {string[]} candidate paths, deduplicated, in argument order
 */
export function collectPaths(args, extensions = DEFAULT_EXTENSIONS, resolvePath) {
  if (!args || typeof args !== 'object') return []
  const accepted = new Set(extensions.map(ext => String(ext).toLowerCase()))
  const out = []
  const seenRaw = new Set()
  const seen = new Set()
  const push = raw => {
    if (!isString(raw) || raw === '') return
    const ext = extname(raw).toLowerCase()
    if (!accepted.has(ext)) return
    if (seenRaw.has(raw)) return
    seenRaw.add(raw)
    const candidate = resolvePath ? resolvePath(raw) : raw
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    out.push(candidate)
  }
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (Array.isArray(value)) for (const entry of value) push(pathFromValue(entry))
    else push(pathFromValue(value))
  }
  return out
}

/** Split into lines without caring about the line ending, and without a trailing empty line. */
export function toLines(text) {
  const body = String(text).replace(/\r\n/g, '\n')
  const lines = body.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * How a before/after pair differs, by line.
 *
 * @param {Buffer|string} before
 * @param {Buffer|string} after
 * @returns {{changed: boolean, changedLines: number, totalLines: number}}
 */
export function summarizeChange(before, after) {
  const same = Buffer.isBuffer(before) && Buffer.isBuffer(after) ? before.equals(after) : String(before) === String(after)
  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  if (same) return { changed: false, changedLines: 0, totalLines: afterLines.length }
  let changedLines = Math.abs(afterLines.length - beforeLines.length)
  const shared = Math.min(beforeLines.length, afterLines.length)
  for (let i = 0; i < shared; i++) if (beforeLines[i] !== afterLines[i]) changedLines++
  return { changed: true, changedLines, totalLines: afterLines.length }
}

/** `C:\a\b\c.md` under `C:\a` becomes `b/c.md`; anything else stays absolute. */
export function displayPath(file, cwd) {
  if (!cwd) return file
  const rel = relative(cwd, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return file
  return rel.split(sep).join('/')
}

/**
 * The model-facing report for one batch of fixes, or `undefined` when there is nothing worth saying.
 *
 * **Context budget.** The report is deliberately line-counts-only and ASCII: it never contains the
 * file body, a table, or a diff, and it renders as a single line. Nothing is produced when the call
 * changed no table (unless `includeUnchanged` is set) and nothing when the file was already aligned,
 * so the common case costs zero tokens.
 *
 * @param {{file: string, changed: boolean, changedLines: number, totalLines: number, error?: string, skipped?: string}[]} results
 * @param {{cwd?: string, maxChars?: number, includeUnchanged?: boolean}} [options]
 */
export function formatReport(results, options = {}) {
  const { cwd, maxChars = 400, includeUnchanged = false } = options
  if (!Array.isArray(results) || results.length === 0) return undefined
  const changed = results.filter(result => result.changed)
  const failed = results.filter(result => result.error)
  const unchanged = includeUnchanged
    ? results.filter(result => !result.changed && !result.error && !result.skipped)
    : []
  if (changed.length === 0 && failed.length === 0 && unchanged.length === 0) return undefined

  const parts = []
  if (changed.length === 1) {
    const only = changed[0]
    parts.push(
      `[md-fix-tables] realigned ${displayPath(only.file, cwd)}, ${only.changedLines}/${only.totalLines} lines changed`,
    )
  } else if (changed.length > 1) {
    const files = changed.map(result => `${displayPath(result.file, cwd)} ${result.changedLines}/${result.totalLines}`)
    parts.push(`[md-fix-tables] realigned ${changed.length} files: ${files.join(', ')}`)
  }
  if (failed.length > 0) {
    const detail = failed.map(result => `${displayPath(result.file, cwd)} (${result.error})`).join(', ')
    parts.push(changed.length > 0 ? `fixer failed: ${detail}` : `[md-fix-tables] fixer failed: ${detail}`)
  }
  if (unchanged.length > 0) {
    parts.push(`already aligned: ${unchanged.map(result => displayPath(result.file, cwd)).join(', ')}`)
  }
  const text = parts.join('; ')
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/**
 * Append {@link formatReport}'s text to a `tools/post-execute` decision.
 *
 * Rules that keep the projection honest:
 * - a `block` decision and the `accept`-with-`value` variant are returned untouched (their content
 *   is either corrective feedback or deliberately value-only);
 * - otherwise the report is appended to the content the decision already produced, falling back to
 *   the result's own content, so the tool's own message is never replaced.
 */
export function appendReport(decision, result, report) {
  if (!report || !decision || decision.kind !== 'accept' || decision.value !== undefined) return decision
  const base = Array.isArray(decision.content) ? decision.content : result?.content
  if (!Array.isArray(base)) return decision
  return { ...decision, content: [...base, { type: 'text', text: report }] }
}

/** Resolve the `md-fix-tables` executable: an explicit command, the bundled dependency, or PATH. */
export function resolveFixer({ command, commandArgs = [] } = {}, requireFn = createRequire(import.meta.url)) {
  if (isString(command) && command !== '') return { command, args: [...commandArgs] }
  try {
    const manifestPath = requireFn.resolve('@hrg/md-fix-tables/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['md-fix-tables']
    if (isString(bin) && bin !== '') {
      return { command: process.execPath, args: [resolve(dirname(manifestPath), bin), ...commandArgs] }
    }
  } catch {
    // not resolvable from this package: fall through to PATH
  }
  return { command: 'md-fix-tables', args: [...commandArgs], shell: process.platform === 'win32' }
}

/** Run the fixer on one file; resolves with `{ code, timedOut, stdout, stderr }`. */
export function runFixer(fixer, file, timeoutMs) {
  return new Promise(resolvePromise => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    let child
    try {
      child = spawn(fixer.command, [...fixer.args, file], {
        shell: fixer.shell === true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ code: -1, timedOut: false, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, timeoutMs)
        : undefined
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      finish({ code: -1, timedOut, stdout, stderr: stderr || String(error?.message ?? error) })
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      finish({ code: code ?? -1, timedOut, stdout, stderr })
    })
  })
}

/** Is `file` an existing regular file no larger than `maxBytes`? */
export function fileSizeWithin(file, maxBytes) {
  try {
    const stats = statSync(file)
    return stats.isFile() && stats.size <= maxBytes
  } catch {
    return false
  }
}

/**
 * Fix one file in place.
 *
 * @returns {Promise<{file: string, changed: boolean, changedLines: number, totalLines: number, error?: string, skipped?: string}>}
 */
export async function fixMarkdownFile(file, settings) {
  const { fixer, timeoutMs, maxFileBytes } = settings
  if (!fileSizeWithin(file, maxFileBytes)) {
    return { file, changed: false, changedLines: 0, totalLines: 0, skipped: 'missing, not a file, or too large' }
  }
  let before
  try {
    before = readFileSync(file)
  } catch (error) {
    return { file, changed: false, changedLines: 0, totalLines: 0, error: String(error?.message ?? error) }
  }
  const run = await runFixer(fixer, file, timeoutMs)
  if (run.code !== 0) {
    const detail = run.timedOut ? `timed out after ${timeoutMs}ms` : run.stderr.trim() || `exit code ${run.code}`
    return { file, changed: false, changedLines: 0, totalLines: 0, error: detail }
  }
  let after
  try {
    after = readFileSync(file)
  } catch (error) {
    return { file, changed: false, changedLines: 0, totalLines: 0, error: String(error?.message ?? error) }
  }
  return { file, ...summarizeChange(before, after) }
}

/**
 * Serialize work per file, so two overlapping tool calls that touch the same document cannot
 * interleave their read/rewrite pairs.
 *
 * @returns {(key: string, task: () => Promise<any>) => Promise<any>}
 */
export function createFileQueue() {
  /** @type {Map<string, Promise<any>>} */
  const chains = new Map()
  return (key, task) => {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    chains.set(key, settled)
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return next
  }
}
