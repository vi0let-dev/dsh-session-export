import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  __internal,
  apply,
} from '../index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

const passing = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => passing.push(name))
    .catch((error) => {
      console.error(`FAIL ${name}\n${error?.stack ?? error}`)
      process.exitCode = 1
    })
}

function header(id = SESSION_ID, overrides = {}) {
  return {
    version: 4,
    id,
    createdAt: 1_700_000_000_000,
    cwd: 'C:\\work\\demo',
    isSeeded: false,
    delegationDepth: 0,
    ...overrides,
  }
}

function fixtureEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 101,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Question one' }],
      },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 102,
      data: {
        role: 'user',
        source: { kind: 'runtime-context' },
        content: [{ type: 'text', text: 'Runtime context' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 103,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Think one' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
          ],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 4,
      time: 104,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a"}' },
    },
    {
      type: 'tool/result',
      seq: 5,
      time: 105,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: 'file content' }],
          isError: false,
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: 106,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer one' }] },
      },
    },
    { type: 'turn/end', seq: 7, time: 107, data: { turn: 1 } },
    { type: 'turn/start', seq: 8, time: 200, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 9,
      time: 201,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Question two' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 10,
      time: 202,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Think two' },
            { type: 'text', text: 'Final answer two' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 11, time: 203, data: { turn: 2 } },
    { type: 'session/title', seq: 12, time: 204, data: { title: 'Test session' } },
  ]
}

const DEFAULTS = { user: true, assistant: true, reasoning: false, tools: false, system: false }
const ALL = { user: true, assistant: true, reasoning: true, tools: true, system: true }

function fakeRes() {
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  return {
    status: null,
    headers: null,
    body: '',
    done,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = String(body ?? '')
      finish()
    },
  }
}

function fakeReq({ method = 'GET', url = '/api/dsh-session-export/list', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {
    host: '127.0.0.1:3291',
    'x-dsh-session-export': '1',
    ...headers,
  }
  req.socket = { remoteAddress }
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
  } else {
    process.nextTick(() => req.emit('end'))
  }
  return req
}

async function request(handler, options) {
  const res = fakeRes()
  const req = fakeReq(options)
  await handler(req, res)
  await res.done
  return res
}

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-export-test-'))
  try {
    return await fn(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

await test('package manifest, bundle patch, client id and resources agree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(manifest.name, /^dsh-[a-z0-9]+-[a-z0-9]+$/)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.files.includes('index.js'))
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('icon.svg'))

  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name:\s*'dsh-session-export'/)

  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  assert.match(client, /id:\s*'dsh-session-export'/)
  assert.doesNotMatch(client, /@deepseek-ai\/dsh-client-ui-/)
  assert.doesNotMatch(client, /window\.(confirm|alert|prompt)\s*\(/)

  for (const locale of ['zh', 'en']) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', `${locale}.json`), 'utf8'))
    assert.equal(typeof data.meta?.title, 'string')
    assert.equal(typeof data.meta?.description, 'string')
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8'), /^<svg/)
})

await test('extractTurns defaults to user questions and final answers only', () => {
  const turns = __internal.extractTurns(fixtureEvents(), DEFAULTS)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].users.length, 1)
  assert.equal(turns[0].users[0].text, 'Question one')
  assert.equal(turns[0].assistant.text, 'Final answer one')
  assert.equal(turns[0].reasoning.length, 0)
  assert.equal(turns[0].tools.length, 0)
  assert.equal(turns[0].incomplete, false)
  assert.equal(turns[1].users[0].text, 'Question two')
  assert.equal(turns[1].assistant.text, 'Final answer two')
})

await test('extractTurns includes reasoning, tools and system context when selected', () => {
  const turns = __internal.extractTurns(fixtureEvents(), ALL)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].reasoning[0].text, 'Think one')
  assert.equal(turns[0].tools.length, 1)
  assert.equal(turns[0].tools[0].name, 'read')
  assert.equal(turns[0].tools[0].result.text, 'file content')
  const context = __internal.extractContext(fixtureEvents())
  assert.equal(context.length, 1)
  assert.match(context[0].kind, /runtime-context/)
  assert.match(context[0].text, /Runtime context/)
})

await test('commentary bundled with a tool call is not mistaken for the final answer', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 101,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the work' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 102,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll inspect the files" },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 3, time: 103, data: { turn: 1 } },
  ]
  const turns = __internal.extractTurns(events, DEFAULTS)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].assistant, null)
})

await test('an unclosed final turn is marked incomplete and has no invented final answer', () => {
  const events = fixtureEvents().filter((event) => !(event.type === 'turn/end' && event.data.turn === 2))
  events.push({
    type: 'assistant/message',
    seq: 13,
    time: 300,
    data: { turn: 2, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Still working' }] } },
  })
  const turns = __internal.extractTurns(events, DEFAULTS)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].incomplete, true)
  assert.equal(turns[1].assistant.text, 'Final answer two')
})

await test('renderMarkdown omits optional sections by default and includes them when selected', () => {
  const base = {
    exportedAt: 1_700_000_000_000,
    options: DEFAULTS,
    format: 'markdown',
    sessions: [
      __internal.extractSession(
        { header: header(), events: fixtureEvents() },
        { title: 'Test session', updatedAt: 1_700_000_000_000 },
        DEFAULTS,
      ),
    ],
  }
  const markdown = __internal.renderMarkdown(base, 'zh')
  assert.match(markdown, /^# DSH 会话导出/m)
  assert.match(markdown, /Question one/)
  assert.match(markdown, /Final answer one/)
  assert.doesNotMatch(markdown, /Think one/)
  assert.doesNotMatch(markdown, /file content/)

  const full = {
    ...base,
    options: ALL,
    sessions: [
      __internal.extractSession(
        { header: header(), events: fixtureEvents() },
        { title: 'Test session', updatedAt: 1_700_000_000_000 },
        ALL,
      ),
    ],
  }
  const fullMarkdown = __internal.renderMarkdown(full, 'zh')
  assert.match(fullMarkdown, /Think one/)
  assert.match(fullMarkdown, /工具调用/)
  assert.match(fullMarkdown, /file content/)
  assert.match(fullMarkdown, /Runtime context/)

  const questionsOnly = {
    ...base,
    options: { ...DEFAULTS, assistant: false },
    sessions: [
      __internal.extractSession(
        { header: header(), events: fixtureEvents() },
        { title: 'Test session', updatedAt: 1_700_000_000_000 },
        { ...DEFAULTS, assistant: false },
      ),
    ],
  }
  const questionsOnlyMarkdown = __internal.renderMarkdown(questionsOnly, 'zh')
  assert.match(questionsOnlyMarkdown, /Question one/)
  assert.doesNotMatch(questionsOnlyMarkdown, /#### 最终回答/)
})

await test('renderJson is valid and keeps the normalized turn shape', () => {
  const data = {
    exportedAt: 1_700_000_000_000,
    options: DEFAULTS,
    format: 'json',
    sessions: [
      __internal.extractSession(
        { header: header(), events: fixtureEvents() },
        { title: 'Test session', updatedAt: 1_700_000_000_000 },
        DEFAULTS,
      ),
    ],
  }
  const parsed = JSON.parse(__internal.renderJson(data))
  assert.equal(parsed.app, 'dsh-session-export')
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0].turns[0].users[0].text, 'Question one')
  assert.equal(parsed.sessions[0].turns[0].assistant.text, 'Final answer one')
  assert.equal(parsed.sessions[0].turns[0].reasoning.length, 0)
})

await test('multiple sessions get one combined Markdown file and a count filename', () => {
  const eventsWithoutTitle = fixtureEvents().filter((event) => event.type !== 'session/title')
  const first = __internal.extractSession(
    { header: header('session-aaaaaaaa-1111-2222-3333-444444444444'), events: eventsWithoutTitle },
    { title: 'First', updatedAt: 1_700_000_000_000 },
    DEFAULTS,
  )
  const second = __internal.extractSession(
    { header: header('session-bbbbbbbb-1111-2222-3333-444444444444', { cwd: 'D:\\other' }), events: eventsWithoutTitle },
    { title: 'Second', updatedAt: 1_700_000_000_100 },
    DEFAULTS,
  )
  const markdown = __internal.renderMarkdown(
    { exportedAt: 1_700_000_000_000, options: DEFAULTS, format: 'markdown', sessions: [first, second] },
    'zh',
  )
  assert.match(markdown, /First/)
  assert.match(markdown, /Second/)
  assert.match(__internal.exportFilename([first, second], 'markdown', new Date(2026, 9, 17, 23, 15)), /^dsh-sessions-2-20261017-2315\.md$/)
})

await test('filename sanitization keeps Chinese and removes reserved characters', () => {
  assert.equal(__internal.safeFilenamePart('a/b:c*?  d'), 'a b c d')
  assert.match(__internal.safeFilenamePart('会话导出'), /会话导出/)
  assert.equal(__internal.safeFilenamePart('...'), 'session')
  assert.ok(__internal.safeFilenamePart('x'.repeat(200)).length <= 60)
})

await test('requestFence rejects non-loopback Host and missing custom header', () => {
  assert.match(__internal.requestFence({ headers: { host: 'evil.example:3291', 'x-dsh-session-export': '1' } }), /127\.0\.0\.1/)
  assert.match(__internal.requestFence({ headers: { host: '127.0.0.1:3291' } }), /x-dsh-session-export/)
  assert.equal(__internal.requestFence({ headers: { host: '127.0.0.1:3291', 'x-dsh-session-export': '1' } }), undefined)
  assert.equal(__internal.requestFence({ headers: { host: 'localhost:3291', 'x-dsh-session-export': '1' } }), undefined)
  assert.equal(__internal.requestFence({ headers: { host: '[::1]:3291', 'x-dsh-session-export': '1' } }), undefined)
})

await test('GET /list returns projection titles and flags', async () => {
  await withTempHome(async (home) => {
    const projectionDir = path.join(home, 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(projectionDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectionDir, `${SESSION_ID}.json`),
      JSON.stringify({
        record: {
          identity: { cwd: 'C:\\work\\demo', createdAt: 1_700_000_000_000 },
          rows: {
            title: { val: 'Projection title' },
            sessionListMetadata: { val: { lastPromptAt: 1_700_000_000_500, blank: false } },
            turnOutline: { val: { turns: [{ turn: 1 }, { turn: 2 }] } },
          },
        },
      }),
    )

    const session = { header: header(), snapshotEvents: () => fixtureEvents() }
    const services = {
      sessions: { get: () => session, list: () => [session] },
      sessionPersistence: { list: async () => [{ header: header(), sizeBytes: 1234 }] },
      workspaceRegistry: { archivedSessionIds: [SESSION_ID] },
    }
    const handler = __internal.createHandler({
      service: (name) => services[name],
      home,
      logger: { warn() {}, info() {} },
    })
    const res = await request(handler)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.sessions.length, 1)
    assert.equal(payload.sessions[0].title, 'Projection title')
    assert.equal(payload.sessions[0].live, true)
    assert.equal(payload.sessions[0].archived, true)
    assert.equal(payload.sessions[0].turnCount, 2)
  })
})

await test('POST /export uses the live snapshot and returns a Markdown download', async () => {
  await withTempHome(async (home) => {
    const session = { header: header(), snapshotEvents: () => fixtureEvents() }
    const services = {
      sessions: { get: () => session, list: () => [session] },
      sessionPersistence: { list: async () => [{ header: header() }] },
    }
    const handler = __internal.createHandler({
      service: (name) => services[name],
      home,
      logger: { warn() {}, info() {} },
    })
    const res = await request(handler, {
      method: 'POST',
      url: '/api/dsh-session-export/export',
      body: {
        ids: [SESSION_ID],
        options: { user: true, assistant: true },
        format: 'markdown',
        locale: 'zh',
      },
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.count, 1)
    assert.match(payload.filename, /^dsh-session-.*\.md$/)
    assert.match(payload.content, /Question one/)
    assert.match(payload.content, /Final answer one/)
    assert.doesNotMatch(payload.content, /Think one/)
  })
})

await test('POST /export falls back to persistence for a cold session', async () => {
  await withTempHome(async (home) => {
    const handle = {
      header: header(),
      read: async () => ({ events: fixtureEvents() }),
      close: async () => {},
    }
    const services = {
      sessions: { get: () => undefined, list: () => [] },
      sessionPersistence: {
        list: async () => [{ header: header() }],
        open: async () => handle,
      },
    }
    const handler = __internal.createHandler({
      service: (name) => services[name],
      home,
      logger: { warn() {}, info() {} },
    })
    const res = await request(handler, {
      method: 'POST',
      url: '/api/dsh-session-export/export',
      body: {
        ids: [SESSION_ID],
        options: { user: true, assistant: true, reasoning: true, tools: true, system: true },
        format: 'json',
        locale: 'en',
      },
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.count, 1)
    assert.match(payload.filename, /\.json$/)
    const parsed = JSON.parse(payload.content)
    assert.equal(parsed.sessions[0].turns[0].tools[0].result.text, 'file content')
  })
})

await test('POST /export validates empty selection and empty content options', async () => {
  await withTempHome(async (home) => {
    const services = {
      sessions: { get: () => undefined, list: () => [] },
      sessionPersistence: { list: async () => [] },
    }
    const handler = __internal.createHandler({
      service: (name) => services[name],
      home,
      logger: { warn() {}, info() {} },
    })
    const empty = await request(handler, {
      method: 'POST',
      url: '/api/dsh-session-export/export',
      body: { ids: [] },
    })
    assert.equal(empty.status, 400)

    const noContent = await request(handler, {
      method: 'POST',
      url: '/api/dsh-session-export/export',
      body: {
        ids: [SESSION_ID],
        options: { user: false, assistant: false, reasoning: false, tools: false, system: false },
      },
    })
    assert.equal(noContent.status, 400)
  })
})

await test('apply waits for webServer and registers the prefix route', async () => {
  let route
  const services = {
    sessions: { get: () => undefined, list: () => [] },
    sessionPersistence: { list: async () => [] },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => services[name],
    inject: (names, callback) => {
      assert.deepEqual(names, ['webServer'])
      const cleanups = []
      callback({
        webServer: {
          register: (registration) => {
            route = registration
          },
        },
        get: (name) => (name === 'webServer' ? { register: () => {} } : undefined),
        effect: (fn) => {
          cleanups.push(fn())
        },
      })
      return () => cleanups.forEach((cleanup) => cleanup?.())
    },
  }
  apply(ctx, {})
  assert.equal(route?.kind, 'prefix')
  assert.equal(route?.path, '/api/dsh-session-export')
  assert.equal(typeof route?.handler, 'function')
})

await test('client bundle registers exactly one settings section and has matching locales', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  let definition
  const windowStub = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(windowStub)
  assert.equal(definition?.id, 'dsh-session-export')

  const React = {
    createElement: (...args) => ({ args }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const mod = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected client require: ${name}`)
  })
  assert.equal(mod.name, 'dsh-session-export')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(mod.__test.DICT.zh.nav, '会话导出')
  assert.equal(mod.__test.DICT.en.nav, 'Session export')
  assert.deepEqual(Object.keys(mod.__test.DICT.zh).sort(), Object.keys(mod.__test.DICT.en).sort())

  let registration
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: () => {},
    },
    effect: (fn) => {
      fn()
    },
    slots: {
      inject: (slotName, callback) => {
        assert.equal(slotName, 'settings.section')
        callback()
      },
      register: (config, component) => {
        registration = { config, component }
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.equal(registration?.config.name, 'settings.section')
  assert.equal(registration?.config.id, 'dsh-session-export')
  assert.equal(registration?.config.order, 37)
  assert.equal(registration?.config.locale, 'dshSessionExport')
  assert.equal(registration?.config.label(), 'nav')
  assert.equal(typeof registration?.component, 'function')
})

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log(`dsh-session-export: ${passing.length} smoke tests passed`)
}
