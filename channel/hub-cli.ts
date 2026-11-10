#!/usr/bin/env bun
// Lets a session that isn't launched by hub-room.ts take part as a hub agent ("external": true
// in hub.config.json). It connects as that agent, prints the messages held for it, and can post.
// Usage (from the kit folder; HUB_CONFIG overrides ./hub.config.json):
//   bun channel/hub-cli.ts <agent> say <channel-id> <text-file>
//   bun channel/hub-cli.ts <agent> fetch <channel-id> [limit]
//   bun channel/hub-cli.ts <agent> listen [seconds]      print messages addressed to the agent

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'

const cfgPath = resolve(process.cwd(), process.env.HUB_CONFIG ?? 'hub.config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { socket: string; secrets_dir: string }
const at = (p: string) => resolve(dirname(cfgPath), p)
const [agent, cmd, ...args] = process.argv.slice(2)
if (!agent || !['say', 'fetch', 'listen'].includes(cmd ?? '')) {
  console.error('Usage: hub-cli.ts <agent> say <channel-id> <text-file> | fetch <channel-id> [limit] | listen [seconds]')
  process.exit(1)
}

const s = connect(at(cfg.socket))
let buf = ''
const done = (code = 0) => {
  s.end()
  process.exit(code)
}
s.on('error', e => {
  console.error(`can't reach the hub: ${e.message}`)
  process.exit(1)
})
s.on('connect', () =>
  s.write(JSON.stringify({ type: 'hello', agent, secret: readFileSync(join(at(cfg.secrets_dir), agent), 'utf8').trim() }) + '\n'),
)
s.on('data', chunk => {
  buf += chunk.toString()
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (msg.type === 'error') {
      console.error(`hub refused: ${msg.error}`)
      done(1)
    } else if (msg.type === 'welcome') {
      if (cmd === 'say') s.write(JSON.stringify({ type: 'call', id: 1, tool: 'reply', args: { chat_id: args[0], text: readFileSync(args[1]!, 'utf8').trim() } }) + '\n')
      else if (cmd === 'fetch') s.write(JSON.stringify({ type: 'call', id: 1, tool: 'fetch_messages', args: { channel: args[0], limit: Number(args[1] ?? 20) } }) + '\n')
      else setTimeout(done, Number(args[0] ?? 5) * 1000)
    } else if (msg.type === 'message') {
      console.log(`[${msg.meta.ts}] ${msg.meta.user}${msg.meta.is_agent ? ' (agent)' : ''} in ${msg.meta.chat_id}: ${msg.content}  (id: ${msg.meta.message_id})`)
    } else if (msg.type === 'result') {
      console.log(msg.ok ? msg.result : `error: ${msg.error}`)
      // Leave a moment for held messages that arrive with the welcome.
      setTimeout(() => done(msg.ok ? 0 : 1), 300)
    }
  }
})
