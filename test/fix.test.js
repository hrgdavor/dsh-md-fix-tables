/**
 * Unit and end-to-end tests for the helpers that do the work behind the plugin.
 *
 * `src/index.js` (the Cordis plugin) is deliberately not imported here: these tests stay free of
 * Harness imports and run under `bun test` (or `node --test`).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  appendReport,
  collectPaths,
  createFileQueue,
  displayPath,
  fixMarkdownFile,
  formatReport,
  pathFromValue,
  resolveFixer,
  runFixer,
  summarizeChange,
  toLines,
} from '../src/fix.js'

const scratch = mkdtempSync(join(tmpdir(), 'md-fix-tables-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const MISALIGNED = '| a | bbbb |\n| --- | --- |\n| 1 | 2 |\n'

test('pathFromValue reads the documented keys only', () => {
  assert.equal(pathFromValue('docs/a.md'), 'docs/a.md')
  assert.equal(pathFromValue({ file_path: 'docs/b.md' }), 'docs/b.md')
  assert.equal(pathFromValue({ path: 'docs/c.md', other: 'x' }), 'docs/c.md')
  assert.equal(pathFromValue({ content: 'docs/d.md' }), undefined)
  assert.equal(pathFromValue(42), undefined)
})

test('collectPaths filters by extension, deduplicates and honours the resolver', () => {
  const args = {
    file_path: 'a.md',
    files: ['b.markdown', 'c.txt', { path: 'd.MD' }],
    paths: ['a.md', 'e.md'],
    content: 'not-a-path.md',
    unrelated: 7,
  }
  const seen = []
  const resolved = collectPaths(args, ['.md', '.markdown'], raw => {
    seen.push(raw)
    return `/root/${raw}`
  })
  assert.deepEqual(resolved, ['/root/a.md', '/root/b.markdown', '/root/d.MD', '/root/e.md'])
  assert.deepEqual(seen, ['a.md', 'b.markdown', 'd.MD', 'e.md'])
  assert.deepEqual(collectPaths(null), [])
  assert.deepEqual(collectPaths({ file_path: 'a.txt' }), [])
})

test('toLines and summarizeChange count realigned lines', () => {
  assert.deepEqual(toLines('a\r\nb\n'), ['a', 'b'])
  assert.deepEqual(summarizeChange(MISALIGNED, MISALIGNED), {
    changed: false,
    changedLines: 0,
    totalLines: 3,
  })
  const aligned = '| a   | bbbb |\n| --- | ---- |\n| 1   | 2    |\n'
  assert.deepEqual(summarizeChange(MISALIGNED, aligned), {
    changed: true,
    changedLines: 3,
    totalLines: 3,
  })
  const grown = `${MISALIGNED}| 3 | 4 |\n`
  assert.deepEqual(summarizeChange(MISALIGNED, grown), {
    changed: true,
    changedLines: 1,
    totalLines: 4,
  })
})

test('displayPath prefers a path relative to the session directory', () => {
  const inside = join(scratch, 'docs', 'a.md')
  assert.equal(displayPath(inside, scratch), 'docs/a.md')
  assert.equal(displayPath(inside, join(scratch, 'elsewhere')), inside)
  assert.equal(displayPath(inside, undefined), inside)
})

test('formatReport is one line of counts: no file body, no table, no diff', async () => {
  const changed = { file: join(scratch, 'a.md'), changed: true, changedLines: 3, totalLines: 3 }
  const failed = { file: join(scratch, 'b.md'), changed: false, changedLines: 0, totalLines: 0, error: 'exit 2' }
  const same = { file: join(scratch, 'c.md'), changed: false, changedLines: 0, totalLines: 4 }

  const report = formatReport([changed], { cwd: scratch })
  assert.equal(report, '[md-fix-tables] realigned a.md, 3/3 lines changed')
  assert.equal(report.split('\n').length, 1)

  const failures = formatReport([failed], { cwd: scratch })
  assert.equal(failures, '[md-fix-tables] fixer failed: b.md (exit 2)')

  const mixed = formatReport([changed, failed], { cwd: scratch })
  assert.equal(mixed, '[md-fix-tables] realigned a.md, 3/3 lines changed; fixer failed: b.md (exit 2)')

  const many = formatReport(
    [changed, { file: join(scratch, 'd.md'), changed: true, changedLines: 1, totalLines: 9 }],
    { cwd: scratch },
  )
  assert.equal(many, '[md-fix-tables] realigned 2 files: a.md 3/3, d.md 1/9')

  // a call that changed nothing (or a file that was already aligned) costs zero tokens
  assert.equal(formatReport([same], { cwd: scratch }), undefined)
  assert.equal(formatReport([], { cwd: scratch }), undefined)
  assert.equal(formatReport([{ ...same, skipped: 'too large' }], { cwd: scratch }), undefined)
  assert.match(formatReport([same], { cwd: scratch, includeUnchanged: true }), /already aligned: c\.md/)

  const truncated = formatReport([changed], { cwd: scratch, maxChars: 40 })
  assert.ok(truncated.length <= 40)
  assert.ok(truncated.endsWith('…'))

  // the guarantee the context budget rests on: the file's own text never reaches the report
  const file = join(scratch, 'table.md')
  writeFileSync(file, MISALIGNED)
  const real = await fixMarkdownFile(file, {
    fixer: resolveFixer({}),
    timeoutMs: 20000,
    maxFileBytes: 1024 * 1024,
  })
  const realReport = formatReport([real], { cwd: scratch })
  assert.ok(!realReport.includes('|'), 'no table pipes')
  assert.ok(!realReport.includes('bbbb'), 'no cell text')
  assert.ok(!realReport.includes('\n'), 'single line')
})

test('appendReport appends to the model-facing content and never replaces it', () => {
  const result = { isError: false, content: [{ type: 'text', text: 'Wrote file' }] }
  const report = '[md-fix-tables] realigned 1 Markdown file'

  const appended = appendReport({ kind: 'accept' }, result, report)
  assert.equal(appended.kind, 'accept')
  assert.deepEqual(appended.content, [...result.content, { type: 'text', text: report }])

  const kept = appendReport(
    { kind: 'accept', content: [{ type: 'text', text: 'replaced by another plugin' }] },
    result,
    report,
  )
  assert.equal(kept.content[0].text, 'replaced by another plugin')
  assert.equal(kept.content.length, 2)

  const block = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(appendReport(block, result, report), block)
  const value = { kind: 'accept', value: { ok: true } }
  assert.equal(appendReport(value, result, report), value)
  assert.equal(appendReport({ kind: 'accept' }, result, undefined).content, undefined)
})

test('resolveFixer prefers an explicit command, then the bundled dependency', () => {
  assert.deepEqual(resolveFixer({ command: 'my-fixer', commandArgs: ['--check'] }), {
    command: 'my-fixer',
    args: ['--check'],
  })
  const bundled = resolveFixer({})
  assert.equal(bundled.command, process.execPath)
  assert.equal(bundled.args.length, 1)
  assert.match(bundled.args[0].replaceAll('\\', '/'), /@hrg\/md-fix-tables\/.*md-fix-tables\.js$/)
})

test('fixMarkdownFile realigns a real file in place', async () => {
  const file = join(scratch, 'realign.md')
  writeFileSync(file, MISALIGNED)
  const result = await fixMarkdownFile(file, {
    fixer: resolveFixer({}),
    timeoutMs: 20000,
    maxFileBytes: 1024 * 1024,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.changed, true)
  assert.equal(result.changedLines, 3)
  assert.match(readFileSync(file, 'utf8'), /\| a   \| bbbb \|/)
})

test('fixMarkdownFile reports a missing file as skipped, an unknown command as an error', async () => {
  const missing = await fixMarkdownFile(join(scratch, 'nope.md'), {
    fixer: resolveFixer({}),
    timeoutMs: 5000,
    maxFileBytes: 1024,
  })
  assert.equal(missing.skipped, 'missing, not a file, or too large')
  assert.equal(missing.changed, false)

  const file = join(scratch, 'broken.md')
  writeFileSync(file, MISALIGNED)
  const failed = await fixMarkdownFile(file, {
    fixer: { command: 'definitely-not-a-real-command-xyz', args: [] },
    timeoutMs: 5000,
    maxFileBytes: 1024,
  })
  assert.ok(failed.error)
  assert.equal(failed.changed, false)
})

test('runFixer reports a timeout instead of hanging', async () => {
  const run = await runFixer(
    { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
    'ignored.md',
    200,
  )
  assert.equal(run.timedOut, true)
  assert.notEqual(run.code, 0)
})

test('createFileQueue serializes work per key', async () => {
  const queue = createFileQueue()
  const order = []
  const slow = queue('same', async () => {
    order.push('first:start')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
    order.push('first:end')
  })
  const fast = queue('same', async () => {
    order.push('second')
  })
  await Promise.all([slow, fast])
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})
