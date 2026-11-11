import type { RenderPropsOf } from 'claude-code'
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { SessionRecord, TranscriptMeta } from '../types'

const PANE = {
  component: 'Pane',
  requestId: 'session-tags',
  props: {
    title: 'Sessions',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
  } as unknown as RenderPropsOf['Pane'],
} as const

const SESSIONS: SessionRecord[] = [
  {
    id: 'a',
    root: '/repo',
    repo: 'mono',
    title: 'webcam',
    comment: 'Esperando revisión',
    tags: ['qa'],
    status: null,
    aliveAt: 0,
    startedAt: 0,
    lastActive: 1,
  },
  {
    id: 'b',
    root: '/repo',
    repo: 'mono',
    title: 'docs',
    comment: 'PR abierta',
    tags: ['pr'],
    status: null,
    aliveAt: 0,
    startedAt: 0,
    lastActive: 2,
  },
]

const META: Record<string, TranscriptMeta> = {
  a: {
    messageCount: 7,
    firstPrompt: 'hola',
    customTitle: null,
    aiTitle: 'Webcam capture',
    agentName: null,
    gitBranch: 'feature-webcam',
    sessionKind: null,
    prNumber: 33590,
    prRepository: 'acme/web-app',
    modified: null,
    fileSize: 10,
    cwd: '/repo',
    entrypoint: 'cli',
  },
}

function seedSessions(on: On, meta: Record<string, TranscriptMeta> = {}) {
  mock.clock(on)
  on('state.get', ($, e, next) => {
    if (e.plugin === 'session-tags' && e.key === 'sessions') {
      return { value: { value: SESSIONS, version: 1 } }
    }
    if (e.plugin === 'session-tags' && e.key === 'meta') {
      return { value: { value: meta, version: 1 } }
    }

    return next(e)
  })
}

test('search and tag chips narrow the list', async ($, on) => {
  seedSessions(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-tags', surface, ...PANE })

    expect(await ui.find({ key: 'session:a' })).toBeDefined()
    expect(await ui.find({ key: 'session:b' })).toBeDefined()

    await ui.input({ key: 'search', text: 'revision', kind: 'change' })
    expect(await ui.find({ key: 'session:a' })).toBeDefined()
    expect(await ui.find({ key: 'session:b' })).toBeUndefined()

    await ui.input({ key: 'search', text: '', kind: 'change' })
    await ui.press({ key: 'tag:pr' })
    expect(await ui.find({ key: 'session:a' })).toBeUndefined()
    expect(await ui.find({ key: 'session:b' })).toBeDefined()

    await ui.press({ key: 'tag:qa' })
    expect(await ui.find({ key: 'session:a' })).toBeDefined()
    expect(await ui.find({ key: 'session:b' })).toBeDefined()

    await ui.press({ key: 'clear-tags' })
    await ui.unmount()
  }
})

test('typing in the tags field proposes existing tags that match', async ($, on) => {
  seedSessions(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-tags', surface, ...PANE })

    expect(await ui.find({ key: 'suggest:qa' })).toBeDefined()
    expect(await ui.find({ key: 'suggest:pr' })).toBeDefined()

    await ui.input({ key: 'tags', text: 'q', kind: 'change' })
    expect(await ui.find({ key: 'suggest:qa' })).toBeDefined()
    expect(await ui.find({ key: 'suggest:pr' })).toBeUndefined()

    await ui.input({ key: 'tags', text: 'nueva', kind: 'change' })
    expect(await ui.find({ key: 'suggest:qa' })).toBeUndefined()

    await ui.input({ key: 'tags', text: '', kind: 'change' })
    await ui.unmount()
  }
})

test('rows show the /resume title and line', async ($, on) => {
  seedSessions(on, META)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-tags', surface, ...PANE })

    expect((await ui.find({ key: 'session:a' }))?.text).toBe('Webcam capture')
    expect(
      await ui.find({ type: 'Text', text: /feature-webcam · 7 messages · acme\/web-app#33590/ }),
    ).toBeDefined()
    expect((await ui.find({ key: 'session:b' }))?.text).toBe('docs')
    expect(await ui.find({ type: 'Text', text: /transcript not found/ })).toBeDefined()

    await ui.input({ key: 'search', text: 'capture', kind: 'change' })
    expect(await ui.find({ key: 'session:a' })).toBeDefined()
    expect(await ui.find({ key: 'session:b' })).toBeUndefined()
    await ui.input({ key: 'search', text: '', kind: 'change' })

    await ui.unmount()
  }
})

test('mobile draws the list', async ($, on) => {
  seedSessions(on)
  const ui = await $.ui.mount({ plugin: 'session-tags', surface: 'mobile', ...PANE })

  expect(await ui.find({ key: 'session:a' })).toBeDefined()

  await ui.unmount()
})

test('status chips filter, and done sessions wait behind a toggle', async ($, on) => {
  const records: SessionRecord[] = [
    { ...SESSIONS[0]!, status: 'blocked' },
    { ...SESSIONS[1]!, status: 'done' },
  ]
  mock.clock(on)
  on('state.get', ($, e, next) =>
    e.plugin === 'session-tags' && e.key === 'sessions' ? { value: { value: records, version: 1 } } : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-tags', surface, ...PANE })

    expect(await ui.find({ key: 'session:a' })).toBeDefined()
    expect(await ui.find({ key: 'session:b' })).toBeUndefined()

    await ui.press({ key: 'toggle-done' })
    expect(await ui.find({ key: 'session:b' })).toBeDefined()
    await ui.press({ key: 'toggle-done' })

    await ui.press({ key: 'status:done' })
    expect(await ui.find({ key: 'session:a' })).toBeUndefined()
    expect(await ui.find({ key: 'session:b' })).toBeDefined()
    await ui.press({ key: 'clear-statuses' })

    await ui.unmount()
  }
})

test('the band above the prompt shows this session status, tags and comment', async ($, on) => {
  const own: SessionRecord = { ...SESSIONS[0]!, status: 'waiting' }
  mock.clock(on)
  on('state.get', ($, e, next) => {
    if (e.plugin === 'session-tags' && e.key === 'sessions') {
      return { value: { value: [own], version: 1 } }
    }
    if (e.plugin === 'session-tags' && e.key === 'currentId') {
      return { value: { value: 'a', version: 1 } }
    }

    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-tags',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 3,
        bodyColumns: 100,
      } as unknown as RenderPropsOf['AbovePrompt'],
    })

    expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#qa/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Esperando revisión/ })).toBeDefined()

    await ui.unmount()
  }
})

test('pressing a title edits that session, and back returns to this one', async ($, on) => {
  seedSessions(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-tags', surface, ...PANE })

    expect(await ui.find({ key: 'edit-own' })).toBeUndefined()
    await ui.press({ key: 'session:b' })

    expect(await ui.find({ type: 'Text', text: /Editing: docs/ })).toBeDefined()
    expect((await ui.find({ key: 'comment' }))?.text).toBe('PR abierta')
    expect(await ui.find({ key: 'untag:pr' })).toBeDefined()
    expect(await ui.find({ key: 'suggest:pr' })).toBeUndefined()
    expect(await ui.find({ key: 'suggest:qa' })).toBeDefined()
    expect((await ui.find({ key: 'session:b' }))?.text).toMatch(/^▸ docs/)

    await ui.press({ key: 'edit-own' })
    expect(await ui.find({ type: 'Text', text: /Editing/ })).toBeUndefined()
    expect(await ui.find({ key: 'edit-own' })).toBeUndefined()

    await ui.unmount()
  }
})
