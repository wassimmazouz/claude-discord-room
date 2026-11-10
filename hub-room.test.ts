import { describe, expect, test } from 'bun:test'
import { movesTo } from './hub-prompts'

const trust = ` Quick safety check\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel`

describe('movesTo', () => {
  test('counts lines down to the wanted option', () => {
    expect(movesTo(trust, 'Yes, I trust this folder')).toBe(1)
  })
  test('is zero when the cursor is already on it', () => {
    expect(movesTo(` No, exit\n ❯ Yes, I trust this folder`, 'Yes, I trust this folder')).toBe(0)
  })
  test('counts upward too', () => {
    expect(movesTo(`   1. I am using this for local development\n ❯ 2. Exit`, 'I am using this for local development')).toBe(-1)
  })
  test('is undefined without the option or without a cursor', () => {
    expect(movesTo(trust, 'I am using this for local development')).toBeUndefined()
    expect(movesTo(`   Yes, I trust this folder`, 'Yes, I trust this folder')).toBeUndefined()
  })
})
