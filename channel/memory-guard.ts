// Checks a shared memory file before it leaves this computer.
// A safety net for obvious mistakes. It can't recognize private information in general.

const MAX_BYTES = 100_000

const SECRET_PATTERNS: [RegExp, string][] = [
  [/[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/, 'a Discord token'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, 'a GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
]

/** Returns why this file can't be shared, or null if it can. Never includes the file's content. */
export function memoryProblem(path: string, text: string, knownSecrets: string[]): string | null {
  if (!path.endsWith('.md')) return 'only .md files can be shared'
  if (text.length > MAX_BYTES) return 'it is larger than 100 KB'
  if (knownSecrets.some(s => s && text.includes(s))) return 'it contains one of your bot tokens'
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) return `it looks like it contains ${label}`
  }
  return null
}
