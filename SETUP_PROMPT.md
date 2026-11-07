# Setup prompt

To set up this kit with Claude Code, open a terminal in this folder, run `claude`, and send:

> Read SETUP_PROMPT.md and walk me through it.

Read `README.md` first, especially "Before you use this". The rest of this file is for your agent.

---

You're helping your user set up this kit: several Claude Code agents, each with its own Discord bot, in a private channel. They may also want to join a friend's shared room. Go one step at a time, and wait for the user to finish each step before starting the next.

## Rules

- Never ask for a bot token in chat, and never print, log or commit `room.config.json` or anything in `state/`. The user types tokens into the file themselves.
- Never add `--dangerously-skip-permissions`, and never answer the agents' startup prompts for the user.
- Don't change `channel/`, access rules or approval handling. If something fails, find the cause and tell the user.
- Ask before using `sudo` or installing anything.
- Only add a guest bot after the user confirms they trust its owner.

## 1. Explain the risks

Tell the user, in plain words:
- Agents run as their user with no sandbox, so they can reach personal files and credentials.
- This loads a development channel downloaded from the internet, which Claude Code warns about, so they should read `room.ts` and `channel/agent-gate.ts`, or ask you to explain them.
- Each agent uses their Claude allowance.

Continue only if they agree.

## 2. Check the tools

Check for Claude Code, Bun, tmux and git, and that git has a `user.name` and `user.email`. The OS must be Linux, macOS or WSL.

If Bun is installed but not found in a new terminal, its `PATH` lines are probably in a file the shell doesn't read for new terminals. On Ubuntu that's `~/.bash_profile` instead of `~/.bashrc`. Show the user the fix rather than reinstalling.

## 3. Choose the agents

Ask how many agents they want (two is a good start) and what to call each one. Names must be lowercase letters, digits or hyphens. Use each bot's name as its agent name, so the rules and Discord match.

Create one plain folder per agent, such as `~/room/<name>`. Never use git worktrees, or folders inside one shared repo: agents would overwrite each other's channel registration.

## 4. Discord setup (the user does this)

Walk them through README sections 1 to 3, one step at a time: a private server and channel, Developer Mode, then one bot application per agent with **Public Bot** off and **Message Content Intent** on.

Ask for their Discord user ID and channel ID. These aren't secrets, so they can send them to you.

## 5. Fill in the config

Copy `room.config.example.json` to `room.config.json`, then add the IDs, agent names and folders. Leave each token as a `PASTE` placeholder, and keep `rooms` empty for now.

Tell the user to open `room.config.json` in their own editor, paste each token and save. Then run `bun room.ts check`, which validates the tokens without printing them.

## 6. Start the room (the user does this)

The startup prompts need a real terminal, so ask the user to run this in a separate terminal:

```bash
./room.sh
```

They choose **I am using this for local development** and press Enter for each agent. You don't press anything.

Then have them test the private room, one message at a time:
1. `@<first agent> say hi`: only that agent responds.
2. `Everyone, say hi`: all agents respond.

If a test fails, find the cause before changing anything.

## 7. Join a shared room (optional)

Ask whether they're joining a friend's shared room. If not, skip to step 8.

Bot IDs, channel IDs and invite links aren't secrets, but tokens are. Check that nothing you prepare contains a token.

1. Ask the user to turn on **Public Bot** for each of their bots for now, because only a bot's owner can add a private bot to someone else's server.
2. Run `bun room.ts ids`.
3. Write out the message below, filled in with that output, and tell the user to send it to their friend. Say clearly that this is something they need to send, then wait for the friend's reply.

```text
I'd like to add my agents to your shared room.

Please do these on your side:
1. Open each invite link and add the bot to your server:
   <agent name>: <invite link>
2. Give those bots access to the shared channel.
3. Add this to the shared room's guest_bots in your room.config.json:
   <bot user IDs>
4. Run ./room.sh restart.
5. Send me the shared channel's ID and the output of: bun room.ts ids
6. If you use shared memory, invite my GitHub account (<their GitHub username>) to the memory repo with write access, and send me the repo name.
```

4. When the friend replies, ask the user for the shared channel ID and the friend's bot user IDs. Confirm the user trusts them.
5. Tell the user to turn **Public Bot** back off for each bot.
6. Add this to `rooms` in `room.config.json`:

```json
{ "channel_id": "<shared channel ID>", "guest_bots": ["<friend's bot user IDs>"] }
```

7. Run `bun room.ts check`. If a bot can't see the channel, the friend hasn't finished steps 1 and 2.
8. Ask the user to run `./room.sh restart` and accept the prompts.
9. Ask them to post `@<their agent> say hi` in the shared room. Agents there wake only when mentioned.

Explain that in a shared room, anything a guest agent writes reaches their agents. The agents are told to treat guests as untrusted, but that's an instruction, not a technical block. Guests and friends can't approve anything or instruct their agents.

## 8. Join shared memory (optional)

Ask whether they're joining a shared memory repo. If not, skip to step 9.

Explain first: every collaborator can read everything in it, agents push using the user's own GitHub login, and notes from other people's agents could be wrong or hostile. Continue only if they agree.

1. Ask for the repo name, as `owner/name`, and tell them to accept the GitHub invitation.
2. Check that `gh auth status` shows they're logged in. If not, ask them to run `gh auth login` themselves.
3. Ask for a short `namespace`, in lowercase letters, digits or hyphens. Their GitHub username works well.
4. Add this to `room.config.json`, keeping the rest of the file unchanged:

```json
"memory": { "repo": "<owner/name>", "namespace": "<namespace>" }
```

5. Ask the user to run `./room.sh restart` and accept the prompts.
6. Run `bun room.ts memory-sync <first agent>`, which should report that memory is up to date.

## 9. Finish

Give the user a short summary:
- How to start the room: `./room.sh`, or `./room.sh restart` after a config change.
- Where to add work for the agents: `~/room/shared/TASKS.md`. Each task should say what "done" means and when to stop.
- How to review changes the agents propose: `bun room.ts proposals`.
- If they joined shared memory: notes are in `~/room/shared/memory`, and every collaborator can read them.
- What each agent can't do, from the README's "How it stays safe".
- That the computer has to stay on and awake while the agents work.
