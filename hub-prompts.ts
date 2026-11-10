// Answers a new hub session's two startup prompts, only when hub.config.json sets
// "answer_startup_prompts": true. Off by default: these prompts are Claude Code's warning that
// the session trusts its folder and loads a development channel, and normally the owner reads
// and accepts them with `tmux attach`.
// Only these two known prompts are answered, only by moving to the named option and checking the
// cursor is on it before pressing Enter. Anything else is left for the owner.

import { spawnSync } from 'node:child_process'

export const PROMPTS = ['Yes, I trust this folder', 'I am using this for local development'] as const

/** Lines to move from the cursor (❯) to the option containing `want`, or undefined if not shown. */
export function movesTo(pane: string, want: string): number | undefined {
  const lines = pane.split('\n')
  const target = lines.findIndex(l => l.includes(want))
  const cursor = lines.findIndex(l => /^\s*❯\s*\S/.test(l))
  if (target < 0 || cursor < 0) return undefined
  return target - cursor
}

const screen = (s: string) => spawnSync('tmux', ['capture-pane', '-p', '-t', `=${s}:`], { encoding: 'utf8' }).stdout ?? ''
const keys = (s: string, ...k: string[]) => spawnSync('tmux', ['send-keys', '-t', `=${s}:`, ...k])
const alive = (s: string) => spawnSync('tmux', ['has-session', '-t', `=${s}`], { stdio: 'ignore' }).status === 0

/** True once the session reaches its normal input box. */
export function answerPrompts(session: string): boolean {
  for (let i = 0; i < 120; i++) {
    if (!alive(session)) return false
    const pane = screen(session)
    const want = PROMPTS.find(p => pane.includes(p))
    if (want && pane.includes('Enter to confirm')) {
      const moves = movesTo(pane, want)
      if (moves === undefined) return false
      for (let n = 0; n < Math.abs(moves); n++) keys(session, moves > 0 ? 'Down' : 'Up')
      Bun.sleepSync(300)
      if (movesTo(screen(session), want) !== 0) return false // cursor isn't where we expect: leave it to the owner
      keys(session, 'Enter')
      Bun.sleepSync(1500)
      continue
    }
    if (/shift\+tab|\? for shortcuts/.test(pane)) return true
    Bun.sleepSync(500)
  }
  return false
}
