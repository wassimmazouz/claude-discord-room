// Routing rules for the room hub: one Discord bot carries several agents, each posting
// through a webhook under its own name. Pure functions, so they can be tested without Discord.

/** Which agent sent each webhook message. The display name is never trusted, only this record. */
export class AgentLedger {
  private byMessage = new Map<string, string>()
  private order: string[] = []

  constructor(
    private readonly webhookIds: ReadonlySet<string>,
    private readonly cap = 5000,
  ) {}

  /** Call right after the hub posts a message for `agent`. */
  record(messageId: string, agent: string): void {
    if (!this.byMessage.has(messageId)) this.order.push(messageId)
    this.byMessage.set(messageId, agent)
    while (this.order.length > this.cap) this.byMessage.delete(this.order.shift()!)
  }

  /** The agent behind a message, or undefined when it isn't one of ours. */
  agentOf(messageId: string, webhookId: string | null | undefined): string | undefined {
    if (!webhookId || !this.webhookIds.has(webhookId)) return undefined
    return this.byMessage.get(messageId)
  }
}

/** Agents addressed by a text handle such as "@cto" or "@Ada". Names are lowercase [a-z0-9-]. */
export function handlesIn(content: string, agents: readonly string[]): string[] {
  const found = new Set<string>()
  for (const m of content.matchAll(/(^|[^\w@])@([a-z0-9-]{1,30})(?![\w-])/gi)) {
    const name = m[2]!.toLowerCase()
    if (agents.includes(name)) found.add(name)
  }
  return agents.filter(a => found.has(a))
}

export type Author =
  | { kind: 'owner' } // a human on the room's owner allowlist
  | { kind: 'human' } // another allowed human, such as a guest
  | { kind: 'agent'; name: string } // one of our agents, identified by the ledger
  | { kind: 'other' } // anyone or anything else

export type RouteInput = {
  author: Author
  content: string
  /** Agents in this channel. */
  agents: readonly string[]
  /** The agent whose message this one replies to, if any. */
  repliesTo?: string
  /** Real Discord user or role mentions in the message (people, not agents). */
  userMentions: number
  requireMention: boolean
  hearEverything: boolean
}

/**
 * Who receives a message. Mirrors the per-bot kit: a message addressed to someone goes only to
 * them; an unaddressed one goes to everyone unless the room requires a mention. An agent
 * never receives its own message, and unknown senders reach no one.
 */
export function recipients(r: RouteInput): string[] {
  if (r.author.kind === 'other') return []
  const self = r.author.kind === 'agent' ? r.author.name : undefined
  const addressed = new Set(handlesIn(r.content, r.agents))
  if (r.repliesTo && r.agents.includes(r.repliesTo)) addressed.add(r.repliesTo)

  let out: string[]
  if (r.hearEverything) out = [...r.agents]
  else if (addressed.size > 0) out = r.agents.filter(a => addressed.has(a))
  else if (r.userMentions > 0 || r.requireMention) out = []
  else out = [...r.agents]
  return out.filter(a => a !== self)
}

/**
 * Counts agent messages since the owner last spoke in each channel. At the limit, agent
 * messages stop being delivered until the owner speaks; the hub posts one pause notice.
 */
export class HubHopLimiter {
  private counts = new Map<string, number>()

  constructor(private readonly maxHops: number) {}

  observe(channelId: string, author: Author): 'deliver' | 'drop' | 'announce_pause' {
    if (author.kind === 'owner') {
      this.counts.set(channelId, 0)
      return 'deliver'
    }
    if (author.kind !== 'agent') return 'deliver'
    const count = (this.counts.get(channelId) ?? 0) + 1
    this.counts.set(channelId, count)
    if (count < this.maxHops) return 'deliver'
    return count === this.maxHops ? 'announce_pause' : 'drop'
  }
}

/**
 * Holds messages for agents that aren't connected, so a restart doesn't lose them. In memory
 * only: a hub restart empties it. Old messages are dropped rather than delivered late.
 */
export class Mailbox<T> {
  private held = new Map<string, { at: number; item: T }[]>()

  constructor(
    private readonly cap = 50,
    private readonly maxAgeMs = 6 * 60 * 60 * 1000,
  ) {}

  hold(agent: string, item: T, now: number): void {
    const q = this.held.get(agent) ?? []
    q.push({ at: now, item })
    while (q.length > this.cap) q.shift()
    this.held.set(agent, q)
  }

  /** Returns what's waiting for `agent`, oldest first, and forgets it. */
  take(agent: string, now: number): T[] {
    const q = this.held.get(agent) ?? []
    this.held.delete(agent)
    return q.filter(e => now - e.at <= this.maxAgeMs).map(e => e.item)
  }

  size(agent: string): number {
    return this.held.get(agent)?.length ?? 0
  }
}

/**
 * Why the hub refuses to attach `path` to an agent's message, or null if it may. The hub can read
 * the bot token, webhooks and agent secrets, so an agent must not be able to post them by naming
 * them as attachments. `path` must already be resolved through symlinks (realpath).
 * `blocked` are files or folders that never leave; `allowed` are folders inside them that may,
 * such as the agent's own download inbox.
 */
export function attachmentProblem(path: string, blocked: readonly string[], allowed: readonly string[]): string | null {
  const inside = (root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
  if (allowed.some(inside)) return null
  if (blocked.some(inside)) return `${path} is a private room file and can't be sent`
  if (/(^|\/)\.env(\.|$)/.test(path)) return `${path} looks like an environment file and can't be sent`
  return null
}

/**
 * Turns text handles into real Discord mentions for agents that run on their own bot, so a
 * hub agent writing "@ada" wakes that bot. Other handles are left as they are.
 */
export function withBotMentions(content: string, botIds: Readonly<Record<string, string>>): string {
  return content.replace(/(^|[^\w@])@([a-z0-9-]{1,30})(?![\w-])/gi, (whole, before: string, name: string) => {
    const id = botIds[name.toLowerCase()]
    return id ? `${before}<@${id}>` : whole
  })
}
