/**
 * dsh-session-export — Host half.
 *
 * Adds a small, read-only export service to DeepSeek Harness. The companion
 * browser half renders one section in Settings; this half lists sessions,
 * reads their committed logs, turns the logs into a normalized transcript,
 * and renders Markdown or JSON for the browser to download.
 *
 * Design notes:
 *   - The session log is the only source of truth. We never write session
 *     events and never touch workspace accounting.
 *   - Live sessions are read from the live `Session` snapshot, so the export
 *     includes the latest committed events without waiting for a flush.
 *   - Cold sessions are read through `sessionPersistence.open(id, 'read')`.
 *     `sessionQuery.readSession(id)` is used only as an optional fallback.
 *   - The HTTP route is loopback-only and requires a custom request header,
 *     mirroring the guard used by other local DSH plugins.
 *
 * @module index.js
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-session-export'

/**
 * No hard service dependency: the plugin still lists sessions from disk when
 * optional services are absent, and answers a clear 500 only on export. The
 * web server is awaited lazily through `ctx.inject`.
 */
export const inject = []

/** Route prefix; `webServer` dispatches the longest matching prefix. */
const ROUTE_PREFIX = '/api/dsh-session-export'

/** Session ids are host-minted UUIDs (with or without the `session-` prefix). */
const SESSION_ID = /^(session-)?[0-9a-fA-F-]{4,64}$/

/** Session log filenames look like `session.v4.jsonl.zstd`. */
const SESSION_LOG = /^session\..*\.jsonl(\.zstd)?$/

/** Request body cap; the body only carries ids and boolean options. */
const MAX_BODY = 256 * 1024

/** Maximum number of sessions in one export. */
const MAX_SESSIONS = 200

/** Maximum serialized export size; protects the host from an accidental huge export. */
const MAX_EXPORT_BYTES = 32 * 1024 * 1024

/** Custom header required by the local route (see `requestFence`). */
const CLIENT_HEADER = 'x-dsh-session-export'
const CLIENT_HEADER_VALUE = '1'

/**
 * The Host header must be a loopback literal. This blocks DNS-rebinding
 * requests whose Origin is an attacker-controlled domain resolving to 127.0.0.1.
 */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i

const CONTENT_LABELS = {
  zh: {
    user: '用户提问',
    assistant: '最终回答',
    reasoning: '思考过程',
    tools: '工具调用与结果',
    system: '系统与运行时提示',
  },
  en: {
    user: 'user questions',
    assistant: 'final answers',
    reasoning: 'reasoning',
    tools: 'tool calls & results',
    system: 'system & runtime context',
  },
}

const LABELS = {
  zh: {
    title: 'DSH 会话导出',
    generatedAt: '导出时间',
    sessionCount: '会话数量',
    content: '导出内容',
    session: '会话',
    sessionId: '会话 ID',
    cwd: '工作目录',
    createdAt: '创建时间',
    updatedAt: '最后活动',
    status: '状态',
    statusLive: '已打开',
    statusArchived: '已归档',
    statusIncomplete: '进行中',
    turn: '第 {n} 轮',
    user: '用户提问',
    assistant: '最终回答',
    reasoning: '思考过程',
    tools: '工具调用与结果',
    system: '系统与运行时提示',
    noFinalYet: '（本轮仍在进行，暂无最终回答）',
    noFinalText: '（本轮没有文本形式的最终回答）',
    noTurns: '（没有可导出的对话内容）',
    attachmentImage: '图片附件',
    attachmentFile: '文件附件',
    toolCall: '工具调用',
    toolResult: '工具结果',
    toolError: '（错误）',
    noToolResult: '（没有记录到工具结果）',
    interrupted: '（会话在此轮中断）',
    footer: '由 DSH 会话导出插件在本机生成',
    noContent: '（未选择）',
    none: '（无）',
    untitled: '（未命名会话）',
  },
  en: {
    title: 'DSH Session Export',
    generatedAt: 'Exported at',
    sessionCount: 'Sessions',
    content: 'Content',
    session: 'Session',
    sessionId: 'Session ID',
    cwd: 'Working directory',
    createdAt: 'Created',
    updatedAt: 'Last activity',
    status: 'Status',
    statusLive: 'Open',
    statusArchived: 'Archived',
    statusIncomplete: 'In progress',
    turn: 'Turn {n}',
    user: 'User',
    assistant: 'Final answer',
    reasoning: 'Reasoning',
    tools: 'Tool calls & results',
    system: 'System & runtime context',
    noFinalYet: '(The turn is still running; no final answer yet.)',
    noFinalText: '(No textual final answer for this turn.)',
    noTurns: '(No conversation content to export.)',
    attachmentImage: 'Image attachment',
    attachmentFile: 'File attachment',
    toolCall: 'Tool call',
    toolResult: 'Result',
    toolError: '(error)',
    noToolResult: '(No tool result was recorded.)',
    interrupted: '(The session was interrupted in this turn.)',
    footer: 'Generated locally by the DSH session export plugin',
    noContent: '(none selected)',
    none: '(none)',
    untitled: '(untitled session)',
  },
}

/**
 * Resolve DSH_HOME. The environment variable is what desktop and CLI hosts
 * set; `~/.dsh` is the same fallback used by the harness itself.
 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** Read a service defensively; a replaced/absent service must not crash a request. */
function optional(service, serviceName) {
  try {
    return typeof service === 'function' ? service(serviceName) : undefined
  } catch {
    return undefined
  }
}

/** Coerce a value to a finite positive timestamp, or null. */
function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/** Coerce a value to a non-empty trimmed string, or undefined. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read JSON without letting a malformed cache file break the whole page. */
async function readJsonFile(file) {
  try {
    const text = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** HTTP error with a status the handler can pass through. */
function fail(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Whether an error is a typed not-found from a persistence/query backend. */
function isNotFound(error) {
  const errorName = String(error?.name ?? '')
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  return (
    errorName === 'SessionPersistenceNotFoundError' ||
    code === 'SESSION_QUERY_SESSION_NOT_FOUND' ||
    (/not found/i.test(message) && /session/i.test(message))
  )
}

/** A human-authored user message, as opposed to injected runtime context. */
function isHumanUserEvent(event) {
  if (event?.type !== 'user/message') return false
  const source = event?.data?.source
  if (source === undefined || source === null || typeof source !== 'object') return true
  if (typeof source.kind !== 'string') return true
  return source.kind === 'user' || source.kind === 'user-questions'
}

/** Extract the visible text from a message-shaped object. */
function messageText(message) {
  if (message === undefined || message === null) return ''
  if (typeof message === 'string') return message
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'reasoning' || block.type === 'tool-call') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Extract image/file attachment references from a message-shaped object. */
function messageAttachments(message) {
  if (message === undefined || message === null || typeof message !== 'object') return []
  const content = Array.isArray(message.content) ? message.content : []
  const attachments = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'image' && block.type !== 'file') continue
    const ref = block.attachment
    if (ref === null || typeof ref !== 'object') continue
    const item = {
      type: block.type,
      attachmentId: nonEmptyString(ref.attachmentId) ?? null,
    }
    if (typeof ref.mediaType === 'string' && ref.mediaType !== '') item.mediaType = ref.mediaType
    if (block.type === 'file') {
      item.name = nonEmptyString(ref.name) ?? 'file'
      if (typeof ref.digest === 'string' && ref.digest !== '') item.digest = ref.digest
    }
    attachments.push(item)
  }
  return attachments
}

/** Extract non-empty reasoning blocks from assistant messages. */
function collectReasoning(messages) {
  const reasoning = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block?.type !== 'reasoning' || typeof block.text !== 'string' || block.text.trim() === '') continue
      reasoning.push({
        text: block.text,
        time: message.time,
        step: message.step,
        seq: message.seq,
      })
    }
  }
  return reasoning
}

/** Merge tool calls and results by call id, keeping results attached to calls. */
function mergeTools(calls, results) {
  const byCall = new Map()
  for (const call of calls) {
    const key = nonEmptyString(call.callId) ?? `call:${call.seq}`
    if (!byCall.has(key)) {
      byCall.set(key, {
        callId: call.callId ?? null,
        name: call.name ?? null,
        arguments: call.arguments,
        time: call.time,
        step: call.step,
        result: null,
      })
    }
  }
  for (const result of results) {
    const key = nonEmptyString(result.callId) ?? `result:${result.seq}`
    let tool = byCall.get(key)
    if (tool === undefined) {
      tool = {
        callId: result.callId ?? null,
        name: null,
        arguments: undefined,
        time: result.time,
        step: result.step,
        result: null,
      }
      byCall.set(key, tool)
    }
    tool.result = {
      text: result.text ?? '',
      isError: result.isError === true,
      time: result.time,
    }
  }
  return [...byCall.values()]
}

/**
 * Normalize a session log into turn-shaped export data.
 *
 * A "final answer" is the last assistant message in a turn that carries text
 * or an attachment and asks for no tool call. Intermediate assistant messages
 * (reasoning, tool calls, or commentary bundled with a tool call) never become
 * the final answer by themselves. Turn boundaries come from
 * `turn/start` / `turn/end`; logs without boundaries fall back to a simple
 * user-message-delimited grouping.
 */
function extractTurns(events, options) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const turnMeta = new Map()
  for (const event of ordered) {
    if (event?.type === 'turn/start' && Number.isFinite(event?.data?.turn)) {
      turnMeta.set(event.data.turn, {
        turn: event.data.turn,
        startSeq: event.seq,
        startTime: safeTime(event.time),
        endSeq: null,
        endTime: null,
        reason: null,
      })
    } else if (event?.type === 'turn/end' && Number.isFinite(event?.data?.turn)) {
      const meta = turnMeta.get(event.data.turn)
      if (meta !== undefined) {
        meta.endSeq = event.seq
        meta.endTime = safeTime(event.time)
        meta.reason = event.data.reason ?? null
      }
    }
  }
  const starts = [...turnMeta.values()].sort((a, b) => a.startSeq - b.startSeq)
  const hasBoundaries = starts.length > 0
  const fallback = { next: 1, current: null }
  const groups = new Map()

  function ensure(turnNumber, time) {
    let key = Number.isFinite(turnNumber) ? turnNumber : null
    if (key === null) {
      if (fallback.current === null) fallback.current = fallback.next++
      key = fallback.current
    }
    let group = groups.get(key)
    if (group === undefined) {
      const meta = turnMeta.get(key)
      group = {
        turn: key,
        startTime: meta?.startTime ?? safeTime(time),
        endTime: meta?.endTime ?? null,
        reason: meta?.reason ?? null,
        complete: hasBoundaries ? meta !== undefined && meta.endSeq !== null : true,
        users: [],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
      }
      groups.set(key, group)
    }
    return group
  }

  function lastStartBefore(seq) {
    let found = null
    for (const meta of starts) {
      if (meta.startSeq <= seq) found = meta
      else break
    }
    return found
  }

  function resolveTurn(event) {
    const declared = event?.data?.turn
    if (Number.isFinite(declared) && turnMeta.has(declared)) return declared
    if (hasBoundaries) {
      const meta = lastStartBefore(event?.seq ?? 0)
      return (meta ?? starts[0]).turn
    }
    if (event?.type === 'user/message' && isHumanUserEvent(event)) {
      if (fallback.current === null) {
        fallback.current = fallback.next++
      } else {
        const current = groups.get(fallback.current)
        if (current !== undefined && current.users.length > 0) fallback.current = fallback.next++
      }
      return fallback.current
    }
    if (fallback.current === null) fallback.current = fallback.next++
    return fallback.current
  }

  for (const event of ordered) {
    if (event?.type === 'user/message') {
      if (!isHumanUserEvent(event)) continue
      const group = ensure(resolveTurn(event), event.time)
      group.users.push({
        text: messageText(event.data),
        attachments: messageAttachments(event.data),
        time: safeTime(event.time),
        seq: event.seq,
      })
      continue
    }
    if (event?.type === 'assistant/message') {
      const group = ensure(resolveTurn(event), event.time)
      const content = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
      group.assistantMessages.push({
        content,
        time: safeTime(event.time),
        step: event.data?.step,
        seq: event.seq,
      })
      if (options.tools) {
        for (const block of content) {
          if (block?.type !== 'tool-call') continue
          group.toolCalls.push({
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
            time: safeTime(event.time),
            step: event.data?.step,
            seq: event.seq,
          })
        }
      }
      continue
    }
    if (event?.type === 'tool/call') {
      if (!options.tools) continue
      const group = ensure(resolveTurn(event), event.time)
      group.toolCalls.push({
        callId: event?.data?.callId,
        name: event?.data?.name,
        arguments: event?.data?.arguments,
        time: safeTime(event.time),
        step: event?.data?.step,
        seq: event.seq,
      })
      continue
    }
    if (event?.type === 'tool/result') {
      if (!options.tools) continue
      const group = ensure(resolveTurn(event), event.time)
      const message = event?.data?.message ?? event?.data
      group.toolResults.push({
        callId: message?.source?.callId ?? message?.toolCallId ?? event?.data?.callId,
        text: messageText(message),
        isError: message?.isError === true,
        time: safeTime(event.time),
        step: event?.data?.step,
        seq: event.seq,
      })
    }
  }

  const turns = []
  for (const group of [...groups.values()].sort((a, b) => a.turn - b.turn)) {
    const finalMessage = options.assistant
      ? [...group.assistantMessages]
          .reverse()
          .find(
            (message) =>
              !message.content.some((block) => block?.type === 'tool-call') &&
              (messageText({ content: message.content }).trim() !== '' ||
                messageAttachments({ content: message.content }).length > 0),
          )
      : undefined

    const assistant =
      finalMessage === undefined
        ? null
        : {
            text: messageText({ content: finalMessage.content }),
            attachments: messageAttachments({ content: finalMessage.content }),
            time: finalMessage.time,
            step: finalMessage.step,
            seq: finalMessage.seq,
          }
    const reasoning = options.reasoning ? collectReasoning(group.assistantMessages) : []
    const tools = options.tools ? mergeTools(group.toolCalls, group.toolResults) : []
    const users = options.user ? group.users : []

    if (users.length === 0 && assistant === null && reasoning.length === 0 && tools.length === 0) continue

    const meta = turnMeta.get(group.turn)
    const complete = hasBoundaries ? meta !== undefined && meta.endSeq !== null : true
    turns.push({
      turn: group.turn,
      startTime: meta?.startTime ?? group.startTime,
      endTime: meta?.endTime ?? group.endTime,
      complete,
      incomplete: !complete,
      reason: meta?.reason ?? group.reason,
      users,
      assistant,
      reasoning,
      tools,
    })
  }
  return turns
}

/** Collect system, runtime-context, and compaction messages in log order. */
function extractContext(events) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const context = []
  for (const event of ordered) {
    if (event?.type === 'system/message' || event?.type === 'developer/message') {
      const message = event?.data?.message ?? event?.data
      const text = messageText(message)
      if (text.trim() === '') continue
      context.push({
        kind: event.type,
        source: event?.data?.source ?? null,
        text,
        time: safeTime(event.time),
        seq: event.seq,
      })
      continue
    }
    if (event?.type === 'user/message' && !isHumanUserEvent(event)) {
      const text = messageText(event.data)
      if (text.trim() === '') continue
      context.push({
        kind: `user:${event?.data?.source?.kind ?? 'injected'}`,
        source: event?.data?.source ?? null,
        text,
        time: safeTime(event.time),
        seq: event.seq,
      })
      continue
    }
    if (event?.type === 'compaction/summary') {
      const text = [messageText({ content: event?.data?.summary }), messageText({ content: event?.data?.rawOutput })]
        .filter((value) => value.trim() !== '')
        .join('\n\n')
      if (text.trim() === '') continue
      context.push({
        kind: 'compaction/summary',
        source: null,
        text,
        time: safeTime(event.time),
        seq: event.seq,
      })
    }
  }
  return context
}

/** First human question, used as a title fallback when no title event exists. */
function firstHumanQuestion(events) {
  for (const event of events) {
    if (!isHumanUserEvent(event)) continue
    const text = messageText(event.data).replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return ''
}

/** Normalize one loaded log into the export transcript shape. */
function extractSession(loaded, info, options) {
  const events = Array.isArray(loaded?.events) ? loaded.events : []
  const header = loaded?.header ?? {}
  const ordered = [...events].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const titleEvent = [...ordered]
    .reverse()
    .find((event) => event?.type === 'session/title' && typeof event?.data?.title === 'string')
  const title =
    nonEmptyString(titleEvent?.data?.title) ??
    nonEmptyString(info?.title) ??
    (nonEmptyString(firstHumanQuestion(ordered))?.slice(0, 80) || null)
  const lastEvent = ordered.at(-1)
  const updatedAt = Math.max(safeTime(info?.updatedAt) ?? 0, safeTime(lastEvent?.time) ?? 0) || null
  return {
    id: nonEmptyString(header.id) ?? nonEmptyString(info?.id) ?? '',
    title,
    cwd: nonEmptyString(header.cwd) ?? nonEmptyString(info?.cwd),
    createdAt: safeTime(header.createdAt) ?? safeTime(info?.createdAt),
    updatedAt,
    parentSession: header.parentSession ?? null,
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
    formatVersion: header.version ?? null,
    live: info?.live === true || loaded?.live === true,
    archived: info?.archived === true,
    context: options.system ? extractContext(ordered) : [],
    turns: extractTurns(ordered, options),
  }
}

/** Read the projection cache for title/cwd/time without loading a session log. */
async function readProjection(home, id) {
  const empty = { title: undefined, titleFallback: undefined, cwd: undefined, createdAt: null, lastPromptAt: null, blank: false, turnCount: null }
  if (!SESSION_ID.test(id)) return empty
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  const record = await readJsonFile(file)
  const rows = record?.record?.rows
  const identity = record?.record?.identity
  const title = rows?.title?.val
  const titleInput = rows?.titleInput?.val?.first?.text
  const lastPromptAt =
    safeTime(rows?.sessionListMetadata?.val?.lastPromptAt) ?? safeTime(rows?.timeContext?.val?.lastMessageTime)
  const turns = rows?.turnOutline?.val?.turns
  return {
    title: nonEmptyString(title),
    titleFallback: nonEmptyString(titleInput)?.replace(/\s+/g, ' ').slice(0, 120),
    cwd: nonEmptyString(identity?.cwd),
    createdAt: safeTime(identity?.createdAt),
    lastPromptAt,
    blank: rows?.sessionListMetadata?.val?.blank === true,
    turnCount: Array.isArray(turns) ? turns.length : null,
  }
}

/** Scan the on-disk session directory for logs the persistence service may not list. */
async function scanDisk(home) {
  const found = new Map()
  const root = path.join(home, 'sessions')
  let groups
  try {
    groups = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(root, group.name)
    let entries
    try {
      entries = await fsp.readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
      const dir = path.join(groupDir, entry.name)
      let files
      try {
        files = await fsp.readdir(dir)
      } catch {
        continue
      }
      const log = files.find((file) => SESSION_LOG.test(file))
      if (log === undefined) continue
      let stat
      try {
        stat = await fsp.stat(path.join(dir, log))
      } catch {
        stat = undefined
      }
      found.set(entry.name, {
        id: entry.name,
        dir,
        group: group.name,
        log,
        mtimeMs: safeTime(stat?.mtimeMs),
        sizeBytes: typeof stat?.size === 'number' ? stat.size : null,
      })
    }
  }
  return found
}

/** Build the session listing used by the Settings page. */
async function listSessions({ service, home, logger }) {
  const sessionsService = optional(service, 'sessions')
  const persistence = optional(service, 'sessionPersistence')
  const registry = optional(service, 'workspaceRegistry')

  const records = new Map()

  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      for (const snapshot of (await persistence.list()) ?? []) {
        const header = snapshot?.header ?? snapshot
        const id = nonEmptyString(header?.id)
        if (id === undefined) continue
        records.set(id, {
          header,
          live: false,
          persisted: true,
          sizeBytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : null,
        })
      }
    } catch (error) {
      logger?.warn?.(`dsh-session-export: 无法读取持久化会话列表: ${error?.message ?? error}`)
    }
  }

  if (sessionsService !== undefined && typeof sessionsService.list === 'function') {
    try {
      for (const session of sessionsService.list() ?? []) {
        const header = session?.header
        const id = nonEmptyString(header?.id)
        if (id === undefined) continue
        const previous = records.get(id)
        records.set(id, {
          header,
          live: true,
          persisted: previous?.persisted === true,
          sizeBytes: previous?.sizeBytes ?? null,
        })
      }
    } catch (error) {
      logger?.warn?.(`dsh-session-export: 无法读取活动会话列表: ${error?.message ?? error}`)
    }
  }

  const disk = await scanDisk(home)
  const archived = new Set()
  if (Array.isArray(registry?.archivedSessionIds)) {
    for (const id of registry.archivedSessionIds) archived.add(String(id))
  }

  const sessions = []
  for (const id of new Set([...records.keys(), ...disk.keys()])) {
    const record = records.get(id)
    const local = disk.get(id)
    const header = record?.header ?? { id }
    const projection = await readProjection(home, id)
    let title = projection.title ?? projection.titleFallback
    let cwd = projection.cwd ?? nonEmptyString(header.cwd)
    let createdAt = projection.createdAt ?? safeTime(header.createdAt)
    let updatedAt = Math.max(
      projection.lastPromptAt ?? 0,
      local?.mtimeMs ?? 0,
      safeTime(header.updatedAt) ?? 0,
    ) || null
    let turnCount = projection.turnCount ?? null

    // A live session usually gets a projection cache entry quickly, but a
    // just-created session may not have one yet. Its in-memory snapshot is
    // also the freshest source for the ordering timestamp. This only touches
    // sessions that are already live; cold logs are not read for the list.
    if (record?.live === true && sessionsService !== undefined) {
      try {
        const live = sessionsService.get(id)
        if (live !== undefined && typeof live.snapshotEvents === 'function') {
          const events = live.snapshotEvents()
          if (title === undefined) title = nonEmptyString(firstHumanQuestion(events))?.slice(0, 80)
          if (createdAt === null) createdAt = safeTime(live.header?.createdAt)
          if (cwd === undefined) cwd = nonEmptyString(live.header?.cwd)
          updatedAt = Math.max(updatedAt ?? 0, safeTime(events.at(-1)?.time) ?? 0) || null
          if (turnCount === null) turnCount = events.filter((event) => event?.type === 'turn/start').length || null
        }
      } catch {
        /* a live read failure must not hide the other sessions */
      }
    }

    sessions.push({
      id,
      title: title ?? null,
      cwd: cwd ?? null,
      createdAt,
      updatedAt,
      sizeBytes: record?.sizeBytes ?? local?.sizeBytes ?? null,
      turnCount,
      blank: projection.blank === true,
      live: record?.live === true,
      persisted: record?.persisted === true || local !== undefined,
      onDisk: local !== undefined,
      archived: archived.has(id) || archived.has(id.replace(/^session-/, '')),
    })
  }

  sessions.sort(
    (a, b) =>
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
      a.id.localeCompare(b.id),
  )

  return {
    ok: true,
    home,
    capabilities: {
      sessions: sessionsService !== undefined,
      persistence: persistence !== undefined,
      registry: registry !== undefined,
    },
    sessions,
  }
}

/** Read one session's latest committed log. */
async function loadSession({ service, id, logger }) {
  const sessionsService = optional(service, 'sessions')
  const live = sessionsService?.get?.(id)
  if (live !== undefined && live !== null) {
    try {
      if (typeof live.snapshotEvents === 'function') {
        return {
          header: structuredClone(live.header ?? { id }),
          events: live.snapshotEvents(),
          live: true,
        }
      }
      if (typeof sessionsService.flush === 'function') await sessionsService.flush(live)
    } catch (error) {
      logger?.warn?.(`dsh-session-export: 读取活动会话 ${id} 失败，尝试持久化副本: ${error?.message ?? error}`)
    }
  }

  const persistence = optional(service, 'sessionPersistence')
  if (persistence !== undefined && typeof persistence.open === 'function') {
    let handle
    try {
      handle = await persistence.open(id, 'read')
      const read = await handle.read(0, undefined)
      return {
        header: handle.header ?? read?.header ?? { id },
        events: Array.isArray(read?.events) ? read.events : [],
        live: live !== undefined && live !== null,
      }
    } catch (error) {
      if (isNotFound(error)) throw fail(404, `找不到会话 ${id}（日志可能已被删除）`)
      throw error
    } finally {
      if (handle !== undefined && typeof handle.close === 'function') {
        await Promise.resolve(handle.close()).catch(() => {})
      }
    }
  }

  const query = optional(service, 'sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const loaded = await query.readSession(id)
      return {
        header: loaded?.session ?? { id },
        events: Array.isArray(loaded?.events) ? loaded.events : [],
        live: live !== undefined && live !== null,
      }
    } catch (error) {
      if (isNotFound(error)) throw fail(404, `找不到会话 ${id}`)
      throw error
    }
  }

  if (live === undefined || live === null) throw fail(404, `找不到会话 ${id}`)
  throw fail(500, `没有可用于读取会话 ${id} 的持久化或会话查询服务`)
}

/** Normalize the boolean content options; default is user questions + final answers. */
function normalizeOptions(input) {
  const value = input !== null && typeof input === 'object' ? input : {}
  return {
    user: value.user !== false,
    assistant: value.assistant !== false,
    reasoning: value.reasoning === true,
    tools: value.tools === true,
    system: value.system === true,
  }
}

/** Normalize output format and locale. */
function normalizeFormat(value) {
  if (value === undefined || value === null || value === '') return 'markdown'
  if (value === 'markdown' || value === 'json') return value
  throw fail(400, 'format 必须是 markdown 或 json')
}

function normalizeLocale(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Human-readable list of selected content options. */
function describeOptions(options, locale) {
  const labels = CONTENT_LABELS[locale] ?? CONTENT_LABELS.zh
  const parts = []
  for (const key of ['user', 'assistant', 'reasoning', 'tools', 'system']) {
    if (options[key] === true) parts.push(labels[key])
  }
  return parts.length === 0 ? LABELS[locale].none : parts.join(locale === 'en' ? ', ' : '、')
}

/** Format a timestamp in the user's locale. */
function formatTimestamp(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return LABELS[locale].none
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

/** Collapse a value into one line for a Markdown heading. */
function oneLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Choose a Markdown fence longer than any run of backticks inside the body. */
function fencedBlock(text, language) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const runs = value.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language === undefined ? '' : language}\n${value}\n${fence}`
}

/** Pretty-print JSON tool arguments when possible; otherwise keep them verbatim. */
function formatArguments(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value ?? '')
  }
}

/** Append attachment reference bullets. */
function appendAttachmentLines(lines, attachments, labels) {
  for (const attachment of attachments) {
    const id = attachment?.attachmentId
    if (attachment?.type === 'image') {
      lines.push(
        `- ${labels.attachmentImage}: ${id === null ? labels.none : `\`${id}\``}${
          attachment?.mediaType === undefined ? '' : ` (${attachment.mediaType})`
        }`,
      )
    } else {
      lines.push(
        `- ${labels.attachmentFile}: ${attachment?.name ?? 'file'}${id === null ? '' : ` (\`${id}\`)`}`,
      )
    }
  }
  if (attachments.length > 0) lines.push('')
}

/** Render the normalized export as Markdown. */
function renderMarkdown(data, locale) {
  const labels = LABELS[locale] ?? LABELS.zh
  const lines = []
  lines.push(`# ${labels.title}`)
  lines.push('')
  lines.push(`> ${labels.generatedAt}: ${formatTimestamp(data.exportedAt, locale)}`)
  lines.push(`> ${labels.sessionCount}: ${data.sessions.length}`)
  lines.push(`> ${labels.content}: ${describeOptions(data.options, locale)}`)
  lines.push('')

  for (const session of data.sessions) {
    lines.push('---')
    lines.push('')
    lines.push(`## ${labels.session}: ${oneLine(session.title) || labels.untitled}`)
    lines.push('')
    lines.push(`- ${labels.sessionId}: \`${session.id}\``)
    if (session.cwd !== null && session.cwd !== undefined) lines.push(`- ${labels.cwd}: \`${session.cwd}\``)
    if (session.createdAt !== null) lines.push(`- ${labels.createdAt}: ${formatTimestamp(session.createdAt, locale)}`)
    if (session.updatedAt !== null) lines.push(`- ${labels.updatedAt}: ${formatTimestamp(session.updatedAt, locale)}`)
    const statuses = []
    if (session.live) statuses.push(labels.statusLive)
    if (session.archived) statuses.push(labels.statusArchived)
    if (session.turns.some((turn) => turn.incomplete)) statuses.push(labels.statusIncomplete)
    if (statuses.length > 0) lines.push(`- ${labels.status}: ${statuses.join(' / ')}`)
    lines.push('')

    if (session.context.length > 0) {
      lines.push('<details>')
      lines.push(`<summary>${labels.system} (${session.context.length})</summary>`)
      lines.push('')
      for (const item of session.context) {
        lines.push(`#### ${item.kind}`)
        lines.push('')
        lines.push(item.text)
        lines.push('')
      }
      lines.push('</details>')
      lines.push('')
    }

    if (session.turns.length === 0) {
      lines.push(`_${labels.noTurns}_`)
      lines.push('')
      continue
    }

    for (const turn of session.turns) {
      const time = formatTimestamp(turn.startTime ?? turn.endTime, locale)
      lines.push(`### ${labels.turn.replace('{n}', String(turn.turn))}${time === labels.none ? '' : ` · ${time}`}`)
      lines.push('')

      for (const user of turn.users) {
        lines.push(`#### ${labels.user}`)
        lines.push('')
        lines.push(user.text.trim() === '' ? `_${labels.none}_` : user.text)
        lines.push('')
        appendAttachmentLines(lines, user.attachments, labels)
      }

      if (data.options.assistant) {
        lines.push(`#### ${labels.assistant}`)
        lines.push('')
        if (turn.assistant === null) {
          lines.push(`_${turn.incomplete ? labels.noFinalYet : labels.noFinalText}_`)
          lines.push('')
        } else {
          lines.push(turn.assistant.text.trim() === '' ? `_${labels.noFinalText}_` : turn.assistant.text)
          lines.push('')
          appendAttachmentLines(lines, turn.assistant.attachments, labels)
        }
      }

      if (turn.reasoning.length > 0) {
        lines.push('<details>')
        lines.push(`<summary>${labels.reasoning} (${turn.reasoning.length})</summary>`)
        lines.push('')
        for (const item of turn.reasoning) {
          lines.push(item.text)
          lines.push('')
        }
        lines.push('</details>')
        lines.push('')
      }

      if (turn.tools.length > 0) {
        lines.push('<details>')
        lines.push(`<summary>${labels.tools} (${turn.tools.length})</summary>`)
        lines.push('')
        for (const tool of turn.tools) {
          lines.push(`##### ${labels.toolCall}: ${tool.name ?? 'tool'}`)
          lines.push('')
          if (tool.arguments !== undefined) lines.push(fencedBlock(formatArguments(tool.arguments), 'json'))
          else lines.push(`_${labels.noContent}_`)
          lines.push('')
          if (tool.result === null) {
            lines.push(`_${labels.noToolResult}_`)
            lines.push('')
          } else {
            lines.push(`**${labels.toolResult}${tool.result.isError ? ` ${labels.toolError}` : ''}**`)
            lines.push('')
            lines.push(fencedBlock(tool.result.text, 'text'))
            lines.push('')
          }
        }
        lines.push('</details>')
        lines.push('')
      }

      if (turn.reason?.kind === 'interrupted') {
        lines.push(`_${labels.interrupted}_`)
        lines.push('')
      }
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(`*${labels.footer}*`)
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the normalized export as JSON. */
function renderJson(data) {
  return `${JSON.stringify(
    {
      app: 'dsh-session-export',
      version: 1,
      exportedAt: data.exportedAt,
      options: data.options,
      sessions: data.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        parentSession: session.parentSession,
        delegationDepth: session.delegationDepth,
        formatVersion: session.formatVersion,
        live: session.live,
        archived: session.archived,
        context: session.context,
        turns: session.turns.map((turn) => ({
          turn: turn.turn,
          startTime: turn.startTime,
          endTime: turn.endTime,
          complete: turn.complete,
          reason: turn.reason,
          users: turn.users,
          assistant: turn.assistant,
          reasoning: turn.reasoning,
          tools: turn.tools,
        })),
      })),
    },
    null,
    2,
  )}\n`
}

/** Make a string safe as one Windows/POSIX filename component. */
function safeFilenamePart(value, maxLength = 60) {
  let text = String(value ?? '')
  text = text
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  if (text === '') text = 'session'
  if (text.length > maxLength) text = text.slice(0, maxLength).trim().replace(/[. ]+$/, '')
  return text === '' ? 'session' : text
}

/** Build a local-time filename stamp, e.g. 20261017-2315. */
function filenameStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Choose the download filename for one or more sessions. */
function exportFilename(sessions, format, date = new Date()) {
  const extension = format === 'json' ? 'json' : 'md'
  const stamp = filenameStamp(date)
  if (sessions.length === 1) {
    return `dsh-session-${safeFilenamePart(sessions[0].title ?? sessions[0].id)}-${stamp}.${extension}`
  }
  return `dsh-sessions-${sessions.length}-${stamp}.${extension}`
}

/**
 * Build the complete export response.
 *
 * Listing is best-effort metadata (title/cwd/archive flags); the actual log
 * read is fail-loud, because silently omitting a selected session would be
 * worse than showing an error the user can act on.
 */
async function buildExport({ service, home, ids, options, format, locale, logger }) {
  const unique = [...new Set(ids.map((id) => String(id)))]
  if (unique.length === 0) throw fail(400, '请至少选择一个会话')
  if (unique.length > MAX_SESSIONS) throw fail(413, `一次最多导出 ${MAX_SESSIONS} 个会话`)
  for (const id of unique) {
    if (!SESSION_ID.test(id)) throw fail(400, `会话 id 不合法: ${id}`)
  }

  let infoById = new Map()
  try {
    const listing = await listSessions({ service, home, logger })
    infoById = new Map(listing.sessions.map((session) => [session.id, session]))
  } catch (error) {
    logger?.warn?.(`dsh-session-export: 导出时读取会话列表失败，继续直接读取所选会话: ${error?.message ?? error}`)
  }

  const sessions = []
  for (const id of unique) {
    let loaded
    try {
      loaded = await loadSession({ service, id, logger })
    } catch (error) {
      const message = error?.message ?? String(error)
      logger?.warn?.(`dsh-session-export: 读取会话 ${id} 失败: ${message}`)
      throw fail(error?.status ?? 500, `会话 ${id} 读取失败：${message}`)
    }
    sessions.push(extractSession(loaded, infoById.get(id), options))
  }

  // Match the Settings list's newest-first order, independent of click order.
  sessions.sort(
    (a, b) =>
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      a.id.localeCompare(b.id),
  )

  const data = {
    exportedAt: Date.now(),
    options,
    format,
    sessions,
  }
  const content = format === 'json' ? renderJson(data) : renderMarkdown(data, locale)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_EXPORT_BYTES) {
    throw fail(413, `导出内容约 ${Math.ceil(bytes / 1024 / 1024)} MB，超过 ${MAX_EXPORT_BYTES / 1024 / 1024} MB 上限；请减少会话或内容选项。`)
  }
  return {
    ok: true,
    filename: exportFilename(sessions, format),
    mime: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    content,
    bytes,
    count: sessions.length,
  }
}

/** Loopback check for the HTTP route. */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Host-header and custom-header fence. Returns an error message, or undefined. */
function requestFence(req) {
  const host = String(req?.headers?.host ?? '').trim()
  if (!LOOPBACK_HOST.test(host)) {
    return (
      `仅接受来自 127.0.0.1 / localhost 的请求（Host: ${host === '' ? '(缺失)' : host}）。` +
      '请改用 http://127.0.0.1:<端口> 访问界面。'
    )
  }
  if (String(req?.headers?.[CLIENT_HEADER] ?? '') !== CLIENT_HEADER_VALUE) {
    return `缺少 ${CLIENT_HEADER} 请求头：本路由拒绝来自其它页面的跨站请求。`
  }
  return undefined
}

/** Read and parse a bounded JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        finish(fail(413, '请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body === '') return finish(undefined, {})
      try {
        finish(undefined, JSON.parse(body))
      } catch {
        finish(fail(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => finish(error))
  })
}

/** Create the HTTP handler. Services are resolved per request, not cached. */
function createHandler({ service, home, logger }) {
  return async function handler(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(payload))
    }

    if (!isLoopback(req)) return send(403, { error: '仅允许本机访问' })
    const fence = requestFence(req)
    if (fence !== undefined) return send(403, { error: fence })

    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && route === '/list') {
        return send(200, await listSessions({ service, home, logger }))
      }

      if (method === 'POST' && route === '/export') {
        const body = await readJson(req)
        const ids = body?.ids
        if (!Array.isArray(ids) || ids.length === 0) return send(400, { error: '请至少选择一个会话' })
        const options = normalizeOptions(body?.options)
        if (!options.user && !options.assistant && !options.reasoning && !options.tools && !options.system) {
          return send(400, { error: '请至少选择一项导出内容' })
        }
        const format = normalizeFormat(body?.format)
        const locale = normalizeLocale(body?.locale)
        return send(200, await buildExport({ service, home, ids, options, format, locale, logger }))
      }

      return send(404, { error: `未知路由 ${method} ${route}` })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      logger?.warn?.(`dsh-session-export: ${method} ${route} 失败: ${error?.message ?? error}`)
      return send(status, { error: error?.message ?? String(error) })
    }
  }
}

/** Plugin entry. */
export function apply(ctx, config = {}) {
  const home = typeof config.home === 'string' && config.home !== '' ? path.resolve(config.home) : resolveHome()
  const logger = ctx?.logger
  const service = (serviceName) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined
    } catch {
      return undefined
    }
  }
  const handler = createHandler({ service, home, logger })

  // webServer is published by the browser composition, which may activate
  // after this plugin; ctx.inject waits for it and re-registers if replaced.
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
    if (server === undefined || server === null || typeof server.register !== 'function') return
    scoped.effect(
      () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-session-export: routes',
    )
    logger?.info?.(`dsh-session-export: 会话导出路由已挂载 ${ROUTE_PREFIX}（DSH_HOME=${home}）`)
  })
}

/** Internal handles for tests. */
export const __internal = {
  ROUTE_PREFIX,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  MAX_SESSIONS,
  MAX_EXPORT_BYTES,
  resolveHome,
  isHumanUserEvent,
  messageText,
  messageAttachments,
  extractTurns,
  extractContext,
  extractSession,
  readProjection,
  scanDisk,
  listSessions,
  loadSession,
  buildExport,
  renderMarkdown,
  renderJson,
  exportFilename,
  safeFilenamePart,
  requestFence,
  createHandler,
}
