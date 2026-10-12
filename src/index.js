/**
 * `@hrg/dsh-md-fix-tables` — a DeepSeek Harness bundle that keeps the Markdown tables an agent
 * writes aligned, and tells the agent what it changed.
 *
 * It listens on the `tools/post-execute` waterfall: when `write` or `edit` touched a Markdown file,
 * the `md-fix-tables` CLI rewrites that file's pipe tables in place, and one line of line counts is
 * appended to the tool's model-facing content. Nothing else about the tool call changes, and the
 * Markdown itself is never echoed back into the conversation (see `formatReport`).
 *
 * The plugin never throws into the tool pipeline: an unresolvable fixer, a timeout or a bad file is
 * reported as text once, and the loop continues.
 */
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_FILE_BYTES,
  appendReport,
  collectPaths,
  createFileQueue,
  fixMarkdownFile,
  formatReport,
  resolveFixer,
} from './fix.js'

/** Plugin name used by the Loader diagnostics. */
export const name = 'md-fix-tables'

/** The `tools` service owns the `tools/post-execute` waterfall this plugin listens on. */
export const inject = ['tools']

/** Tunables, overridable from a profile's `cordis.patch.yml` (see README). */
export const Config = z.object({
  enabled: z.boolean().default(true),
  tools: z.array(z.string()).default(['write', 'edit']),
  extensions: z.array(z.string()).default(DEFAULT_EXTENSIONS),
  command: z.string(),
  commandArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().step(1).min(1).default(15000),
  report: z.union(['changed', 'always', 'never']).default('changed'),
  prompt: z.boolean().default(true),
  maxReportChars: z.number().step(1).min(80).default(400),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  cwd: z.string(),
})

const DEFAULT_TOOLS = ['write', 'edit']
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_REPORT_CHARS = 400

/**
 * The one prompt sentence this plugin adds, so the model knows the convention before it writes:
 * table alignment is not its job and a result note is not a file to re-read. It is a single
 * constant line in the (cacheable) prompt prefix — far cheaper than a model re-reading a file to
 * check its tables. `prompt: false` removes it.
 */
export const PROMPT_SECTION = {
  name: 'plugin:md-fix-tables',
  // 1350 sits between the shipped `edit` section (TOOL_EDIT = 1300) and `glob` (1400) in the
  // system-prompt order table, so the note reads next to the tools it describes.
  order: 1350,
  text:
    'Markdown pipe tables are realigned automatically after write/edit; the `[md-fix-tables]` note in that result gives only changed line counts, so never re-read or hand-align a Markdown file just to check its tables.',
}

/** Plain-JS defaults, so the plugin behaves the same even if `Config` validation is bypassed. */
function normalize(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    tools: Array.isArray(source.tools) && source.tools.length > 0 ? source.tools : DEFAULT_TOOLS,
    extensions:
      Array.isArray(source.extensions) && source.extensions.length > 0 ? source.extensions : DEFAULT_EXTENSIONS,
    command: typeof source.command === 'string' && source.command !== '' ? source.command : undefined,
    commandArgs: Array.isArray(source.commandArgs) ? source.commandArgs : [],
    timeoutMs: Number.isFinite(source.timeoutMs) ? source.timeoutMs : DEFAULT_TIMEOUT_MS,
    report: source.report === 'always' || source.report === 'never' ? source.report : 'changed',
    prompt: source.prompt !== false,
    maxReportChars: Number.isFinite(source.maxReportChars)
      ? source.maxReportChars
      : DEFAULT_MAX_REPORT_CHARS,
    maxFileBytes: Number.isFinite(source.maxFileBytes) ? source.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
    cwd: typeof source.cwd === 'string' && source.cwd !== '' ? source.cwd : undefined,
  }
}

/** The session working directory, when the runtime exposes one; used to resolve relative paths.
 *
 *  `agent.session.header.cwd` is the durable session metadata (dsh-session `SessionHeader`); the
 *  other shapes are tolerated so a different runtime generation degrades to `process.cwd()` instead
 *  of misbehaving.
 */
function baseCwd(exec, settings) {
  const agent = exec?.agent
  return (
    settings.cwd ||
    agent?.session?.header?.cwd ||
    agent?.cwd ||
    agent?.sessionMeta?.cwd ||
    agent?.meta?.cwd ||
    agent?.session?.meta?.cwd ||
    process.cwd()
  )
}

/** Resolve one argument path against the session directory first, then against the process cwd. */
function resolveCandidate(raw, base) {
  if (isAbsolute(raw)) return raw
  const fromBase = base ? resolve(base, raw) : undefined
  if (fromBase && existsSync(fromBase)) return fromBase
  const fromCwd = resolve(process.cwd(), raw)
  if (existsSync(fromCwd)) return fromCwd
  return fromBase ?? fromCwd
}

/**
 * The system-prompt service, resolved the ways the Harness supports.
 *
 * The shipped idiom is `ctx.inject(['systemPrompt'], promptCtx => …)` (what `dsh-web-app` uses for
 * its web-surface note); the injected property (`ctx.systemPrompt.section(...)`) and the reflective
 * `ctx.get('systemPrompt')` are the fallbacks. Accessing an uninjected property can throw, so every
 * attempt is guarded: a profile without the service simply gets no note, and the fixing half of the
 * plugin keeps working either way.
 */
function registerPromptSection(ctx, register) {
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['systemPrompt'], promptCtx => register(promptCtx.systemPrompt))
    return
  }
  try {
    if (typeof ctx?.systemPrompt?.section === 'function') return register(ctx.systemPrompt)
  } catch {
    // fall through to the reflective accessor
  }
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (typeof viaGet?.section === 'function') return register(viaGet)
  } catch {
    // no prompt service in this profile
  }
  return undefined
}

export function apply(ctx, config = {}) {
  const settings = normalize(config)
  if (!settings.enabled) return

  // One constant prompt line, so the model knows it need not align tables itself nor re-read a file
  // to check them. Registered on the profile-level scope this plugin is mounted in (the same scope
  // `dsh-web-app` registers its web-surface note in), so every session of the profile gets it; it is
  // removed again when the plugin unloads. `prompt: false` skips it entirely.
  if (settings.prompt) {
    try {
      registerPromptSection(ctx, systemPrompt => {
        const section = () => systemPrompt.section(PROMPT_SECTION)
        // `ctx.effect` owns the registration where available (the `dsh-persona` idiom)
        if (typeof ctx.effect === 'function') ctx.effect(section, 'md-fix-tables: prompt section')
        else section()
      })
    } catch (error) {
      ctx.logger?.warn?.(`md-fix-tables: could not add the prompt note (${error?.message ?? error})`)
    }
  }

  let fixer
  /** Set once the fixer proved unresolvable, so the warning is printed once, not per file. */
  let fixerUnavailable = false
  const queue = createFileQueue()

  const fixerFor = () => {
    if (!fixer) fixer = resolveFixer({ command: settings.command, commandArgs: settings.commandArgs })
    return fixer
  }

  const fixOne = async file => {
    if (fixerUnavailable) return { file, changed: false, changedLines: 0, totalLines: 0, skipped: 'fixer unavailable' }
    const result = await queue(file, () =>
      fixMarkdownFile(file, {
        fixer: fixerFor(),
        timeoutMs: settings.timeoutMs,
        maxFileBytes: settings.maxFileBytes,
      }),
    )
    if (result?.error) {
      const missing = /ENOENT|not found|not recognized/i.test(result.error)
      if (missing && !fixerUnavailable) {
        fixerUnavailable = true
        ctx.logger?.warn?.(
          `md-fix-tables: cannot run the fixer (${result.error}). Install @hrg/md-fix-tables, put md-fix-tables on PATH, or set the plugin's config.command.`,
        )
      } else if (!missing) {
        ctx.logger?.warn?.(`md-fix-tables: ${result.file}: ${result.error}`)
      }
      return result
    }
    if (result?.changed) {
      ctx.logger?.info?.(`md-fix-tables: realigned ${result.file} (${result.changedLines} lines)`)
    }
    return result
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const base = baseCwd(exec, settings)
    let results = []
    if (!result?.isError && settings.report !== 'never' && settings.tools.includes(exec?.name)) {
      const files = collectPaths(exec?.arguments, settings.extensions, raw => resolveCandidate(raw, base))
      for (const file of files) results.push(await fixOne(file))
    }
    // The rest of the waterfall decides the tool's outcome; this plugin only adds a note to it.
    const decision = await next()
    const report = formatReport(results, {
      cwd: base,
      maxChars: settings.maxReportChars,
      includeUnchanged: settings.report === 'always',
    })
    return appendReport(decision, result, report)
  })
}
