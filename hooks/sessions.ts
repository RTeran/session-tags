import type { SessionActivity, SessionRecord, SessionStatus, TranscriptMeta } from '../types'

const TITLE_LENGTH = 80
const OPEN_MS = 150_000

export const STATUSES: ReadonlyArray<{ status: SessionStatus; label: string; color: string }> = [
  { status: 'active', label: 'in progress', color: 'success' },
  { status: 'waiting', label: 'waiting', color: 'warning' },
  { status: 'blocked', label: 'blocked', color: 'error' },
  { status: 'done', label: 'done', color: 'inactive' },
]

export type SessionFilter = {
  query: string
  tags: readonly string[]
  statuses: readonly SessionStatus[]
  showDone: boolean
}

export function emptyRecord(id: string, root: string, now: number): SessionRecord {
  return {
    id,
    root,
    repo: null,
    title: '',
    comment: '',
    tags: [],
    status: null,
    startedAt: now,
    lastActive: now,
    aliveAt: 0,
  }
}

export function parseTags(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .map(tag => tag.replace(/^#+/, '').trim().toLowerCase())
    .filter(tag => tag.length > 0)

  return [...new Set(tags)]
}

export function addTags(current: readonly string[], text: string): string[] {
  return [...new Set([...current, ...parseTags(text)])]
}

export function removeTags(current: readonly string[], text: string): string[] {
  const removed = new Set(parseTags(text))

  return current.filter(tag => !removed.has(tag))
}

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()

  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}

export function parseStatus(text: string): SessionStatus | null | undefined {
  const wanted = fold(text.trim())
  if (wanted === '' || wanted === 'none') {
    return null
  }
  const found = STATUSES.find(
    ({ status, label }) => status === wanted || label === wanted || label.replace(' ', '-') === wanted,
  )

  return found?.status
}

export function statusLabel(status: SessionStatus | null): string {
  return STATUSES.find(one => one.status === status)?.label ?? ''
}

export function isOpen(record: SessionRecord, now: number): boolean {
  return now - record.aliveAt < OPEN_MS
}

export function matches(record: SessionRecord, filter: SessionFilter, title = record.title): boolean {
  const hasTag = filter.tags.length === 0 || filter.tags.some(tag => record.tags.includes(tag))
  const hasStatus =
    filter.statuses.length > 0
      ? record.status !== null && filter.statuses.includes(record.status)
      : filter.showDone || record.status !== 'done'
  if (!hasTag || !hasStatus) {
    return false
  }

  const searched = fold(`${record.comment}\n${title}`)

  return fold(filter.query)
    .split(/\s+/)
    .filter(word => word.length > 0)
    .every(word => searched.includes(word))
}

export function filterSessions(
  records: readonly SessionRecord[],
  filter: SessionFilter,
  titleOf: (record: SessionRecord) => string = record => record.title,
): SessionRecord[] {
  return records
    .filter(record => matches(record, filter, titleOf(record)))
    .sort((a, b) => b.lastActive - a.lastActive)
}

export function statusCounts(records: readonly SessionRecord[]): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = { active: 0, waiting: 0, blocked: 0, done: 0 }
  for (const record of records) {
    if (record.status !== null) {
      counts[record.status] += 1
    }
  }

  return counts
}

export function mergeSessions(
  records: readonly SessionRecord[],
  metaById: Readonly<Record<string, TranscriptMeta>>,
): SessionRecord[] {
  const byId = new Map(records.map(record => [record.id, record]))
  const merged: SessionRecord[] = []
  for (const [id, meta] of Object.entries(metaById)) {
    const modified = meta.modified === null ? 0 : Date.parse(meta.modified)
    const record = byId.get(id)
    byId.delete(id)
    if (record !== undefined) {
      merged.push({ ...record, lastActive: Math.max(record.lastActive, modified) })
    } else if (
      (meta.customTitle || meta.aiTitle || meta.firstPrompt) &&
      !meta.entrypoint?.startsWith('sdk-')
    ) {
      merged.push({ ...emptyRecord(id, meta.cwd ?? '', modified), startedAt: modified })
    }
  }

  return [...merged, ...byId.values()]
}

export function tagCounts(records: readonly SessionRecord[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const record of records) {
    for (const tag of record.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export function toggleTag(selected: readonly string[], tag: string): string[] {
  return selected.includes(tag) ? selected.filter(one => one !== tag) : [...selected, tag]
}

export function resumeCommand(record: SessionRecord): string {
  const root = record.root.replace(/'/g, `'\\''`)

  return `cd '${root}' && claude --resume ${record.id}`
}

export function parseRecord(text: string): SessionRecord | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const record = value as Partial<SessionRecord>
    if (typeof record.id !== 'string' || typeof record.root !== 'string') {
      return null
    }

    return {
      id: record.id,
      root: record.root,
      repo: typeof record.repo === 'string' ? record.repo : null,
      title: typeof record.title === 'string' ? record.title : '',
      comment: typeof record.comment === 'string' ? record.comment : '',
      tags: Array.isArray(record.tags) ? record.tags.filter(tag => typeof tag === 'string') : [],
      status: STATUSES.some(({ status }) => status === record.status) ? (record.status ?? null) : null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      lastActive: typeof record.lastActive === 'number' ? record.lastActive : 0,
      aliveAt: typeof record.aliveAt === 'number' ? record.aliveAt : 0,
    }
  } catch {
    return null
  }
}

export function parseActivity(text: string): SessionActivity | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const activity = value as Partial<SessionActivity>

    return {
      title: typeof activity.title === 'string' ? activity.title : '',
      lastActive: typeof activity.lastActive === 'number' ? activity.lastActive : 0,
      aliveAt: typeof activity.aliveAt === 'number' ? activity.aliveAt : 0,
    }
  } catch {
    return null
  }
}

export function activityOf(record: SessionRecord): SessionActivity {
  return { title: record.title, lastActive: record.lastActive, aliveAt: record.aliveAt }
}

export function withActivity(
  record: SessionRecord,
  activity: SessionActivity | null | undefined,
): SessionRecord {
  if (!activity) {
    return record
  }

  return {
    ...record,
    title: activity.title || record.title,
    lastActive: Math.max(record.lastActive, activity.lastActive),
    aliveAt: Math.max(record.aliveAt, activity.aliveAt),
  }
}

export function relativeTime(then: number, now: number): string {
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`

  return `${Math.round(hours / 24)}d`
}

export function suggestTags(
  records: readonly SessionRecord[],
  exclude: readonly string[],
  prefix: string,
  limit = 8,
): Array<{ tag: string; count: number }> {
  const wanted = fold(prefix.replace(/^#+/, ''))

  return tagCounts(records)
    .filter(({ tag }) => !exclude.includes(tag) && fold(tag).startsWith(wanted))
    .slice(0, limit)
}

export function partialTag(draft: string): string {
  return /[\s,]$/.test(draft) ? '' : (draft.split(/[\s,]+/).pop() ?? '')
}

export function completeDraft(draft: string, tag: string): string {
  return `${draft.slice(0, draft.length - partialTag(draft).length)}${tag} `
}

export function draftTags(draft: string): string[] {
  return parseTags(draft.slice(0, draft.length - partialTag(draft).length))
}

const TAG_COMMAND = /^\s*\/(session-tag|session-untag)\s/

export function commandTagCompletions(
  records: readonly SessionRecord[],
  ownTags: readonly string[],
  text: string,
  start: number,
  token: string,
): Array<{ tag: string; count: number }> {
  const command = TAG_COMMAND.exec(text)
  if (command === null || start < command[0].length) {
    return []
  }
  const typed = parseTags(text.slice(command[0].length, start))
  if (command[1] === 'session-untag') {
    const wanted = fold(token.replace(/^#+/, ''))

    return ownTags
      .filter(tag => !typed.includes(tag) && fold(tag).startsWith(wanted))
      .map(tag => ({ tag, count: records.filter(record => record.tags.includes(tag)).length }))
  }

  return suggestTags(records, [...ownTags, ...typed], token)
}

export function resumeTitle(record: SessionRecord, meta: TranscriptMeta | undefined): string {
  return meta?.customTitle ?? meta?.aiTitle ?? (meta?.firstPrompt || record.title || record.id)
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

export function shortAgo(then: number, now: number): string {
  const seconds = Math.round((then - now) / 1000)
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1]
  const value = Math.round(seconds / size)
  try {
    return new Intl.RelativeTimeFormat('en', { style: 'short', numeric: 'always' }).format(value, unit)
  } catch {
    return `${relativeTime(then, now)} ago`
  }
}

export function resumeMeta(record: SessionRecord, meta: TranscriptMeta | undefined, now: number): string {
  if (meta === undefined) {
    return `${shortAgo(record.lastActive, now)} · transcript not found`
  }
  const modified = meta.modified === null ? record.lastActive : Date.parse(meta.modified)
  const parts = [
    shortAgo(modified, now),
    ...(meta.sessionKind === 'bg' ? ['bg'] : []),
    ...(meta.gitBranch ? [meta.gitBranch] : []),
    `${meta.messageCount} messages`,
  ]
  if (meta.prNumber !== null) {
    parts.push(meta.prRepository ? `${meta.prRepository}#${meta.prNumber}` : `#${meta.prNumber}`)
  }

  return parts.join(' · ')
}
