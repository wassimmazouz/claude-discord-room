#!/usr/bin/env bun
// A scripted stand-in for an agent, for testing the hub without a Claude session.
// It connects like hub-client.ts, logs what it receives, and answers each message once.
// Usage: bun channel/hub-fake-agent.ts <socket> <agent> <secret-file> <channel-id> [greeting]

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

const [socket, agent, secretFile, channelId, greeting] = process.argv.slice(2)
if (!socket || !agent || !secretFile || !channelId) {
  console.error('Usage: hub-fake-agent.ts <socket> <agent> <secret-file> <channel-id> [greeting]')
  process.exit(1)
}

const s = connect(socket)
let id = 1
let buf = ''
const call = (tool: string, args: object) => s.write(JSON.stringify({ type: 'call', id: id++, tool, args }) + '\n')

s.on('connect', () => s.write(JSON.stringify({ type: 'hello', agent, secret: readFileSync(secretFile, 'utf8').trim() }) + '\n'))
s.on('data', chunk => {
  buf += chunk.toString()
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    console.log(`[${agent}] ${JSON.stringify(msg)}`)
    if (msg.type === 'welcome' && greeting) call('reply', { chat_id: channelId, text: greeting })
    if (msg.type === 'message' && msg.meta.is_agent !== 'true') {
      call('reply', { chat_id: channelId, text: `${agent} got: "${msg.content.slice(0, 80)}" from ${msg.meta.user}` })
    }
  }
})
s.on('close', () => process.exit(0))
