#!/usr/bin/env bun
// Prints, for each room channel, whether an agent's bot has the permissions the hub needs.
// Reads the token from room.config.json in-process and never prints it.
// Usage (from the kit folder): bun channel/check-perms.ts <agent-name|hub> [extra-channel-id...]
// "hub" checks the hub's own bot (see hub-token.ts; HUB_CONFIG overrides ./hub.config.json).

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadBotToken } from './hub-token'
import { Client, GatewayIntentBits, PermissionFlagsBits, type GuildChannel } from 'discord.js'

// Run from the kit folder that holds room.config.json.
const roomPath = join(process.cwd(), 'room.config.json')
const config = existsSync(roomPath) ? JSON.parse(readFileSync(roomPath, 'utf8')) : {}
const name = process.argv[2]
const token: string | undefined =
  name === 'hub'
    ? loadBotToken(process.cwd(), resolve(process.cwd(), process.env.HUB_CONFIG ?? 'hub.config.json')).token
    : config.agents?.find((a: { name: string }) => a.name === name)?.token
if (!token) {
  console.error(`No agent named "${name}" in room.config.json.`)
  process.exit(1)
}
const channels: string[] = [...(config.channel_id ? [config.channel_id] : []), ...(config.rooms ?? []).map((r: { channel_id: string }) => r.channel_id), ...process.argv.slice(3)]

const NEEDED = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  ManageWebhooks: PermissionFlagsBits.ManageWebhooks,
} as const

const client = new Client({ intents: [GatewayIntentBits.Guilds] })
client.once('clientReady', async c => {
  console.log(`Bot: ${c.user.tag}`)
  for (const id of channels) {
    try {
      const ch = (await c.channels.fetch(id)) as GuildChannel | null
      const perms = ch?.permissionsFor(c.user.id)
      const row = Object.entries(NEEDED).map(([k, bit]) => `${k}=${perms?.has(bit) ? 'yes' : 'NO'}`)
      console.log(`#${ch?.name ?? id}: ${row.join('  ')}`)
    } catch (e) {
      console.log(`${id}: can't fetch (${(e as Error).message})`)
    }
  }
  await c.destroy()
})
client.login(token).catch(e => {
  console.error(`Login failed: ${(e as Error).message}`)
  process.exit(1)
})
