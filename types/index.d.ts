export type SessionStatus = 'active' | 'waiting' | 'blocked' | 'done'

export type SessionRecord = {
  id: string
  root: string
  repo: string | null
  title: string
  comment: string
  tags: string[]
  status: SessionStatus | null
  startedAt: number
  lastActive: number
  aliveAt: number
}

export type SessionActivity = {
  title: string
  lastActive: number
  aliveAt: number
}

export type TranscriptMeta = {
  messageCount: number
  firstPrompt: string
  customTitle: string | null
  aiTitle: string | null
  agentName: string | null
  gitBranch: string | null
  sessionKind: string | null
  prNumber: number | null
  prRepository: string | null
  modified: string | null
  fileSize: number
  cwd: string | null
  entrypoint: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-tags': {
      sessions: SessionRecord[]
      currentId: string
      query: string
      selectedTags: string[]
      tagDraft: string | null
      meta: Record<string, TranscriptMeta>
      selectedStatuses: SessionStatus[]
      showDone: boolean
      editingId: string
    }
  }
}
