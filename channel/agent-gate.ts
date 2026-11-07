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
 * In a hearEverything room the agent receives every message from allowed senders.
 */
export function mustBeMentioned(
  requireMention: boolean,
  userMentions: number,
  roleMentions: number,
  hearEverything = false,
): boolean {
  if (hearEverything) return false
  return requireMention || userMentions > 0 || roleMentions > 0
}

export type Room = {
  channel_id: string
  /** Other people's bots, allowed in this room only. */
  guest_bots?: string[]
  /** Other people, allowed in this room only. They can talk to agents but never instruct them. */
  guest_users?: string[]
  /** Receive every message from allowed senders, even ones that mention someone else. */
  hear_everything?: boolean
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
  mainChannel: string | null,
  mainRequireMention: boolean,
  rooms: Room[],
) {
  const groups: Record<string, { requireMention: boolean; hearEverything: boolean; allowFrom: string[] }> = {}
  if (mainChannel) {
    groups[mainChannel] = { requireMention: mainRequireMention, hearEverything: false, allowFrom: [owner, ...ownBots] }
  }
  for (const r of rooms) {
    groups[r.channel_id] = {
      requireMention: !r.hear_everything && (r.require_mention ?? true),
      hearEverything: r.hear_everything ?? false,
      allowFrom: [owner, ...ownBots, ...(r.guest_bots ?? []), ...(r.guest_users ?? [])],
    }
  }
  return { groups, allowBots: [...new Set([...ownBots, ...rooms.flatMap(r => r.guest_bots ?? [])])] }
}

export type MemberCard = { room: string; people: string[]; bots: string[] }

const DISCORD_ID = /^\d{15,25}$/

/** Reads a card from bun room.ts card. Returns null unless it's well formed. */
export function parseCard(text: string): MemberCard | null {
  let card: Partial<MemberCard>
  try {
    card = JSON.parse(text)
  } catch {
    return null
  }
  const ids = (v: unknown) => Array.isArray(v) && v.every(id => typeof id === 'string' && DISCORD_ID.test(id))
  if (typeof card?.room !== 'string' || !DISCORD_ID.test(card.room)) return null
  if (!ids(card.people) || !ids(card.bots)) return null
  return { room: card.room, people: card.people!, bots: card.bots! }
}

/**
 * Adds a card's members to a room, creating it if needed. New rooms hear everything,
 * so members can talk like regular users. Your own IDs are skipped.
 */
export function addMembers(rooms: Room[], card: MemberCard, ownIds: string[]) {
  const existing = rooms.find(r => r.channel_id === card.room)
  const room: Room = existing ?? { channel_id: card.room, guest_bots: [], guest_users: [], hear_everything: true }
  const fresh = (ids: string[], known: string[] = []) =>
    [...new Set(ids)].filter(id => !ownIds.includes(id) && !known.includes(id))
  const people = fresh(card.people, room.guest_users)
  const bots = fresh(card.bots, room.guest_bots)
  const updated = {
    ...room,
    guest_users: [...(room.guest_users ?? []), ...people],
    guest_bots: [...(room.guest_bots ?? []), ...bots],
  }
  return {
    rooms: existing ? rooms.map(r => (r === existing ? updated : r)) : [...rooms, updated],
    people,
    bots,
  }
}

/** Only the owner can restart a paused room, so a guest can't keep agents running on their allowance. */
export function canRestartRoom(authorId: string, authorIsBot: boolean, ownerAllowFrom: string[]): boolean {
  return !authorIsBot && ownerAllowFrom.includes(authorId)
}

/** Only a human on the top-level allowlist may answer a permission prompt. */
export function canAnswerPermission(
  authorId: string,
  authorIsBot: boolean,
  ownerAllowFrom: string[],
): boolean {
  return !authorIsBot && ownerAllowFrom.includes(authorId)
}
