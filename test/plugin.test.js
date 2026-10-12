/**
 * Wiring tests for the Cordis plugin itself.
 *
 * `apply` is called with a fake context that captures the `tools/post-execute` listener, so the hook
 * can be exercised without a Harness: path resolution, the real fixer run, the report text and the
 * decision merge are all covered here.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply, Config, inject, name, PROMPT_SECTION } from '../src/index.js'

const scratch = mkdtempSync(join(tmpdir(), 'md-fix-tables-plugin-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const MISALIGNED = '| a | bbbb |\n| --- | --- |\n| 1 | 2 |\n'

/**
 * A context that records listeners and prompt sections, plus the exec/result/next triple a hook needs.
 *
 * `promptService` picks how the prompt service is exposed: `inject` (the shipped idiom, default),
 * `property` (an already-injected `ctx.systemPrompt`), `get` (the loader-expression form),
 * `throwing` (an uninjected property access) or `none`.
 */
function harness(config, { promptService = 'inject', expectHook = true } = {}) {
  const listeners = new Map()
  const sections = []
  const warnings = []
  const infos = []
  const systemPrompt = { section: section => sections.push(section) }
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
    },
    effect(callback) {
      return callback()
    },
    logger: {
      warn: message => warnings.push(String(message)),
      info: message => infos.push(String(message)),
    },
  }
  if (promptService === 'inject') {
    ctx.inject = (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('systemPrompt')) callback({ systemPrompt })
      return () => {}
    }
  } else if (promptService === 'property') {
    ctx.systemPrompt = systemPrompt
  } else if (promptService === 'get') {
    ctx.get = name => (name === 'systemPrompt' ? systemPrompt : undefined)
  } else if (promptService === 'throwing') {
    Object.defineProperty(ctx, 'systemPrompt', {
      get() {
        throw new Error('service systemPrompt is not available')
      },
    })
  }
  apply(ctx, config)
  const hook = listeners.get('tools/post-execute')
  if (expectHook) assert.ok(hook, 'the plugin registers a tools/post-execute listener')
  const run = (exec, result = { isError: false, content: [{ type: 'text', text: 'done' }] }) =>
    hook(exec, result, async () => ({ kind: 'accept' }))
  return { run, warnings, infos, listeners, sections }
}

test('the plugin declares its name, injection and config schema', () => {
  assert.equal(name, 'md-fix-tables')
  assert.deepEqual(inject, ['tools'])
  assert.ok(Config, 'a Config schema is exported')
  assert.equal(PROMPT_SECTION.name, 'plugin:md-fix-tables')
  assert.equal(typeof PROMPT_SECTION.order, 'number')
  assert.match(PROMPT_SECTION.text, /\[md-fix-tables\]/)
})

test('the prompt note is registered once, next to the edit tool section', () => {
  const { sections } = harness({})
  assert.equal(sections.length, 1)
  assert.equal(sections[0], PROMPT_SECTION)
  assert.ok(sections[0].order > 1300 && sections[0].order < 1400, 'between edit (1300) and glob (1400)')
  assert.ok(sections[0].text.length < 260, 'the prompt note stays one short sentence')
})

test('the prompt note registers through inject, an injected property and ctx.get alike', () => {
  for (const style of ['inject', 'property', 'get']) {
    const { sections } = harness({}, { promptService: style })
    assert.equal(sections.length, 1, `registered through ${style}`)
    assert.equal(sections[0].name, 'plugin:md-fix-tables')
  }
})

test('a throwing accessor or a missing service is safe and silent', () => {
  const throwing = harness({}, { promptService: 'throwing' })
  assert.equal(throwing.sections.length, 0)
  assert.equal(throwing.warnings.length, 0, 'an unavailable service is not a warning')
  assert.equal(harness({}, { promptService: 'none' }).sections.length, 0)
})

test('prompt: false and enabled: false add no prompt note', () => {
  assert.equal(harness({ prompt: false }).sections.length, 0)
  const disabled = harness({ enabled: false }, { expectHook: false })
  assert.equal(disabled.sections.length, 0)
  assert.equal(disabled.listeners.size, 0)
})

test('a write call realigns the file and reports one line relative to the session directory', async () => {
  const { run } = harness({})
  const file = join(scratch, 'doc.md')
  writeFileSync(file, MISALIGNED)

  const decision = await run({
    name: 'write',
    arguments: { file_path: file },
    agent: { session: { header: { cwd: scratch } } },
  })

  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.equal(decision.content[0].text, 'done')
  const report = decision.content[1].text
  assert.equal(report, '[md-fix-tables] realigned doc.md, 3/3 lines changed')
  assert.ok(!report.includes('|') && !report.includes('bbbb'), 'the Markdown never comes back')
  assert.match(readFileSync(file, 'utf8'), /\| a   \| bbbb \|/)
})

test('an already aligned file costs no tokens; report: always opts into a note', async () => {
  const aligned = '| a   | bbbb |\n| --- | ---- |\n| 1   | 2    |\n'
  const silent = harness({})
  const file = join(scratch, 'already.md')
  writeFileSync(file, aligned)
  const quiet = await silent.run({
    name: 'write',
    arguments: { file_path: file },
    agent: { session: { header: { cwd: scratch } } },
  })
  assert.equal(quiet.content, undefined, 'nothing is added when no table changed')

  const loud = harness({ report: 'always' })
  const spoken = await loud.run({
    name: 'write',
    arguments: { file_path: file },
    agent: { session: { header: { cwd: scratch } } },
  })
  assert.match(spoken.content[1].text, /already aligned: already\.md/)
})

test('a relative path resolves against the session directory', async () => {
  const { run } = harness({})
  const file = join(scratch, 'relative.md')
  writeFileSync(file, MISALIGNED)

  const decision = await run({
    name: 'edit',
    arguments: { file_path: 'relative.md' },
    agent: { session: { header: { cwd: scratch } } },
  })

  assert.match(decision.content[1].text, /realigned relative\.md, 3\/3 lines changed/)
  assert.match(readFileSync(file, 'utf8'), /\| --- \| ---- \|/)
})

test('other tools, failed results and non-Markdown paths are left alone', async () => {
  const { run } = harness({})
  const file = join(scratch, 'untouched.md')
  writeFileSync(file, MISALIGNED)

  const read = await run({ name: 'read', arguments: { file_path: file } })
  assert.equal(read.content, undefined)
  const failed = await run(
    { name: 'write', arguments: { file_path: file } },
    { isError: true, error: { message: 'denied' }, content: [] },
  )
  assert.equal(failed.content, undefined)
  const text = await run({ name: 'write', arguments: { file_path: join(scratch, 'notes.txt') } })
  assert.equal(text.content, undefined)
  assert.match(readFileSync(file, 'utf8'), /\| a \| bbbb \|/, 'the file was never realigned')
})

test('report: never skips both the fix and the note', async () => {
  const { run } = harness({ report: 'never' })
  const file = join(scratch, 'silent.md')
  writeFileSync(file, MISALIGNED)
  const decision = await run({ name: 'write', arguments: { file_path: file } })
  assert.equal(decision.content, undefined)
  assert.match(readFileSync(file, 'utf8'), /\| a \| bbbb \|/)
})

test('an unresolvable fixer warns once instead of throwing', async () => {
  const { run, warnings } = harness({ command: 'definitely-not-a-real-command-xyz' })
  const file = join(scratch, 'broken-cmd.md')
  writeFileSync(file, MISALIGNED)

  const first = await run({ name: 'write', arguments: { file_path: file } })
  assert.equal(first.kind, 'accept')
  assert.match(first.content[1].text, /^\[md-fix-tables\] fixer failed: /)
  const second = await run({ name: 'write', arguments: { file_path: file } })
  assert.equal(second.kind, 'accept')
  assert.equal(warnings.length, 1, 'the missing-fixer warning is logged once per session')
})
