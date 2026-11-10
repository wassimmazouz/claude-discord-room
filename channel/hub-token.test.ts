import { describe, expect, test } from 'bun:test'
import { pickBotToken } from './hub-token'

const roomAgents = [{ name: 'ada', token: 'agent-tok' }, { name: 'empty' }]

describe('pickBotToken', () => {
  test('environment wins over file and agent', () => {
    expect(pickBotToken({ envToken: ' env-tok\n', fileToken: 'file-tok', botAgent: 'ada', roomAgents })).toEqual({ token: 'env-tok', source: 'env' })
  })
  test('file wins over agent, and is trimmed', () => {
    expect(pickBotToken({ fileToken: 'file-tok\n', botAgent: 'ada', roomAgents })).toEqual({ token: 'file-tok', source: 'file' })
  })
  test('falls back to the named agent', () => {
    expect(pickBotToken({ envToken: '', fileToken: '  ', botAgent: 'ada', roomAgents })).toEqual({ token: 'agent-tok', source: 'agent' })
  })
  test('a dedicated bot needs no agent entry', () => {
    expect(pickBotToken({ envToken: 'env-tok' }).source).toBe('env')
  })
  test('throws when nothing provides a token, without naming one', () => {
    expect(() => pickBotToken({ botAgent: 'empty', roomAgents })).toThrow(/no bot token/)
    expect(() => pickBotToken({ botAgent: 'ghost', roomAgents })).toThrow(/no bot token/)
    expect(() => pickBotToken({})).toThrow(/no bot token/)
  })
})
