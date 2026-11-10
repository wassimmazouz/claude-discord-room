import { describe, expect, test } from 'bun:test'
import { AgentLedger, attachmentProblem, HubHopLimiter, Mailbox, handlesIn, recipients, withBotMentions, type RouteInput } from './hub-core'

const AGENTS = ['ada', 'cto', 'coo'] as const

const base = (extra: Partial<RouteInput> = {}): RouteInput => ({
  author: { kind: 'owner' },
  content: 'hello',
  agents: AGENTS,
  userMentions: 0,
  requireMention: false,
  hearEverything: false,
  ...extra,
})

describe('handlesIn', () => {
  test('finds handles, case-insensitive, in agent order', () => {
    expect(handlesIn('@COO and @ada please', AGENTS)).toEqual(['ada', 'coo'])
  })
  test('ignores unknown names, emails and handles inside words', () => {
    expect(handlesIn('mail me@cto.dev or @ctox or x@coo', AGENTS)).toEqual([])
  })
  test('accepts punctuation after a handle', () => {
    expect(handlesIn('thanks @cto, then @coo.', AGENTS)).toEqual(['cto', 'coo'])
  })
})

describe('recipients', () => {
  test('an unaddressed message reaches every agent when mentions are not required', () => {
    expect(recipients(base())).toEqual([...AGENTS])
  })
  test('an addressed message reaches only those addressed', () => {
    expect(recipients(base({ content: '@cto can you review?' }))).toEqual(['cto'])
  })
  test('a reply to an agent reaches that agent', () => {
    expect(recipients(base({ repliesTo: 'coo' }))).toEqual(['coo'])
  })
  test('a message that mentions only a person reaches no agent', () => {
    expect(recipients(base({ userMentions: 1 }))).toEqual([])
  })
  test('require_mention silences unaddressed messages', () => {
    expect(recipients(base({ requireMention: true }))).toEqual([])
    expect(recipients(base({ requireMention: true, content: '@ada hi' }))).toEqual(['ada'])
  })
  test('hear_everything delivers to all, still not to the author', () => {
    expect(recipients(base({ hearEverything: true, author: { kind: 'agent', name: 'cto' }, userMentions: 2 }))).toEqual([
      'ada',
      'coo',
    ])
  })
  test('an agent never receives its own message, even when it names itself', () => {
    expect(recipients(base({ author: { kind: 'agent', name: 'cto' }, content: '@cto @coo sync' }))).toEqual(['coo'])
  })
  test('unknown senders reach no one', () => {
    expect(recipients(base({ author: { kind: 'other' }, content: '@ada hi' }))).toEqual([])
  })
})

describe('AgentLedger', () => {
  const ledger = () => new AgentLedger(new Set(['hook-1']), 3)

  test('identifies an agent only through our webhook and a recorded message', () => {
    const l = ledger()
    l.record('m1', 'cto')
    expect(l.agentOf('m1', 'hook-1')).toBe('cto')
    expect(l.agentOf('m1', 'someone-elses-hook')).toBeUndefined()
    expect(l.agentOf('m1', null)).toBeUndefined()
    expect(l.agentOf('m2', 'hook-1')).toBeUndefined() // our webhook, but not a message we posted
  })

  test('forgets the oldest messages past its cap', () => {
    const l = ledger()
    for (const id of ['a', 'b', 'c', 'd']) l.record(id, 'coo')
    expect(l.agentOf('a', 'hook-1')).toBeUndefined()
    expect(l.agentOf('d', 'hook-1')).toBe('coo')
  })
})

describe('HubHopLimiter', () => {
  test('pauses agents at the limit and resets when the owner speaks', () => {
    const h = new HubHopLimiter(3)
    const agent = { kind: 'agent', name: 'cto' } as const
    expect(h.observe('c', agent)).toBe('deliver')
    expect(h.observe('c', agent)).toBe('deliver')
    expect(h.observe('c', agent)).toBe('announce_pause')
    expect(h.observe('c', agent)).toBe('drop')
    expect(h.observe('other-channel', agent)).toBe('deliver')
    expect(h.observe('c', { kind: 'human' })).toBe('deliver')
    expect(h.observe('c', agent)).toBe('drop') // only the owner restarts the room
    expect(h.observe('c', { kind: 'owner' })).toBe('deliver')
    expect(h.observe('c', agent)).toBe('deliver')
  })
})

describe('Mailbox', () => {
  test('returns held messages oldest first, once', () => {
    const m = new Mailbox<string>()
    m.hold('cto', 'a', 1)
    m.hold('cto', 'b', 2)
    m.hold('coo', 'c', 3)
    expect(m.take('cto', 10)).toEqual(['a', 'b'])
    expect(m.take('cto', 10)).toEqual([])
    expect(m.size('coo')).toBe(1)
  })
  test('keeps only the newest when over the cap', () => {
    const m = new Mailbox<number>(2)
    for (const n of [1, 2, 3]) m.hold('cto', n, n)
    expect(m.take('cto', 10)).toEqual([2, 3])
  })
  test('drops messages older than the limit', () => {
    const m = new Mailbox<string>(50, 1000)
    m.hold('cto', 'old', 0)
    m.hold('cto', 'fresh', 900)
    expect(m.take('cto', 1500)).toEqual(['fresh'])
  })
})

describe('withBotMentions', () => {
  const ids = { ada: '123' }
  test('replaces only handles of agents that have their own bot', () => {
    expect(withBotMentions('@ada and @cto: done. Thanks @Ada.', ids)).toBe('<@123> and @cto: done. Thanks <@123>.')
  })
  test('leaves emails and longer names alone', () => {
    expect(withBotMentions('a@ada.dev @adaary x@ada', ids)).toBe('a@ada.dev @adaary x@ada')
  })
})

describe('attachmentProblem', () => {
  const blocked = ['/kit/state', '/kit/room.config.json', '/kit/hub.config.json']
  const allowed = ['/kit/state/hub/inbox/cto']
  test('allows ordinary files', () => {
    expect(attachmentProblem('/home/me/room/hub/cto/report.pdf', blocked, allowed)).toBeNull()
  })
  test('refuses the bot token, webhooks, secrets and configs', () => {
    for (const p of ['/kit/state/hub/bot-token', '/kit/state/hub/webhook-board.json', '/kit/state/hub/secrets/coo', '/kit/room.config.json'])
      expect(attachmentProblem(p, blocked, allowed)).toContain("can't be sent")
  })
  test("allows the agent's own inbox but not another agent's", () => {
    expect(attachmentProblem('/kit/state/hub/inbox/cto/1-a.png', blocked, allowed)).toBeNull()
    expect(attachmentProblem('/kit/state/hub/inbox/coo/1-a.png', blocked, allowed)).toContain("can't be sent")
  })
  test('does not confuse a sibling folder with a blocked one', () => {
    expect(attachmentProblem('/kit/state-notes/a.md', blocked, allowed)).toBeNull()
  })
  test('refuses environment files anywhere', () => {
    expect(attachmentProblem('/home/me/project/.env', [], [])).toContain('environment file')
    expect(attachmentProblem('/home/me/project/.env.local', [], [])).toContain('environment file')
    expect(attachmentProblem('/home/me/project/env.md', [], [])).toBeNull()
  })
})
