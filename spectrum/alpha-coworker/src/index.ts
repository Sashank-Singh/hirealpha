import { Spectrum, app as appCard } from 'spectrum-ts'
import { imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAgent, runHireTurn, runMemoryMaintenance, stripDashes } from '../../shared/runHireTurn'
import { claimInbound } from '../../shared/inboundGuard'
import { startReminderScheduler } from '../../shared/reminders'
import { startHealthServer } from '../../shared/health'

const agentId = 'coworker' as const
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

if (introTo) {
  try {
    const user = await im.user(introTo)
    const space = await im.space.create(user)
    await space.responding(async () => {
      await space.send(
        'Hey. Alpha (Coworker). You hired me as your work colleague. Standups, agendas, follow ups. Send me the raw notes.',
      )
    })
    console.log(`[${agent.id}] intro sent to ${introTo}`)
  } catch (err) {
    console.error(`[${agent.id}] intro failed:`, err)
  }
}

startHealthServer(agent.id)
console.log(`[${agent.id}] listening as ${agent.imsgName} (${agent.phoneNumber})`)

startReminderScheduler({
  persona: agent.id,
  send: async (phone, text, card) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      await space.send(stripDashes(text))
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

  if (message.content.type !== 'text') continue

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
      const { bubbles, source, authoritative, reply, card } = await runHireTurn({
        agentId,
        dataDir,
        senderId,
        userText,
      })
      const text = (bubbles[0] || reply || '…').trim()
      console.log(`[${agent.id}] sending 1 text, card: ${!!card}`)
      console.log(`[${agent.id}] bubble: ${JSON.stringify(text.slice(0, 200))}`)
      await message.reply(text)
      if (card) await space.send(appCard(card.url, { live: card.live }))
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
