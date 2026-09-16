import { Spectrum, UnsupportedError, app as appCard, contact, fromVCard, markdown, type ContentInput } from 'spectrum-ts'
import { effect, imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultReplyCard, getAgent, runHireTurn, runMemoryMaintenance, sanitizeOutbound } from '../../shared/runHireTurn'
import { extractMessageText, handleInboundPhoto } from '../../shared/liveContext'
import { claimInbound } from '../../shared/inboundGuard'
import { startReminderScheduler } from '../../shared/reminders'
import { startTaskLoopPoller } from '../../shared/taskLoops'
import { startCofounderLoop } from '../../shared/cofounderPro'
import { determineInboundReaction } from '../../shared/smartReactions'
import { INTRO_TEXTS, startIntroPoller } from '../../shared/introQueue'
import { onboardingCard } from '../../shared/miniApps'
import { startHealthServer, startHeartbeat } from '../../shared/health'
import { buildAlphaVcard, resolveAlphaContactPhone } from '../../shared/alphaContact'

const agentId = 'cofounder' as const
const agent = getAgent(agentId)
const dataDir = join(import.meta.dir, '..', 'data')
mkdirSync(dataDir, { recursive: true })

const introTo =
  process.env.SKIP_INTRO === '1' ? undefined : process.env.INTRO_TO

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
})

const im = imessage(app)

const styledText = (value: string) => markdown(value)

async function sendIntroText(
  space: { send: (content: ContentInput) => Promise<unknown> },
  value: string,
): Promise<void> {
  const content = styledText(value)
  try {
    await space.send(effect(content, imessage.effect.message.gentle))
  } catch (err) {
    if (!(err instanceof UnsupportedError)) throw err
    await space.send(content)
  }
}

async function sendAlphaContact(
  space: { phone?: string; send: (content: ContentInput) => Promise<unknown> },
  userPhone: string,
): Promise<void> {
  const tel = await resolveAlphaContactPhone(userPhone, space.phone)
  if (!tel) throw new Error(`Photon has not provided an assigned line for ${userPhone}`)
  await space.send(contact(await fromVCard(buildAlphaVcard(tel))))
}

if (introTo) {
  try {
    const user = await im.user(introTo)
    const space = await im.space.create(user)
    await space.responding(async () => {
      await sendIntroText(space, INTRO_TEXTS[agent.id])
      await sendAlphaContact(space, introTo).catch((err) => console.error(`[${agent.id}] intro contact card failed`, err))
    })
    console.log(`[${agent.id}] intro sent to ${introTo}`)
  } catch (err) {
    console.error(`[${agent.id}] intro failed:`, err)
  }
}

// Numbers that signed up on the site get the intro text without anyone adding
// them by hand; failures ack back to the server and retry on the next poll.
startIntroPoller({
  persona: agent.id,
  send: async (phone, text) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await sendIntroText(space, cleaned)
      await sendAlphaContact(space, phone).catch((err) => console.error(`[${agent.id}] intro contact card failed`, err))
      try {
        const card = await onboardingCard(phone, agent.id)
        if (card) await space.send(appCard(card.url, { live: card.live }))
      } catch (cardErr) {
        console.warn(`[${agent.id}] intro onboarding card failed`, cardErr)
      }
    })
  },
})

startHealthServer(agent.id)
startHeartbeat(agent.id)
console.log(`[${agent.id}] listening as ${agent.imsgName} (${agent.phoneNumber})`)

startTaskLoopPoller({
  persona: agent.id,
  send: async (phone, text) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await space.send(styledText(cleaned))
    })
  },
})

// Daily digest: once per calendar day, best effort after 9am local. The digest
// response carries the hire's phone; without it the loop stays quiet.
startCofounderLoop({
  persona: agent.id,
  send: async (phone, text) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      const cleaned = sanitizeOutbound(text)
      if (cleaned) await space.send(styledText(cleaned))
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
      if (cleaned) await space.send(styledText(cleaned))
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
          await message.reply(styledText(texts[0]!))
          for (let i = 1; i < texts.length; i++) await space.send(styledText(texts[i]!))
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
        if (cleaned) await message.reply(styledText(cleaned))
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
    const reaction = determineInboundReaction({ dataDir, senderId, userText })
    if (reaction) {
      await message.react(reaction).catch(() => undefined)
    }
    await message.read().catch(() => undefined)
    await space.responding(async () => {
      const { bubbles, source, authoritative, reply, card } = await runHireTurn({
        agentId,
        dataDir,
        senderId,
        userText,
      })
      const text = sanitizeOutbound(bubbles[0] || reply || '')
      if (!text) {
        if (card) {
          console.log(`[${agent.id}] sending card only: ${card.url}`)
          await space.send(appCard(card.url, { live: card.live }))
        } else {
          console.warn(`[${agent.id}] dropped empty/banned outbound`)
        }
        return
      }
      console.log(`[${agent.id}] sending 1 text, card: ${!!card}`)
      console.log(`[${agent.id}] bubble: ${JSON.stringify(text.slice(0, 200))}`)
      await message.reply(styledText(text))
      if (card) await space.send(appCard(card.url, { live: card.live }))
      if (source === 'gmi') {
        void runMemoryMaintenance({ dataDir, senderId, agentId, authoritative, userText, reply })
          .catch(() => undefined)
      }
    })
  } catch (err) {
    console.error(`[${agent.id}] turn failed:`, err)
    try {
      await space.send(styledText('Got tripped up for a sec. Try me again?'))
    } catch {
      /* ignore */
    }
  }
}
