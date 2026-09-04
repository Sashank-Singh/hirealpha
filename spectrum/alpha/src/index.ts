import { Spectrum, app as appCard } from 'spectrum-ts'
import { imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultReplyCard, getAgent, runHireTurn, runMemoryMaintenance, sanitizeOutbound } from '../../shared/runHireTurn'
import { extractMessageText, handleInboundPhoto } from '../../shared/liveContext'
import { claimInbound } from '../../shared/inboundGuard'
import { startReminderScheduler } from '../../shared/reminders'
import { startTaskLoopPoller } from '../../shared/taskLoops'
import { INTRO_TEXTS, startIntroPoller } from '../../shared/introQueue'
import { startHealthServer, startHeartbeat } from '../../shared/health'
import { backfillScores, hashPhone, logTurn, readTurns } from '../../shared/evals'

const agentId = 'friend' as const
const agent = getAgent(agentId)
const dataDir = join(import.meta.dir, '..', 'data')
mkdirSync(dataDir, { recursive: true })

/** Score recent turns in the background so quality numbers exist without ever
 * slowing a reply: once at boot, then every 15 minutes. */
let scoredAt = 0
async function maybeBackfill() {
  const now = Date.now()
  if (now - scoredAt < 15 * 60 * 1000) return
  scoredAt = now
  const n = await backfillScores(dataDir, 8)
  if (n > 0) console.log(`[${agent.id}] evals: scored ${n} recent turns`)
}
void maybeBackfill()
setInterval(() => void maybeBackfill(), 15 * 60 * 1000).unref?.()

const introTo =
  process.env.SKIP_INTRO === '1' ? undefined : process.env.INTRO_TO

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
})

const im = imessage(app)

if (introTo) {
  try {
    const user = await im.user(introTo)
    const space = await im.space.create(user)
    await space.responding(async () => {
      await space.send(INTRO_TEXTS[agent.id])
      await space.shareContactCard().catch(() => undefined)
    })
    console.log(`[${agent.id}] intro sent to ${introTo}`)
  } catch (err) {
    console.error(`[${agent.id}] intro failed:`, err)
  }
}

// Numbers that signed up on the site get the intro text without anyone adding
// them by hand; failures ack back to the server and retry on the next poll.
// The native contact card rides along so iOS offers "New contact information
// — Add" right in the thread (name + photo come from the project profile).
startIntroPoller({
  persona: agent.id,
  send: async (phone, text) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await space.send(cleaned)
      await space.shareContactCard().catch(() => undefined)
    })
  },
})

startHealthServer(agent.id, {
  readEvals: () => readTurns(dataDir, { limit: 60 }),
  scoreEvals: () => backfillScores(dataDir, 20),
})
startHeartbeat(agent.id)
console.log(`[${agent.id}] listening as ${agent.imsgName} (${agent.phoneNumber})`)

startTaskLoopPoller({
  persona: agent.id,
  send: async (phone, text) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await space.send(cleaned)
    })
  },
})

startReminderScheduler({
  persona: agent.id,
  send: async (phone, text, card) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await space.send(cleaned)
      if (card) await space.send(appCard(card.url, { live: card.live }))
    })
  },
})

for await (const [space, message] of app.messages) {
  if (message.direction === 'outbound') continue

  if (message.content.type === 'read') {
    try {
      const target = message.content.target
      console.log(
        `[${agent.id}] ${message.sender?.id ?? 'reader'} read ${target.id} at ${message.timestamp.toISOString()}`,
      )
    } catch {
      /* ignore */
    }
    continue
  }

  if (message.content.type !== 'text') {
    // Non-text: a bare food photo, or an iMessage text+photo group.
    const senderId = message.sender?.id ?? space.id
    try {
      await message.react('👍').catch(() => undefined)
      const photoReply = await handleInboundPhoto(senderId, agent.id, message.content)
      const photoText = extractMessageText(message.content)
      if (!photoReply && !photoText) continue
      if (photoText) {
        // Text came with the photo: run the normal turn with a note so the
        // reply can acknowledge the logged meal.
        if (!claimInbound(senderId, photoText, message.id)) {
          console.warn(`[${agent.id}] duplicate inbound skipped: ${message.id}`)
          continue
        }
        const note = photoReply
          ? `The user sent a food photo with this message. It was auto-logged to nutrition and you just confirmed it in one line ("${photoReply}"). Do not log it again; answer their actual question.`
          : ''
        await space.responding(async () => {
          const { bubbles, source, authoritative, reply, card } = await runHireTurn({
            agentId,
            dataDir,
            senderId,
            userText: photoText,
            inboundNote: note,
          })
          const texts = bubbles.map((b) => sanitizeOutbound(b)).filter(Boolean)
          if (!texts.length) {
            if (card) await space.send(appCard(card.url, { live: card.live }))
            return
          }
          await message.reply(texts[0]!)
          for (let i = 1; i < texts.length; i++) await space.send(texts[i]!)
          // The mini-app card lands after the LAST bubble only, never between them.
          const delivered = card ?? (await defaultReplyCard(senderId, agentId))
          if (delivered) await space.send(appCard(delivered.url, { live: delivered.live }))
          if (source === 'gmi') {
            void runMemoryMaintenance({ dataDir, senderId, agentId, authoritative, userText: photoText, reply })
              .catch(() => undefined)
          }
        })
        continue
      }
      if (photoReply) {
        const cleaned = sanitizeOutbound(photoReply)
        if (cleaned) await message.reply(cleaned)
      }
    } catch (err) {
      console.warn(`[${agent.id}] photo handling failed`, err)
    }
    continue
  }

  const userText = message.content.text.trim()
  if (!userText) continue
  const senderId = message.sender?.id ?? space.id
  if (!claimInbound(senderId, userText, message.id)) {
    console.warn(`[${agent.id}] duplicate inbound skipped: ${message.id}`)
    continue
  }
  console.log(`[${agent.id}] inbound from ${senderId}: ${userText.slice(0, 120)}`)

  try {
    await message.react('👍').catch(() => undefined)
    await message.read().catch(() => undefined)
    await space.responding(async () => {
      const t0 = Date.now()
      const { bubbles, source, authoritative, reply, card } = await runHireTurn({
        agentId,
        dataDir,
        senderId,
        userText,
      })
      const texts = bubbles.map((b) => sanitizeOutbound(b)).filter(Boolean)
      if (!texts.length) {
        if (card) {
          console.log(`[${agent.id}] sending card only: ${card.url}`)
          await space.send(appCard(card.url, { live: card.live }))
        } else {
          console.warn(`[${agent.id}] dropped empty/banned outbound`)
        }
        logTurn(dataDir, {
          ts: new Date().toISOString(),
          persona: agentId,
          sender: hashSender(senderId),
          userText,
          reply: reply || '',
          card: !!card,
          texts: 0,
          source,
          totalMs: Date.now() - t0,
        })
        return
      }
      console.log(`[${agent.id}] sending ${texts.length} text(s), card: ${!!card}`)
      console.log(`[${agent.id}] bubble: ${JSON.stringify(texts[0]!.slice(0, 200))}`)
      await message.reply(texts[0]!)
      for (let i = 1; i < texts.length; i++) await space.send(texts[i]!)
      // Every response carries the mini-app card, attached after the LAST bubble.
      const delivered = card ?? (await defaultReplyCard(senderId, agentId))
      if (delivered) {
        console.log(`[${agent.id}] sending card: ${delivered.url}`)
        await space.send(appCard(delivered.url, { live: delivered.live }))
      }
      logTurn(dataDir, {
        ts: new Date().toISOString(),
        persona: agentId,
        sender: hashSender(senderId),
        userText,
        reply,
        card: !!delivered,
        texts: texts.length,
        source,
        totalMs: Date.now() - t0,
      })
      if (source === 'gmi') {
        void runMemoryMaintenance({ dataDir, senderId, agentId, authoritative, userText, reply })
          .catch(() => undefined)
      }
    })
  } catch (err) {
    console.error(`[${agent.id}] turn failed:`, err)
    try {
      await space.send('Got tripped up for a sec. Try me again?')
    } catch {
      /* ignore */
    }
  }
}
