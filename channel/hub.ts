#!/usr/bin/env bun
// Room hub: one Discord bot carries several agents. Agents connect over a unix socket
// (hub-client.ts is their MCP channel server). The hub routes each Discord message to the
// agents it's for, and posts each agent's replies through a channel webhook under its own name.
// Usage (from the kit folder): bun channel/hub.ts [hub.config.json]

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  WebhookClient,
  type Message,
  type TextChannel,
} from 'discord.js'
import { AgentLedger, attachmentProblem, HubHopLimiter, Mailbox, recipients, withBotMentions, type Author } from './hub-core'
import { loadBotToken } from './hub-token'
import { secretIn } from './memory-guard'

type HubChannel = {
  channel_id: string
  webhook_file: string
  require_mention?: boolean
  hear_everything?: boolean
  /** Allowed humans besides the owners. They can talk to agents but never restart a paused room. */
  guests?: string[]
}
type HubAgent = {
  name: string
  display_name?: string
  avatar_url?: string
  channels?: string[]
  /** This agent runs on its own Discord bot (the per-bot room). Its bot's messages count as its
   * own, handles for it become real mentions, and it receives through its bot, not the hub. */
  discord_bot_id?: string
}
type HubConfig = {
  /** Token source, see hub-token.ts: ROOM_HUB_TOKEN, then bot_token_file, then this agent's token. */
  bot_agent?: string
  bot_token_file?: string
  owners: string[]
  socket: string
  secrets_dir: string
  inbox_dir: string
  ledger_file: string
  max_hops?: number
  channels: HubChannel[]
  agents: HubAgent[]
}

const KIT = process.cwd()
const cfgPath = resolve(KIT, process.argv[2] ?? 'hub.config.json')
const cfg: HubConfig = JSON.parse(readFileSync(cfgPath, 'utf8'))
const at = (p: string) => resolve(dirname(cfgPath), p)
const { token: TOKEN, source: TOKEN_SOURCE } = loadBotToken(KIT, cfgPath)

const log = (s: string) => process.stderr.write(`hub: ${s}\n`)

// --- webhooks and identity -------------------------------------------------------------------

const hooks = new Map<string, WebhookClient>() // channel id -> webhook
const hookIds = new Set<string>()
const webhookUrls: string[] = []
for (const ch of cfg.channels) {
  const h = JSON.parse(readFileSync(at(ch.webhook_file), 'utf8')) as { id: string; url: string }
  hooks.set(ch.channel_id, new WebhookClient({ url: h.url }))
  hookIds.add(h.id)
  webhookUrls.push(h.url, h.url.split('/').pop() ?? '')
}
const ledger = new AgentLedger(hookIds)
const ledgerFile = at(cfg.ledger_file)
mkdirSync(dirname(ledgerFile), { recursive: true })
if (existsSync(ledgerFile)) {
  for (const line of readFileSync(ledgerFile, 'utf8').split('\n')) {
    const [id, agent] = line.split(' ')
    if (id && agent) ledger.record(id, agent)
  }
}
function remember(messageId: string, agent: string): void {
  ledger.record(messageId, agent)
  appendFileSync(ledgerFile, `${messageId} ${agent}\n`)
}

const agentByName = new Map(cfg.agents.map(a => [a.name, a]))
const ownBots = cfg.agents.filter(a => a.discord_bot_id)
const agentByBotId = new Map(ownBots.map(a => [a.discord_bot_id!, a.name]))
const botIdByName = Object.fromEntries(ownBots.map(a => [a.name, a.discord_bot_id!]))
const agentsIn = (channelId: string) =>
  cfg.agents.filter(a => !a.channels || a.channels.includes(channelId)).map(a => a.name)
const channelCfg = new Map(cfg.channels.map(c => [c.channel_id, c]))

// One secret per agent; hub-client.ts presents it when it connects.
const secretsDir = at(cfg.secrets_dir)
mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
const secrets = new Map<string, string>()
for (const a of cfg.agents) {
  const f = join(secretsDir, a.name)
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('hex') + '\n', { mode: 0o600 })
  secrets.set(a.name, readFileSync(f, 'utf8').trim())
}

// --- what never leaves through an agent's message ---------------------------------------------
// The hub process can read the bot token, webhooks and agent secrets, and agents can't. Without
// these checks an agent could post them by naming them as an attachment or pasting them in text.

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const roomPath = join(KIT, 'room.config.json')
const perBotTokens: string[] = existsSync(roomPath)
  ? ((JSON.parse(readFileSync(roomPath, 'utf8')).agents ?? []) as { token?: string }[]).map(a => a.token ?? '')
  : []
const knownSecrets = [TOKEN, ...webhookUrls, ...secrets.values(), ...perBotTokens].filter(s => s.length >= 8)
const blockedPaths = [
  join(KIT, 'state'),
  roomPath,
  cfgPath,
  at(cfg.secrets_dir),
  dirname(at(cfg.socket)),
  ...(cfg.bot_token_file ? [at(cfg.bot_token_file)] : []),
  ...cfg.channels.map(c => at(c.webhook_file)),
].map(real)

function checkOutgoing(agent: string, text: string, files: string[]): void {
  const leak = secretIn(text, knownSecrets)
  if (leak) throw new Error(`not sent: ${leak}`)
  const inbox = [real(join(at(cfg.inbox_dir), agent))]
  for (const f of files) {
    const problem = attachmentProblem(real(f), blockedPaths, inbox)
    if (problem) throw new Error(`not sent: ${problem}`)
  }
}

// --- agent connections -----------------------------------------------------------------------

const conns = new Map<string, Socket>()
const send = (sock: Socket, obj: unknown) => sock.write(JSON.stringify(obj) + '\n')
const pendingPermissions = new Map<string, string>() // request_id -> agent
const mailbox = new Mailbox<object>() // messages for agents that aren't connected

const socketPath = at(cfg.socket)
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
if (existsSync(socketPath)) unlinkSync(socketPath)

const server = createServer(sock => {
  let agent: string | undefined
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!agent) {
        if (msg.type === 'hello' && secrets.get(msg.agent) === msg.secret) {
          agent = msg.agent as string
          conns.get(agent)?.destroy()
          conns.set(agent, sock)
          send(sock, { type: 'welcome', agent, display_name: agentByName.get(agent)?.display_name ?? agent })
          const waiting = mailbox.take(agent, Date.now())
          for (const item of waiting) send(sock, item)
          log(`${agent} connected${waiting.length ? `, delivered ${waiting.length} held message(s)` : ''}`)
        } else {
          send(sock, { type: 'error', error: 'bad hello' })
          sock.destroy()
        }
        continue
      }
      if (msg.type === 'call') {
        callTool(agent, msg.tool, msg.args ?? {})
          .then(result => send(sock, { type: 'result', id: msg.id, ok: true, result }))
          .catch(e => send(sock, { type: 'result', id: msg.id, ok: false, error: (e as Error).message }))
      } else if (msg.type === 'permission_request') {
        void relayPermission(agent, msg)
      }
    }
  })
  sock.on('close', () => {
    if (agent && conns.get(agent) === sock) {
      conns.delete(agent)
      log(`${agent} disconnected`)
    }
  })
  sock.on('error', () => {})
})
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  log(`listening on ${socketPath}`)
})

// --- tools agents can call -------------------------------------------------------------------

const MAX_CHUNK = 2000

function chunks(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > MAX_CHUNK) {
    const cut = rest.lastIndexOf('\n', MAX_CHUNK) > MAX_CHUNK / 2 ? rest.lastIndexOf('\n', MAX_CHUNK) : MAX_CHUNK
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  out.push(rest)
  return out
}

function hookFor(chatId: string): WebhookClient {
  const h = hooks.get(chatId)
  if (!h) throw new Error(`channel ${chatId} is not a hub channel`)
  return h
}

async function textChannel(id: string): Promise<TextChannel> {
  if (!channelCfg.has(id)) throw new Error(`channel ${id} is not a hub channel`)
  return (await client.channels.fetch(id)) as TextChannel
}

async function callTool(agent: string, tool: string, args: any): Promise<string> {
  const me = agentByName.get(agent)!
  if (agentsIn(args.chat_id ?? args.channel).indexOf(agent) < 0) throw new Error(`${agent} is not in that channel`)

  switch (tool) {
    case 'reply': {
      const hook = hookFor(args.chat_id)
      const paths = ((args.files ?? []) as unknown[]).map(String)
      if (paths.length > 10) throw new Error('at most 10 files')
      checkOutgoing(agent, String(args.text ?? ''), paths)
      const parts = chunks(withBotMentions(String(args.text ?? ''), botIdByName))
      const files = paths.map(f => new AttachmentBuilder(f))
      const ids: string[] = []
      for (let i = 0; i < parts.length; i++) {
        const sent = await hook.send({
          content: parts[i],
          username: me.display_name ?? agent,
          avatarURL: me.avatar_url,
          files: i === parts.length - 1 ? files : [],
          allowedMentions: { parse: ['users'] },
        })
        remember(sent.id, agent)
        ids.push(sent.id)
      }
      return ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
    }
    case 'edit_message': {
      const ch = await textChannel(args.chat_id)
      const m = await ch.messages.fetch(args.message_id)
      if (ledger.agentOf(m.id, m.webhookId) !== agent) throw new Error('you can only edit your own messages')
      checkOutgoing(agent, String(args.text ?? ''), [])
      await hookFor(args.chat_id).editMessage(m.id, { content: String(args.text) })
      return 'edited'
    }
    case 'react': {
      const ch = await textChannel(args.chat_id)
      const m = await ch.messages.fetch(args.message_id)
      await m.react(args.emoji)
      return 'reacted'
    }
    case 'fetch_messages': {
      const ch = await textChannel(args.channel)
      const limit = Math.min(Number(args.limit ?? 20), 100)
      const msgs = [...(await ch.messages.fetch({ limit })).values()].reverse()
      return msgs
        .map(m => {
          const who = ledger.agentOf(m.id, m.webhookId) ?? (m.webhookId ? 'unknown-webhook' : m.author.username)
          const att = m.attachments.size ? ` +${m.attachments.size}att` : ''
          return `[${m.createdAt.toISOString()}] ${who}: ${m.content.replace(/\n/g, ' ⏎ ')}${att}  (id: ${m.id})`
        })
        .join('\n')
    }
    case 'download_attachment': {
      const ch = await textChannel(args.chat_id)
      const m = await ch.messages.fetch(args.message_id)
      const dir = join(at(cfg.inbox_dir), agent)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const paths: string[] = []
      for (const a of m.attachments.values()) {
        const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer())
        const safe = a.name.replace(/[^\w.-]/g, '_')
        const p = join(dir, `${Date.now()}-${a.id}-${safe}`)
        writeFileSync(p, buf, { mode: 0o600 })
        paths.push(p)
      }
      return paths.length ? `downloaded ${paths.length}:\n${paths.join('\n')}` : 'no attachments'
    }
  }
  throw new Error(`unknown tool ${tool}`)
}

// --- permission prompts ----------------------------------------------------------------------

async function relayPermission(agent: string, p: { request_id: string; tool_name: string; description: string }) {
  pendingPermissions.set(p.request_id, agent)
  const text = `🔐 ${agentByName.get(agent)?.display_name ?? agent} asks permission: ${p.tool_name}\n${p.description.slice(0, 1500)}\nReply \`yes ${p.request_id}\` or \`no ${p.request_id}\` here.`
  for (const id of cfg.owners) {
    try {
      await (await client.users.fetch(id)).send(text)
    } catch (e) {
      log(`permission DM to ${id} failed: ${e}`)
    }
  }
}

// --- inbound Discord messages ----------------------------------------------------------------

const PERMISSION_REPLY = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const limiter = new HubHopLimiter(cfg.max_hops ?? 30)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
})

function authorOf(m: Message): Author {
  if (m.webhookId) {
    const agent = ledger.agentOf(m.id, m.webhookId)
    return agent ? { kind: 'agent', name: agent } : { kind: 'other' }
  }
  const ownBot = agentByBotId.get(m.author.id)
  if (ownBot) return { kind: 'agent', name: ownBot }
  if (m.author.bot) return { kind: 'other' }
  if (cfg.owners.includes(m.author.id)) return { kind: 'owner' }
  if (channelCfg.get(m.channelId)?.guests?.includes(m.author.id)) return { kind: 'human' }
  return { kind: 'other' }
}

client.on('messageCreate', async m => {
  // Owner's answer to a permission prompt, in DM or a hub channel.
  const perm = PERMISSION_REPLY.exec(m.content)
  if (perm && !m.author.bot && cfg.owners.includes(m.author.id)) {
    const id = perm[2]!.toLowerCase()
    const agent = pendingPermissions.get(id)
    const sock = agent && conns.get(agent)
    if (sock) {
      send(sock, { type: 'permission', request_id: id, behavior: perm[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' })
      pendingPermissions.delete(id)
      void m.react(perm[1]!.toLowerCase().startsWith('y') ? '✅' : '❌').catch(() => {})
      return
    }
  }

  const ch = channelCfg.get(m.channelId)
  if (!ch) return
  // The webhook's own post event can arrive before the reply call records its id; give it a moment.
  if (m.webhookId && hookIds.has(m.webhookId) && !ledger.agentOf(m.id, m.webhookId)) await Bun.sleep(400)
  const author = authorOf(m)
  if (author.kind === 'other') return

  const decision = limiter.observe(m.channelId, author)
  if (decision === 'announce_pause') {
    await (m.channel as TextChannel).send(`⏸️ Agents paused after ${cfg.max_hops ?? 30} messages in a row. Send a message here to continue.`)
    return
  }
  if (decision === 'drop') return

  let repliesTo: string | undefined
  if (m.reference?.messageId) {
    const ref = await m.fetchReference().catch(() => null)
    if (ref) repliesTo = ledger.agentOf(ref.id, ref.webhookId)
  }
  const to = recipients({
    author,
    content: m.content,
    agents: agentsIn(m.channelId),
    repliesTo,
    userMentions: m.mentions.users.size + m.mentions.roles.size,
    requireMention: ch.require_mention ?? false,
    hearEverything: ch.hear_everything ?? false,
  })

  const atts = [...m.attachments.values()].map(a => `${a.name} (${a.contentType ?? 'unknown'}, ${(a.size / 1024).toFixed(0)}KB)`)
  const meta = {
    chat_id: m.channelId,
    message_id: m.id,
    user: author.kind === 'agent' ? author.name : m.author.username,
    user_id: author.kind === 'agent' ? `agent:${author.name}` : m.author.id,
    ...(author.kind === 'agent' ? { is_agent: 'true' } : {}),
    ts: m.createdAt.toISOString(),
    ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
  }
  const held: string[] = []
  for (const name of to) {
    const item = { type: 'message', content: m.content || (atts.length ? '(attachment)' : ''), meta }
    const sock = conns.get(name)
    if (sock) send(sock, item)
    else if (botIdByName[name]) continue // it hears through its own bot
    else {
      mailbox.hold(name, item, Date.now())
      held.push(name)
    }
  }
  if (to.length) log(`${m.id} from ${meta.user} -> ${to.join(', ')}${held.length ? ` (held for ${held.join(', ')})` : ''}`)
})

client.once('clientReady', c => log(`gateway connected as ${c.user.tag} (token from ${TOKEN_SOURCE})`))
client.login(TOKEN).catch(e => {
  log(`login failed: ${e}`)
  process.exit(1)
})

const stop = () => {
  server.close()
  try {
    unlinkSync(socketPath)
  } catch {}
  void client.destroy()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
