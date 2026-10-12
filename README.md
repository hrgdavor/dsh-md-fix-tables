# @hrg/dsh-md-fix-tables

A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) bundle that keeps the Markdown
pipe tables an agent writes aligned — and tells the agent what it changed.

Every time the `write` or `edit` tool touches a Markdown file, this plugin runs the
[`md-fix-tables`](https://www.npmjs.com/package/@hrg/md-fix-tables) CLI on that file **in place** (pad
every cell to one grid, rebuild the separator row, close rows that never ended) and appends **one line
of counts** to the tool result, so the model knows the file on disk is the aligned one without any of
the Markdown coming back into the conversation.

```
[md-fix-tables] realigned docs/design.md, 12/84 lines changed
```

Nothing else about the tool call changes: the plugin only adds that single text block to the
model-facing content, and it adds nothing at all when no table changed. A denied, failing or
non-Markdown call is left untouched.

## Context cost

The whole point of the report is to be cheaper than the alternative (a model re-reading a file to
check its tables), so it is bounded on every axis:

| what                                                             | cost                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a call that changed no table, or a file that was already aligned | **nothing** — no text block is added                                                |
| a call that realigned files                                      | **one ASCII line**: paths and line counts, capped by `maxReportChars` (default 400) |
| the Markdown itself                                              | **never** — the report is built from paths and counts only; there is no diff, no table and no file body in it (asserted by the test suite) |
| the prompt                                                       | **one short sentence** (`PROMPT_SECTION`, ~35 words) in the prompt prefix, so the model knows tables are aligned for it and a result note is not a file to re-read; `prompt: false` removes it |
| wanting total silence                                            | `report: never` fixes the file without adding any text                              |

```
[md-fix-tables] realigned 2 files: docs/a.md 12/84, docs/b.md 3/18
[md-fix-tables] fixer failed: docs/c.md (exit code 2)
```

## The prompt note

The note is a **system-prompt section** registered by this plugin itself, not a session message and not
something the profile has to declare. `apply()` reaches the `systemPrompt` service the way the shipped
`dsh-web-app` registers its web-surface note — `ctx.inject(['systemPrompt'], promptCtx =>
promptCtx.systemPrompt.section({ name, order, text }))` — with the injected property and
`ctx.get('systemPrompt')` as guarded fallbacks.

Because the bundle is mounted at profile scope, every session of that profile — including sessions
created from an agent preset — carries the sentence from its first request, and it disappears again
when the plugin unloads. `order: 1350` puts it next to the `edit` tool's own guidance (1300).

There is nothing to configure: installing the bundle is all it takes, and `prompt: false` opts out.

### Verifying it

- `dsh --profile web --dump-config` prints the composed rows (this plugin's row), but it does not render
  the assembled prompt.
- In a fresh session, ask the model to quote the sentence about Markdown tables from its system prompt.
  If it can, the note is live.
- The behaviour is visible as well: the tool-result note is the one-line `[md-fix-tables] realigned …`
  form. A Host keeps the module generation it loaded, so a freshly added or edited plugin needs a
  restart before either signal appears.

## Install

Into the profile you use (here: `web`), from your terminal:

```sh
dsh plugin --profile web add @hrg/dsh-md-fix-tables
```

Then make the package a bundle of that profile: add its name to `dsh.profile.bundles` in
`$DSH_HOME/profiles/web/package.json`.

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@hrg/dsh-md-fix-tables"]
    }
  }
}
```

The Plugin Manager page does both steps for you when it is enabled for the session
(`install_bundle` with this package's directory). Changes to the bundle list need a Host restart when
the new bundle is not picked up live.

Local development install — point the profile at your checkout instead of the registry:

```sh
dsh plugin --profile web add D:\wrk\ai\dsh-md-fix-tables
```

A profile-installed package is loaded once: after editing this plugin's own source, restart the Host to
load a fresh module generation (the first one keeps running until then).

## Configuration

Defaults are set in this bundle's `cordis.patch.yml`; override them from your profile's
`cordis.patch.yml`, which is applied last. A matching override replaces the whole `config`, so restate
every field you want to keep.

```yaml
- id: md-fix-tables
  config:
    report: always
    extensions: ['.md', '.markdown']
```

| option           | type                             | default                | meaning                                                                                         |
| ---------------- | -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `enabled`        | `boolean`                        | `true`                 | `false` disables the plugin entirely                                                            |
| `tools`          | `string[]`                       | `['write', 'edit']`    | tool names whose calls are inspected                                                            |
| `extensions`     | `string[]`                       | `['.md', '.markdown']` | file extensions treated as Markdown                                                             |
| `command`        | `string`                         | –                      | explicit fixer executable; when unset the bundled `@hrg/md-fix-tables` CLI is used, then `PATH` |
| `commandArgs`    | `string[]`                       | `[]`                   | extra arguments passed before the file path                                                     |
| `timeoutMs`      | `number`                         | `15000`                | kill the fixer after this long                                                                  |
| `report`         | `changed` \| `always` \| `never` | `changed`              | `always` also names files that were already aligned, `never` fixes silently                     |
| `prompt`         | `boolean`                        | `true`                 | register the one-sentence prompt note (a profile-wide system-prompt section, order 1350); `false` leaves the prompt untouched |
| `maxReportChars` | `number`                         | `400`                  | hard cap on the appended line                                                                   |
| `maxFileBytes`   | `number`                         | `2097152` (2 MiB)      | bigger files are left alone                                                                     |
| `cwd`            | `string`                         | session working dir    | base directory for relative paths in tool arguments                                             |

## Behaviour and limits

- **Which paths.** Only the documented path-bearing argument keys of the tool call are read
  (`file_path`, `path`, `file`, `files`, `paths`, `target`); a Markdown document passed as `content`
  is never mistaken for a path. Relative paths resolve against the session directory first, then the
  process working directory.
- **Which tools.** Only `write` and `edit` by default. Markdown changed by a shell command
  (`pwsh`, `bash`) or by an editor outside the Harness is not seen; add another tool name to `tools`
  if a plugin of yours writes Markdown through its own tool.
- **Serialized per file.** Two overlapping calls that touch the same document cannot interleave their
  read/rewrite pairs.
- **Failures stay in the conversation, not in the way.** A missing binary, a timeout or a bad file is
  reported once as text and never thrown into the tool pipeline; the warning is logged once per
  session, not once per file.
- **Requires** a Harness profile with the `tools` service (every standard profile) and a JavaScript
  runtime — Node.js 20+ or [Bun](https://bun.sh) 1.1+. `@hrg/md-fix-tables` is installed as a
  dependency of this package.

## Development

```sh
bun install
bun test        # helpers, the decision merge, a real end-to-end fix and a timeout
```

The suite is written against `node:test` and `node:assert/strict`, so Bun runs the same 22 tests
without a test-runner swap — and `bun run test:node` runs them on Node instead.

The plugin is plain ESM with no build step:

- `src/index.js` — the Cordis plugin (`apply`, `Config`, `inject`);
- `src/fix.js` — path collection, the before/after summary, the report text, the fixer runner and the
  per-file queue, all free of Harness imports so they can be unit-tested;
- `cordis.patch.yml` — the bundle layer that inserts the plugin row;
- `locale/*.json`, `icon.svg` — the Plugin Manager display metadata.

## License

MIT — see [LICENSE](LICENSE).
