#!/usr/bin/env bun
// Setup helpers for the room hub. Reads the bot token from room.config.json in-process and never prints it.
// <agent> is an agent in room.config.json, or "hub" for the hub's own bot (see hub-token.ts;
// set HUB_CONFIG to use a config other than ./hub.config.json).
// Usage (from the kit folder):
//   bun channel/hub-admin.ts <agent> create-channel <name> [category-or-sibling-channel-id]
//   bun channel/hub-admin.ts <agent> create-webhook <channel-id> <out-file>
// create-webhook writes the webhook URL (a secret) to <out-file> with mode 0600 and prints only its id.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadBotToken } from './hub-token'
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, type TextChannel } from 'discord.js'

const roomPath = join(process.cwd(), 'room.config.json')
const config = existsSync(roomPath) ? JSON.parse(readFileSync(roomPath, 'utf8')) : {}
const [agentName, cmd, ...args] = process.argv.slice(2)
const token: string | undefined =
  agentName === 'hub'
    ? loadBotToken(process.cwd(), resolve(process.cwd(), process.env.HUB_CONFIG ?? 'hub.config.json')).token
    : config.agents?.find((a: { name: string }) => a.name === agentName)?.token
if (!token) {
  console.error(`No agent named "${agentName}" in room.config.json.`)
  process.exit(1)
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

async function run(): Promise<void> {
  if (cmd === 'create-channel') {
    // The new channel goes next to the room's main channel, which the bot must be able to see.
    if (!config.channel_id) throw new Error('create-channel needs channel_id in room.config.json.')
    const main = (await client.channels.fetch(config.channel_id)) as TextChannel
    const guild = main.guild
    const me = await guild.members.fetchMe()
    const [name] = args
    if (!name || !/^[a-z0-9-]{1,90}$/.test(name)) throw new Error('Give a lowercase channel name.')
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('The bot lacks Manage Channels on this server.')
    const existing = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText)
    if (existing) {
      console.log(`exists: #${existing.name} ${existing.id}`)
      return
    }
    const ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: main.parentId ?? undefined })
    console.log(`created: #${ch.name} ${ch.id}`)
    return
  }

  if (cmd === 'create-webhook') {
    const [channelId, outFile] = args
    if (!channelId || !outFile) throw new Error('Usage: create-webhook <channel-id> <out-file>')
    const ch = (await client.channels.fetch(channelId)) as TextChannel
    const hooks = await ch.fetchWebhooks()
    const hook = hooks.find(h => h.owner?.id === client.user!.id && h.name === 'room-hub') ?? (await ch.createWebhook({ name: 'room-hub' }))
    writeFileSync(outFile, JSON.stringify({ channel_id: channelId, id: hook.id, url: hook.url }) + '\n', { mode: 0o600 })
    console.log(`webhook: ${hook.id} (url saved to ${outFile})`)
    return
  }

  throw new Error(`Unknown command "${cmd}".`)
}

client.once('clientReady', () => {
  run()
    .catch(e => {
      console.error(`error: ${(e as Error).message}`)
      process.exitCode = 1
    })
    .finally(() => client.destroy())
})
client.login(token).catch(e => {
  console.error(`Login failed: ${(e as Error).message}`)
  process.exit(1)
})
