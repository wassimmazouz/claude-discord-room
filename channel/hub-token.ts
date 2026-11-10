// Where the hub's bot token comes from. The hub's bot can be a dedicated one that is not an
// agent in room.config.json, so the per-bot agents keep their own bots.
// Order: ROOM_HUB_TOKEN in the environment, then bot_token_file, then the bot_agent's token.
// The token is returned to the caller and never logged.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type TokenInput = {
  envToken?: string
  /** Contents of bot_token_file, when the config names one and it exists. */
  fileToken?: string
  botAgent?: string
  roomAgents?: readonly { name: string; token?: string }[]
}

export function pickBotToken(i: TokenInput): { token: string; source: 'env' | 'file' | 'agent' } {
  const env = i.envToken?.trim()
  if (env) return { token: env, source: 'env' }
  const file = i.fileToken?.trim()
  if (file) return { token: file, source: 'file' }
  const agent = i.botAgent ? i.roomAgents?.find(a => a.name === i.botAgent)?.token?.trim() : undefined
  if (agent) return { token: agent, source: 'agent' }
  throw new Error('no bot token: set ROOM_HUB_TOKEN, or bot_token_file or bot_agent in hub.config.json')
}

/** Reads the sources from disk. `kit` is the folder holding room.config.json. */
export function loadBotToken(kit: string, cfgPath: string): { token: string; source: 'env' | 'file' | 'agent' } {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { bot_agent?: string; bot_token_file?: string }
  let fileToken: string | undefined
  if (cfg.bot_token_file) {
    const f = resolve(dirname(cfgPath), cfg.bot_token_file)
    if (existsSync(f)) {
      if (statSync(f).mode & 0o077) throw new Error(`${f} is readable by others; run chmod 600 on it`)
      fileToken = readFileSync(f, 'utf8')
    }
  }
  const roomPath = join(kit, 'room.config.json')
  const roomAgents = cfg.bot_agent && existsSync(roomPath) ? JSON.parse(readFileSync(roomPath, 'utf8')).agents : undefined
  return pickBotToken({ envToken: process.env.ROOM_HUB_TOKEN, fileToken, botAgent: cfg.bot_agent, roomAgents })
}
