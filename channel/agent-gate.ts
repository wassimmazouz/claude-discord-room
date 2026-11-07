// Multi-agent rules added to the official Discord channel plugin.
// Decides what happens to a Discord message before the normal access gate runs.

export type Observation = {
  channelId: string
  authorId: string
  authorIsBot: boolean
  selfId: string | undefined
  inGuild: boolean
  allowedBots: string[]
  maxHops: number
  /** A human on this room's allowlist. Only they can restart a paused room. */
  trustedHuman: boolean
}

export type Decision = 'deliver' | 'drop' | 'announce_pause'

/**
 * Counts agent messages since a trusted human last spoke in each channel.
 * Reaching the limit pauses agent-to-agent delivery until that human speaks.
 * An agent's own messages count too, so every agent sees the same total and
 * exactly one of them (the author of the last allowed message) posts the notice.
 */
export class BotHopLimiter {
  private counts = new Map<string, number>()

  observe(o: Observation): Decision {
    if (!o.authorIsBot) {
      if (o.trustedHuman) this.counts.set(o.channelId, 0)
      return 'deliver' // the normal access gate still applies
    }

    if (!o.inGuild) return 'drop' // agents never talk over DMs

    const isSelf = o.authorId === o.selfId
    if (!isSelf && !o.allowedBots.includes(o.authorId)) return 'drop'

    const count = (this.counts.get(o.channelId) ?? 0) + 1
    this.counts.set(o.channelId, count)

    if (isSelf) return count === o.maxHops ? 'announce_pause' : 'drop'
    return count < o.maxHops ? 'deliver' : 'drop'
  }
}

/**
 * A message that mentions anyone goes only to those it mentions, so a mention
 * of someone else must not wake this agent. With no mentions, requireMention decides.
 */
export function mustBeMentioned(
  requireMention: boolean,
  userMentions: number,
  roleMentions: number,
): boolean {
  return requireMention || userMentions > 0 || roleMentions > 0
}

export type Room = {
  channel_id: string
  /** Other people's bots, allowed in this room only. */
  guest_bots?: string[]
  /** Defaults to true, so guests only wake an agent by mentioning it. */
  require_mention?: boolean
}

/**
 * Builds the channel allowlists. Guest bots are listed only on their own room,
 * which keeps them out of the main channel. allowBots has to include them so the
 * loop limiter counts them, but gate() still applies each channel's allowFrom.
 */
export function roomAccess(
  owner: string,
  ownBots: string[],
  mainChannel: string,
  mainRequireMention: boolean,
  rooms: Room[],
) {
  const groups: Record<string, { requireMention: boolean; allowFrom: string[] }> = {
    [mainChannel]: { requireMention: mainRequireMention, allowFrom: [owner, ...ownBots] },
  }
  for (const r of rooms) {
    groups[r.channel_id] = {
      requireMention: r.require_mention ?? true,
      allowFrom: [owner, ...ownBots, ...(r.guest_bots ?? [])],
    }
  }
  return { groups, allowBots: [...new Set([...ownBots, ...rooms.flatMap(r => r.guest_bots ?? [])])] }
}

/** Only a human on the top-level allowlist may answer a permission prompt. */
export function canAnswerPermission(
  authorId: string,
  authorIsBot: boolean,
  ownerAllowFrom: string[],
): boolean {
  return !authorIsBot && ownerAllowFrom.includes(authorId)
}
