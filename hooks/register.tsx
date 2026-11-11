import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionRecord, TranscriptMeta } from '../types'
import {
  STATUSES,
  addTags,
  commandTagCompletions,
  completeDraft,
  draftTags,
  emptyRecord,
  filterSessions,
  isOpen,
  mergeSessions,
  activityOf,
  parseActivity,
  parseRecord,
  parseStatus,
  parseTags,
  partialTag,
  removeTags,
  resumeCommand,
  resumeMeta,
  resumeTitle,
  statusCounts,
  statusLabel,
  suggestTags,
  tagCounts,
  titleFromPrompt,
  toggleTag,
  withActivity,
} from './sessions'

const PANE = 'session-tags'
const POLL_MS = 4000
const STALE_MS = 10_000
const HEARTBEAT_MS = 60_000

const sessions = atom({ plugin: 'session-tags', key: 'sessions' } as const, [])
const currentId = atom({ plugin: 'session-tags', key: 'currentId' } as const, '')
const query = atom({ plugin: 'session-tags', key: 'query' } as const, '')
const selectedTags = atom({ plugin: 'session-tags', key: 'selectedTags' } as const, [])
const tagDraft = atom({ plugin: 'session-tags', key: 'tagDraft' } as const, null)
const meta = atom({ plugin: 'session-tags', key: 'meta' } as const, {})
const selectedStatuses = atom({ plugin: 'session-tags', key: 'selectedStatuses' } as const, [])
const showDone = atom({ plugin: 'session-tags', key: 'showDone' } as const, false)
const editingId = atom({ plugin: 'session-tags', key: 'editingId' } as const, '')

async function dataDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')

  return `${home}/.claude/session-tags`
}

async function recordPath($: EngineInterface, id: string): Promise<string> {
  return `${await dataDir($)}/${id}.json`
}

async function activityPath($: EngineInterface, id: string): Promise<string> {
  return `${await dataDir($)}/activity/${id}.json`
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    return null
  }
}

async function readJsonFiles($: EngineInterface, dir: string): Promise<Array<[string, string]>> {
  if (!(await $.fs.exists(dir))) {
    return []
  }
  const entries = await $.fs.list(dir)
  const files = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
  const texts = await Promise.all(
    files.map(async entry => [
      entry.name.slice(0, -'.json'.length),
      await readText($, `${dir}/${entry.name}`),
    ]),
  )

  return texts.filter((pair): pair is [string, string] => pair[1] !== null)
}

async function loadAll($: EngineInterface): Promise<SessionRecord[]> {
  const dir = await dataDir($)
  const notes = await readJsonFiles($, dir)
  const activity = new Map(
    (await readJsonFiles($, `${dir}/activity`)).map(([id, text]) => [id, parseActivity(text)]),
  )

  return notes
    .map(([id, text]) => {
      const record = parseRecord(text)

      return record === null ? null : withActivity(record, activity.get(id))
    })
    .filter((record): record is SessionRecord => record !== null)
}

async function loadMeta($: EngineInterface): Promise<Record<string, TranscriptMeta> | null> {
  const script = `${$.plugin.root}/bin/transcript-meta.py`
  const cache = `${await dataDir($)}/.cache/transcript-meta.json`
  try {
    const ran = await $.process.run(['python3', '-I', script, cache])
    if (ran.exitCode !== 0) {
      $.ui.log(`session-tags: transcript-meta failed: ${ran.stderr.slice(0, 300)}`, { to: 'debug' })
      return null
    }

    return JSON.parse(ran.stdout) as Record<string, TranscriptMeta>
  } catch (error) {
    $.ui.log(`session-tags: transcript-meta failed: ${String(error)}`, { to: 'debug' })
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const list = await loadAll($)
  refreshedAt = await $.clock.now()
  await update($, sessions, () => list)
}

let isRefreshing = false

async function refreshWithMeta($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    await refresh($)
    const loaded = await loadMeta($)
    if (loaded !== null) {
      await update($, meta, () => loaded)
    }
  } finally {
    isRefreshing = false
  }
}

let writes: Promise<unknown> = Promise.resolve()

function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work)
  writes = run.catch(() => undefined)

  return run
}

async function editRecord(
  $: EngineInterface,
  id: string,
  root: string,
  edit: (record: SessionRecord) => SessionRecord,
): Promise<SessionRecord> {
  return queued(async () => {
    const path = await recordPath($, id)
    const text = await readText($, path)
    const existing = text === null ? null : parseRecord(text)
    const record = edit(existing ?? emptyRecord(id, root, await $.clock.now()))
    await $.fs.write(path, JSON.stringify(record, null, 2))
    let merged = record
    await update($, sessions, list => {
      const before = list.find(one => one.id === id)
      merged = before ? withActivity(record, activityOf(before)) : record

      return [...list.filter(one => one.id !== id), merged]
    })

    return merged
  })
}

async function editOwn(
  $: EngineInterface,
  edit: (record: SessionRecord) => SessionRecord,
): Promise<SessionRecord> {
  return editRecord($, await $.session.id(), await $.session.root(), edit)
}

async function touchActivity($: EngineInterface, prompt: string, isPrompt: boolean): Promise<void> {
  try {
    await queued(async () => {
      const id = await $.session.id()
      const path = await activityPath($, id)
      const text = await readText($, path)
      const current = (text === null ? null : parseActivity(text)) ?? { title: '', lastActive: 0, aliveAt: 0 }
      const now = await $.clock.now()
      const next = {
        title: current.title === '' && prompt !== '' ? titleFromPrompt(prompt) : current.title,
        lastActive: isPrompt ? now : current.lastActive,
        aliveAt: now,
      }
      await $.fs.write(path, JSON.stringify(next, null, 2))
      await update($, sessions, list => list.map(one => (one.id === id ? withActivity(one, next) : one)))
    })
  } catch (error) {
    $.ui.log(`session-tags: could not update this session: ${String(error)}`, { to: 'debug' })
  }
}

function describeStatus(record: SessionRecord): string {
  return record.status === null ? '' : `[${statusLabel(record.status)}] `
}

function describeTags(tags: readonly string[]): string {
  return tags.length === 0 ? 'no tags' : tags.map(tag => `#${tag}`).join(' ')
}

let poller: Timer | undefined
let heartbeat: Timer | undefined
let isTracked = false
let refreshedAt = 0

async function openPane($: EngineInterface) {
  await refresh($)
  const opened = await $.ui.open({ id: PANE, title: 'Sessions', focus: true })
  void refreshWithMeta($)
  poller ??= $.clock.every(POLL_MS, () => {
    void refreshWithMeta($)
  })

  return opened
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-note',
      description: 'Set the comment of this session (empty clears it)',
      argumentHint: '[comment]',
    })
    await $.command.register({
      name: 'session-tag',
      description: 'Add tags to this session',
      argumentHint: '<tag> [tag...]',
    })
    await $.command.register({
      name: 'session-untag',
      description: 'Remove tags from this session',
      argumentHint: '<tag> [tag...]',
    })
    await $.command.register({
      name: 'session-status',
      description: 'Set the status of this session: in-progress, waiting, blocked, done or none',
      argumentHint: '<status>',
    })
    await $.command.register({
      name: 'sessions',
      description: 'List sessions: filter by status and tag, search titles and comments',
    })

    isTracked = e.isInteractive
    if (!isTracked) {
      return next(e)
    }

    try {
      const repo = await $.session.repo()
      const root = await $.session.root()
      const record = await editOwn($, own => ({ ...own, root, repo: repo?.name ?? own.repo }))
      await update($, currentId, () => record.id)
      await touchActivity($, '', true)
      await refresh($)
      heartbeat?.cancel()
      heartbeat = $.clock.every(HEARTBEAT_MS, () => {
        void touchActivity($, '', false).then(() => refresh($))
      })
    } catch (error) {
      $.ui.log(`session-tags: could not save this session: ${String(error)}`)
    }

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (isTracked) {
      const isCommand = e.text.trimStart().startsWith('/')
      $.clock.after(0, () => {
        void touchActivity($, isCommand ? '' : e.text, true)
      })
    }

    return next(e)
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const result = await next(e)
    if (!isTracked) {
      return result
    }
    const statusCommand = /^\s*\/session-status\s+$/.exec(e.text.slice(0, e.start))
    if (statusCommand !== null) {
      const wanted = e.token.toLowerCase()
      const rows = [...STATUSES.map(({ label }) => label.replace(' ', '-')), 'none']
        .filter(name => name.startsWith(wanted))
        .map(name => ({ text: name }))

      return { suggestions: [...result.suggestions, ...rows] }
    }
    if (!/^\s*\/session-(un)?tag\s/.test(e.text)) {
      return result
    }
    if ((await $.clock.now()) - refreshedAt > STALE_MS) {
      await refresh($)
    }
    const all = await read($, sessions)
    const ownId = await read($, currentId)
    const ownTags = all.find(record => record.id === ownId)?.tags ?? []
    const rows = commandTagCompletions(all, ownTags, e.text, e.start, e.token).map(({ tag, count }) => ({
      text: tag,
      label: `#${tag}`,
      description: `${count} session${count === 1 ? '' : 's'}`,
    }))

    return { suggestions: [...result.suggestions, ...rows] }
  })

  on('command.run', { command: 'session-note' }, async ($, e) => {
    const comment = e.args.trim()
    await editOwn($, own => ({ ...own, comment }))

    return { text: comment === '' ? 'Session comment cleared.' : `Session comment: ${comment}` }
  })

  on('command.run', { command: 'session-tag' }, async ($, e) => {
    if (parseTags(e.args).length === 0) {
      return { text: 'Usage: /session-tag <tag> [tag...]' }
    }
    const record = await editOwn($, own => ({ ...own, tags: addTags(own.tags, e.args) }))

    return { text: `Session tags: ${describeTags(record.tags)}` }
  })

  on('command.run', { command: 'session-untag' }, async ($, e) => {
    const record = await editOwn($, own => ({ ...own, tags: removeTags(own.tags, e.args) }))

    return { text: `Session tags: ${describeTags(record.tags)}` }
  })

  on('command.run', { command: 'session-status' }, async ($, e) => {
    const status = parseStatus(e.args)
    if (status === undefined) {
      return { text: 'Usage: /session-status in-progress | waiting | blocked | done | none' }
    }
    await editOwn($, own => ({ ...own, status }))

    return { text: status === null ? 'Session status cleared.' : `Session status: ${statusLabel(status)}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ownId = await read($, currentId)
    if (e.props.hasSurvey || ownId === '') {
      return next(e)
    }
    const own = (await read($, sessions)).find(record => record.id === ownId)
    if (own === undefined || (own.status === null && own.tags.length === 0 && own.comment === '')) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const color = STATUSES.find(one => one.status === own.status)?.color

    return (
      <Box>
        <Text wrap="truncate-end">
          {own.status !== null && <Text color={color}>● {statusLabel(own.status)} </Text>}
          {own.tags.length > 0 && <Text dimColor>{describeTags(own.tags)} </Text>}
          {own.comment !== '' && <Text dimColor>· {own.comment}</Text>}
        </Text>
      </Box>
    )
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Sessions pane opened.' : 'Sessions pane waits for a wider terminal.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      poller?.cancel()
      poller = undefined
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const metaById = await read($, meta)
    const all = mergeSessions(await read($, sessions), metaById)
    const ownId = await read($, currentId)
    const text = await read($, query)
    const selected = await read($, selectedTags)
    const statuses = await read($, selectedStatuses)
    const isDoneShown = await read($, showDone)
    const draft = await read($, tagDraft)
    const editing = await read($, editingId)
    const now = await $.clock.now()

    const own = all.find(record => record.id === (editing || ownId))
    const isOwn = own === undefined || own.id === ownId
    const editTarget = (edit: (record: SessionRecord) => SessionRecord) =>
      own === undefined || isOwn ? editOwn($, edit) : editRecord($, own.id, own.root, edit)
    const startEditing = (id: string) => {
      void update($, editingId, () => (id === ownId ? '' : id))
      void update($, tagDraft, () => null)
    }
    const tags = tagCounts(all)
    const counts = statusCounts(all)
    const shown = filterSessions(
      all,
      { query: text, tags: selected, statuses, showDone: isDoneShown },
      record => resumeTitle(record, metaById[record.id]),
    )
    const draftText = draft ?? (own?.tags ?? []).join(' ')
    const suggestions = suggestTags(
      all,
      draft === null ? (own?.tags ?? []) : draftTags(draft),
      draft === null ? '' : partialTag(draft),
    )
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 12) / 4))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box columnGap={1}>
            <Text bold wrap="truncate-end">
              {isOwn ? 'This session' : 'Editing'}
              {own ? `: ${resumeTitle(own, metaById[own.id])}` : ''}
            </Text>
            {!isOwn && (
              <Button key="edit-own" label="back to this session" plain onPress={() => startEditing(ownId)} />
            )}
          </Box>
          <Box flexWrap="wrap" columnGap={1}>
            <Text dimColor>Status </Text>
            {STATUSES.map(({ status, label }) => (
              <Button
                key={`set-status:${status}`}
                label={label}
                variant={own?.status === status ? 'primary' : 'secondary'}
                onPress={() => {
                  void editTarget(record => ({ ...record, status: record.status === status ? null : status }))
                }}
              />
            ))}
          </Box>
          {Input === undefined && (
            <Text dimColor>
              {own ? describeStatus(own) : ''}
              {describeTags(own?.tags ?? [])}
              {own?.comment ? ` · ${own.comment}` : ''}
            </Text>
          )}
          {Input && (
            <Input
              key="comment"
              label="Comment "
              placeholder="what is this session about"
              value={own?.comment ?? ''}
              submitLabel="save"
              onSubmit={value => {
                void editTarget(record => ({ ...record, comment: value.trim() }))
              }}
            />
          )}
          {Input && (
            <Input
              key="tags"
              label="Tags    "
              placeholder="tag another-tag"
              value={draftText}
              submitLabel="save"
              onInput={value => {
                void update($, tagDraft, () => value)
              }}
              onSubmit={value => {
                void editTarget(record => ({ ...record, tags: parseTags(value) }))
                void update($, tagDraft, () => null)
              }}
            />
          )}
          {Input && (own?.tags.length ?? 0) > 0 && (
            <Box flexWrap="wrap" columnGap={1}>
              <Text dimColor>Remove</Text>
              {(own?.tags ?? []).map(tag => (
                <Button
                  key={`untag:${tag}`}
                  label={`#${tag} ×`}
                  plain
                  onPress={() => {
                    void editTarget(record => ({ ...record, tags: removeTags(record.tags, tag) }))
                    void update($, tagDraft, () => null)
                  }}
                />
              ))}
            </Box>
          )}
          {Input && suggestions.length > 0 && (
            <Box flexWrap="wrap" columnGap={1}>
              <Text dimColor>Suggested</Text>
              {suggestions.map(({ tag }) => (
                <Button
                  key={`suggest:${tag}`}
                  label={`+#${tag}`}
                  plain
                  onPress={() => {
                    void editTarget(record => ({ ...record, tags: parseTags(completeDraft(draftText, tag)) }))
                    void update($, tagDraft, () => null)
                  }}
                />
              ))}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          {Input && (
            <Input
              key="search"
              label="Search  "
              placeholder="words in titles and comments"
              value={text}
              autoFocus
              submitLabel="search"
              onInput={value => {
                void update($, query, () => value)
              }}
              onSubmit={value => {
                void update($, query, () => value)
              }}
            />
          )}
          <Box flexWrap="wrap" columnGap={1}>
            {STATUSES.map(({ status, label }) => (
              <Button
                key={`status:${status}`}
                label={`${label} ${counts[status]}`}
                variant={statuses.includes(status) ? 'primary' : 'secondary'}
                onPress={() => {
                  void update($, selectedStatuses, list =>
                    list.includes(status) ? list.filter(one => one !== status) : [...list, status],
                  )
                }}
              />
            ))}
            {statuses.length > 0 && (
              <Button
                key="clear-statuses"
                label="clear"
                plain
                onPress={() => {
                  void update($, selectedStatuses, () => [])
                }}
              />
            )}
            {statuses.length === 0 && counts.done > 0 && (
              <Button
                key="toggle-done"
                label={isDoneShown ? 'hide done' : `show done (${counts.done})`}
                plain
                onPress={() => {
                  void update($, showDone, value => !value)
                }}
              />
            )}
          </Box>
          <Box flexWrap="wrap" columnGap={1}>
            {tags.length === 0 && <Text dimColor>No tags yet.</Text>}
            {tags.map(({ tag, count }) => (
              <Button
                key={`tag:${tag}`}
                label={`#${tag} ${count}`}
                variant={selected.includes(tag) ? 'primary' : 'secondary'}
                onPress={() => {
                  void update($, selectedTags, list => toggleTag(list, tag))
                }}
              />
            ))}
            {selected.length > 0 && (
              <Button
                key="clear-tags"
                label="clear"
                plain
                onPress={() => {
                  void update($, selectedTags, () => [])
                }}
              />
            )}
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>
            {shown.length} of {all.length} sessions · ● open now · press a title to edit it
          </Text>
          {shown.slice(0, room).map(record => (
            <Box key={`row:${record.id}`} flexDirection="column">
              <Box>
                <Text color="success">{isOpen(record, now) ? '● ' : '  '}</Text>
                {record.status !== null && (
                  <Text color={STATUSES.find(one => one.status === record.status)?.color}>
                    [{statusLabel(record.status)}]{' '}
                  </Text>
                )}
                <Button
                  key={`session:${record.id}`}
                  plain
                  label={`${record.id === own?.id ? '▸ ' : ''}${resumeTitle(record, metaById[record.id])}${record.id === ownId ? ' (this one)' : ''}`}
                  onPress={() => startEditing(record.id)}
                />
                <Text> </Text>
                <Button
                  key={`copy:${record.id}`}
                  plain
                  dimColor
                  label="copy resume"
                  onPress={press => {
                    void $.ui.copy({ text: resumeCommand(record), surface: press.surface })
                    $.ui.toast(`Copied: claude --resume ${record.id}`)
                  }}
                />
              </Box>
              <Text dimColor wrap="truncate-end">
                {resumeMeta(record, metaById[record.id], now)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {describeTags(record.tags)}
                {record.comment ? ` · ${record.comment}` : ''}
              </Text>
            </Box>
          ))}
          {shown.length > room && <Text dimColor>…and {shown.length - room} more</Text>}
        </Box>
      </Box>
    )
  })
}
