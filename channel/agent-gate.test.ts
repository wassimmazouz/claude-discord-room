import { describe, expect, test } from 'bun:test'
import { BotHopLimiter, canAnswerPermission, mustBeMentioned, roomAccess, type Observation } from './agent-gate'

const HUMAN = 'human'
const A = 'bot-a'
const B = 'bot-b'

function from(authorId: string, selfId: string, extra: Partial<Observation> = {}): Observation {
  return {
    channelId: 'room',
    authorId,
    authorIsBot: authorId !== HUMAN && authorId !== 'stranger',
    selfId,
    inGuild: true,
    allowedBots: [A, B].filter(id => id !== selfId),
    maxHops: 4,
    trustedHuman: authorId === HUMAN,
    ...extra,
  }
}

describe('BotHopLimiter', () => {
  test('delivers human messages', () => {
    expect(new BotHopLimiter().observe(from(HUMAN, A))).toBe('deliver')
  })

  test('delivers an allowlisted agent but never echoes its own message', () => {
    const l = new BotHopLimiter()
    expect(l.observe(from(B, A))).toBe('deliver')
    expect(l.observe(from(A, A))).toBe('drop')
  })

  test('drops bots that are not allowlisted, without counting them', () => {
    const l = new BotHopLimiter()
    for (let i = 0; i < 10; i++) expect(l.observe(from('other-bot', A))).toBe('drop')
    expect(l.observe(from(B, A))).toBe('deliver')
  })

  test('drops agent DMs', () => {
    expect(new BotHopLimiter().observe(from(B, A, { inGuild: false }))).toBe('drop')
  })

  test('two agents stop at the limit and exactly one announces it', () => {
    const a = new BotHopLimiter()
    const b = new BotHopLimiter()
    const log: string[] = []
    for (let i = 1; i <= 8; i++) {
      const author = i % 2 ? A : B
      log.push(`${a.observe(from(author, A))}/${b.observe(from(author, B))}`)
    }
    expect(log).toEqual([
      'drop/deliver',
      'deliver/drop',
      'drop/deliver',
      'drop/announce_pause',
      'drop/drop',
      'drop/drop',
      'drop/drop',
      'drop/drop',
    ])
  })

  test('a trusted human restarts a paused room, an untrusted one cannot', () => {
    const l = new BotHopLimiter()
    for (let i = 0; i < 6; i++) l.observe(from(B, A))
    expect(l.observe(from(B, A))).toBe('drop')
    l.observe(from('stranger', A))
    expect(l.observe(from(B, A))).toBe('drop')
    l.observe(from(HUMAN, A))
    expect(l.observe(from(B, A))).toBe('deliver')
  })

  test('channels are counted separately', () => {
    const l = new BotHopLimiter()
    for (let i = 0; i < 6; i++) l.observe(from(B, A))
    expect(l.observe(from(B, A, { channelId: 'thread' }))).toBe('deliver')
  })
})

describe('mustBeMentioned', () => {
  test('a message with no mention goes to everyone', () => {
    expect(mustBeMentioned(false, 0, 0)).toBe(false)
  })

  test('a user mention limits delivery to those mentioned', () => {
    expect(mustBeMentioned(false, 1, 0)).toBe(true)
  })

  test('a role mention limits delivery to those mentioned', () => {
    expect(mustBeMentioned(false, 0, 1)).toBe(true)
  })

  test('requireMention always needs a mention', () => {
    expect(mustBeMentioned(true, 0, 0)).toBe(true)
    expect(mustBeMentioned(true, 1, 1)).toBe(true)
  })
})

describe('roomAccess', () => {
  const rooms = [{ channel_id: 'shared', guest_bots: ['guest'] }]

  test('guest bots are allowed in their room and not in the main channel', () => {
    const { groups } = roomAccess(HUMAN, [B], 'main', false, rooms)
    expect(groups.shared!.allowFrom).toEqual([HUMAN, B, 'guest'])
    expect(groups.main!.allowFrom).toEqual([HUMAN, B])
  })

  test('shared rooms need a mention unless the config says otherwise', () => {
    expect(roomAccess(HUMAN, [B], 'main', false, rooms).groups.shared!.requireMention).toBe(true)
    const open = [{ channel_id: 'shared', require_mention: false }]
    expect(roomAccess(HUMAN, [B], 'main', false, open).groups.shared!.requireMention).toBe(false)
    expect(roomAccess(HUMAN, [B], 'main', false, rooms).groups.main!.requireMention).toBe(false)
  })

  test('guests are visible to the loop limiter, once each', () => {
    const twice = [...rooms, { channel_id: 'other', guest_bots: ['guest'] }]
    expect(roomAccess(HUMAN, [B], 'main', false, twice).allowBots).toEqual([B, 'guest'])
  })

  test('with no rooms, only the main channel exists', () => {
    const { groups, allowBots } = roomAccess(HUMAN, [B], 'main', false, [])
    expect(Object.keys(groups)).toEqual(['main'])
    expect(allowBots).toEqual([B])
  })

  test('a guest can never answer a permission prompt', () => {
    expect(canAnswerPermission('guest', true, [HUMAN])).toBe(false)
  })
})

describe('canAnswerPermission', () => {
  test('only the owner can approve', () => {
    expect(canAnswerPermission(HUMAN, false, [HUMAN])).toBe(true)
    expect(canAnswerPermission(B, true, [HUMAN])).toBe(false)
    expect(canAnswerPermission(B, true, [B])).toBe(false)
    expect(canAnswerPermission('stranger', false, [HUMAN])).toBe(false)
  })
})
