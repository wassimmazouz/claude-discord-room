import { describe, expect, test } from 'bun:test'
import { memoryProblem, secretIn } from './memory-guard'

describe('memoryProblem', () => {
  test('allows ordinary notes', () => {
    expect(memoryProblem('a.md', 'Bun needs its PATH set in .bashrc on Ubuntu.', [])).toBeNull()
  })

  test('rejects anything but markdown', () => {
    expect(memoryProblem('a.sh', 'echo hi', [])).toContain('.md')
  })

  test('rejects large files', () => {
    expect(memoryProblem('a.md', 'x'.repeat(100_001), [])).toContain('100 KB')
  })

  test('rejects a known token', () => {
    expect(memoryProblem('a.md', 'value abc123 here', ['abc123'])).toContain('bot tokens')
  })

  test('ignores an empty known secret', () => {
    expect(memoryProblem('a.md', 'text', [''])).toBeNull()
  })

  test('rejects common secret formats', () => {
    const samples = [
      'M' + 'a'.repeat(23) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(27),
      'ghp_' + 'a'.repeat(36),
      'github_pat_' + 'a'.repeat(30),
      'sk-' + 'a'.repeat(30),
      'AKIA' + 'A'.repeat(16),
      'xoxb-' + '1'.repeat(12),
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]
    for (const s of samples) expect(memoryProblem('a.md', `note ${s}`, [])).not.toBeNull()
  })

  test('never repeats the secret in its message', () => {
    expect(memoryProblem('a.md', 'value abc123', ['abc123'])).not.toContain('abc123')
  })
})

describe('secretIn', () => {
  test('passes ordinary text', () => {
    expect(secretIn('Shipped the fix, tests pass.', ['abc123'])).toBeNull()
  })
  test('catches a known secret and a webhook URL', () => {
    expect(secretIn('here: abc123', ['abc123'])).toContain('room secrets')
    expect(secretIn('https://discord.com/api/webhooks/123456789/' + 'x'.repeat(40), [])).toContain('webhook URL')
  })
  test('ignores empty known secrets', () => {
    expect(secretIn('anything', [''])).toBeNull()
  })
})
