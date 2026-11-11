import { describe, expect, test } from 'claude-code/testing'

import type { SessionRecord, SessionStatus, TranscriptMeta } from '../types'
import type { SessionFilter } from '../hooks/sessions'
import {
  activityOf,
  addTags,
  isOpen,
  mergeSessions,
  parseStatus,
  statusCounts,
  commandTagCompletions,
  completeDraft,
  draftTags,
  filterSessions,
  parseActivity,
  parseRecord,
  parseTags,
  partialTag,
  removeTags,
  resumeCommand,
  resumeMeta,
  resumeTitle,
  shortAgo,
  suggestTags,
  tagCounts,
  toggleTag,
  withActivity,
} from '../hooks/sessions'

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'id',
    root: '/repo',
    repo: null,
    title: '',
    comment: '',
    tags: [],
    status: null,
    startedAt: 0,
    lastActive: 0,
    aliveAt: 0,
    ...overrides,
  }
}

describe('tags', () => {
  test('are lowercased, stripped of # and deduplicated', async () => {
    expect(parseTags('#QA, qa  Webcam')).toEqual(['qa', 'webcam'])
  })

  test('are added without duplicates and removed by name', async () => {
    expect(addTags(['qa'], 'QA review')).toEqual(['qa', 'review'])
    expect(removeTags(['qa', 'review'], '#qa')).toEqual(['review'])
  })

  test('toggle in and out of the selection', async () => {
    expect(toggleTag(['qa'], 'review')).toEqual(['qa', 'review'])
    expect(toggleTag(['qa', 'review'], 'qa')).toEqual(['review'])
  })

  test('are counted across sessions, most used first', async () => {
    const counts = tagCounts([record({ tags: ['qa', 'pr'] }), record({ tags: ['qa'] })])
    expect(counts).toEqual([
      { tag: 'qa', count: 2 },
      { tag: 'pr', count: 1 },
    ])
  })
})

function by(
  query: string,
  tags: string[] = [],
  statuses: SessionStatus[] = [],
  showDone = false,
): SessionFilter {
  return { query, tags, statuses, showDone }
}

describe('filterSessions', () => {
  const qa = record({ id: 'a', tags: ['qa'], comment: 'Esperando la revisión', lastActive: 1 })
  const pr = record({ id: 'b', tags: ['pr'], comment: 'PR abierta', lastActive: 3 })
  const bare = record({ id: 'c', comment: '', lastActive: 2 })

  test('shows every session, most recent first, with no tag and no query', async () => {
    expect(filterSessions([qa, pr, bare], by('', [])).map(one => one.id)).toEqual(['b', 'c', 'a'])
  })

  test('keeps sessions with any of the selected tags', async () => {
    expect(filterSessions([qa, pr, bare], by('', ['qa', 'pr'])).map(one => one.id)).toEqual(['b', 'a'])
  })

  test('searches comments ignoring case and accents, every word required', async () => {
    expect(filterSessions([qa, pr, bare], by('REVISION', [])).map(one => one.id)).toEqual(['a'])
    expect(filterSessions([qa, pr, bare], by('pr abierta', [])).map(one => one.id)).toEqual(['b'])
    expect(filterSessions([qa, pr, bare], by('pr cerrada', []))).toEqual([])
  })

  test('searches titles too, a query may mix title and comment words', async () => {
    const titled = record({ id: 't', title: 'Captura de cámara', comment: 'lista', lastActive: 4 })
    expect(filterSessions([qa, titled], by('camara', [])).map(one => one.id)).toEqual(['t'])
    expect(filterSessions([qa, titled], by('camara lista', [])).map(one => one.id)).toEqual(['t'])
    expect(
      filterSessions([qa, titled], by('webcam', []), one =>
        one.id === 'a' ? 'Webcam replay' : one.title,
      ).map(one => one.id),
    ).toEqual(['a'])
  })

  test('combines the tag filter with the search', async () => {
    expect(filterSessions([qa, pr, bare], by('abierta', ['qa']))).toEqual([])
  })
})

describe('records', () => {
  test('a broken file reads as nothing', async () => {
    expect(parseRecord('{"id": "a", "root"')).toBeNull()
    expect(parseRecord('{"id": "a"}')).toBeNull()
  })

  test('a partial file gets defaults', async () => {
    expect(parseRecord('{"id": "a", "root": "/r", "tags": ["qa", 3]}')).toEqual(
      record({ id: 'a', root: '/r', tags: ['qa'] }),
    )
  })

  test('the resume command enters the session root first', async () => {
    expect(resumeCommand(record({ id: 'x1', root: "/it's here" }))).toBe(
      `cd '/it'\\''s here' && claude --resume x1`,
    )
  })
})

describe('tag suggestions', () => {
  const records = [
    record({ id: 'a', tags: ['qa', 'webcam'] }),
    record({ id: 'b', tags: ['qa', 'review'] }),
    record({ id: 'c', tags: ['webcam'] }),
  ]

  test('propose existing tags by prefix, most used first, skipping the excluded ones', async () => {
    expect(suggestTags(records, [], '').map(one => one.tag)).toEqual(['qa', 'webcam', 'review'])
    expect(suggestTags(records, ['qa'], '').map(one => one.tag)).toEqual(['webcam', 'review'])
    expect(suggestTags(records, [], '#W').map(one => one.tag)).toEqual(['webcam'])
    expect(suggestTags(records, [], 'nueva')).toEqual([])
  })

  test('the draft splits into finished tags and the word being typed', async () => {
    expect(partialTag('qa we')).toBe('we')
    expect(partialTag('qa ')).toBe('')
    expect(draftTags('qa we')).toEqual(['qa'])
    expect(completeDraft('qa we', 'webcam')).toBe('qa webcam ')
    expect(completeDraft('qa ', 'review')).toBe('qa review ')
  })

  test('/session-tag proposes tags this session lacks', async () => {
    const text = '/session-tag rev'
    expect(commandTagCompletions(records, ['qa'], text, 13, 'rev')).toEqual([{ tag: 'review', count: 1 }])
    expect(commandTagCompletions(records, ['qa'], '/session-tag webcam q', 20, 'q')).toEqual([])
  })

  test('/session-untag proposes only the tags this session has', async () => {
    expect(commandTagCompletions(records, ['qa', 'webcam'], '/session-untag w', 15, 'w')).toEqual([
      { tag: 'webcam', count: 2 },
    ])
  })

  test('other prompts and the command name itself get nothing', async () => {
    expect(commandTagCompletions(records, [], 'hola q', 5, 'q')).toEqual([])
    expect(commandTagCompletions(records, [], '/session-tag', 1, 'session-tag')).toEqual([])
  })
})

describe('the /resume row', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z')
  const meta: TranscriptMeta = {
    messageCount: 22,
    firstPrompt: 'los mods de claude',
    customTitle: null,
    aiTitle: 'Comentarios en sesiones',
    agentName: null,
    gitBranch: 'gitbutler/workspace',
    sessionKind: null,
    prNumber: null,
    prRepository: null,
    modified: '2026-10-08T11:55:00Z',
    fileSize: 1000,
    cwd: '/repo',
    entrypoint: 'cli',
  }

  test('the title is the custom title, then the AI title, then the first prompt', async () => {
    const one = record({ id: 'x', title: 'mine' })
    expect(resumeTitle(one, { ...meta, customTitle: 'renamed' })).toBe('renamed')
    expect(resumeTitle(one, meta)).toBe('Comentarios en sesiones')
    expect(resumeTitle(one, { ...meta, aiTitle: null })).toBe('los mods de claude')
    expect(resumeTitle(one, { ...meta, aiTitle: null, firstPrompt: '' })).toBe('mine')
    expect(resumeTitle(one, undefined)).toBe('mine')
  })

  test('the line reads age · branch · messages · PR, as /resume does', async () => {
    expect(resumeMeta(record({}), meta, NOW)).toBe('5 min. ago · gitbutler/workspace · 22 messages')
    expect(
      resumeMeta(
        record({}),
        { ...meta, sessionKind: 'bg', prNumber: 32537, prRepository: 'acme/web-app' },
        NOW,
      ),
    ).toBe('5 min. ago · bg · gitbutler/workspace · 22 messages · acme/web-app#32537')
  })

  test('a session without a transcript says so', async () => {
    expect(resumeMeta(record({ lastActive: NOW - 2 * 3600_000 }), undefined, NOW)).toBe(
      '2 hr. ago · transcript not found',
    )
  })

  test('ages pick the largest whole unit', async () => {
    expect(shortAgo(NOW - 3 * 24 * 3600_000, NOW)).toBe('3 days ago')
    expect(shortAgo(NOW - 10_000, NOW)).toBe('10 sec. ago')
  })
})

describe('status', () => {
  const NOW = 1_000_000_000
  const active = record({ id: 'a', status: 'active', lastActive: 3 })
  const done = record({ id: 'd', status: 'done', lastActive: 2 })
  const none = record({ id: 'n', lastActive: 1 })

  test('reads the names people type', async () => {
    expect(parseStatus('in-progress')).toBe('active')
    expect(parseStatus('In Progress')).toBe('active')
    expect(parseStatus('blocked')).toBe('blocked')
    expect(parseStatus('none')).toBeNull()
    expect(parseStatus('')).toBeNull()
    expect(parseStatus('later')).toBeUndefined()
  })

  test('done sessions hide unless shown or filtered for', async () => {
    const ids = (filter: SessionFilter) => filterSessions([active, done, none], filter).map(one => one.id)
    expect(ids(by(''))).toEqual(['a', 'n'])
    expect(ids(by('', [], [], true))).toEqual(['a', 'd', 'n'])
    expect(ids(by('', [], ['done']))).toEqual(['d'])
    expect(ids(by('', [], ['active', 'done']))).toEqual(['a', 'd'])
  })

  test('are counted per status', async () => {
    expect(statusCounts([active, done, none, done])).toEqual({ active: 1, waiting: 0, blocked: 0, done: 2 })
  })

  test('a session is open while its heartbeat is recent', async () => {
    expect(isOpen(record({ aliveAt: NOW - 60_000 }), NOW)).toBe(true)
    expect(isOpen(record({ aliveAt: NOW - 600_000 }), NOW)).toBe(false)
  })

  test('a broken status in a file reads as none', async () => {
    expect(parseRecord('{"id": "a", "root": "/r", "status": "later"}')?.status).toBeNull()
    expect(parseRecord('{"id": "a", "root": "/r", "status": "waiting"}')?.status).toBe('waiting')
  })
})

describe('mergeSessions', () => {
  const base: TranscriptMeta = {
    messageCount: 1,
    firstPrompt: 'hola',
    customTitle: null,
    aiTitle: null,
    agentName: null,
    gitBranch: null,
    sessionKind: null,
    prNumber: null,
    prRepository: null,
    modified: '1970-01-01T00:00:05.000Z',
    fileSize: 1,
    cwd: '/old',
    entrypoint: 'cli',
  }

  test('adds sessions that only have a transcript, keeps notes, drops empty transcripts', async () => {
    const noted = record({ id: 'n', comment: 'mine', lastActive: 1 })
    const merged = mergeSessions([noted, record({ id: 'fresh' })], {
      n: base,
      old: base,
      empty: { ...base, firstPrompt: '' },
      headless: { ...base, entrypoint: 'sdk-cli' },
      fresh: { ...base, entrypoint: 'sdk-ts' },
    })
    expect(merged.map(one => one.id).sort()).toEqual(['fresh', 'n', 'old'])
    expect(merged.find(one => one.id === 'n')).toMatchObject({ comment: 'mine', lastActive: 5000 })
    expect(merged.find(one => one.id === 'old')).toMatchObject({ root: '/old', lastActive: 5000, tags: [] })
  })
})

describe('activity', () => {
  test('the owner activity file overrides title, last activity and heartbeat', async () => {
    const notes = record({ id: 'a', title: 'old', lastActive: 10, aliveAt: 5, comment: 'kept' })
    const merged = withActivity(notes, { title: 'new', lastActive: 20, aliveAt: 30 })
    expect(merged).toMatchObject({ title: 'new', lastActive: 20, aliveAt: 30, comment: 'kept' })
    expect(withActivity(notes, { title: '', lastActive: 1, aliveAt: 1 })).toMatchObject({
      title: 'old',
      lastActive: 10,
      aliveAt: 5,
    })
    expect(withActivity(notes, null)).toBe(notes)
  })

  test('reads back what activityOf wrote, and a broken file as nothing', async () => {
    const one = record({ title: 't', lastActive: 2, aliveAt: 3 })
    expect(parseActivity(JSON.stringify(activityOf(one)))).toEqual({ title: 't', lastActive: 2, aliveAt: 3 })
    expect(parseActivity('{')).toBeNull()
  })
})
