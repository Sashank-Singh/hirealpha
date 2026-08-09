import { Spectrum } from 'spectrum-ts'
import { imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAgent, runHireTurn } from '../../shared/runHireTurn'

const agentId = 'cofounder' as const
const agent = getAgent(agentId)
const dataDir = join(import.meta.dir, '..', 'data')
mkdirSync(dataDir, { recursive: true })

const introTo =
  process.env.SKIP_INTRO === '1' ? undefined : process.env.INTRO_TO || '+12163032166'

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
        "Hey — Alpha(CoFounder). You hired me as your startup partner. I'll push back when the plan is soft. What's the real decision this week?",
      )
    })
    console.log(`[${agent.id}] intro sent to ${introTo}`)
  } catch (err) {
    console.error(`[${agent.id}] intro failed:`, err)
  }
}

console.log(`[${agent.id}] listening as ${agent.imsgName} (${agent.phoneNumber})`)

for await (const [space, message] of app.messages) {
  if (message.direction === 'outbound') continue
  if (message.content.type !== 'text') continue

  const userText = message.content.text.trim()
  if (!userText) continue
  const senderId = message.sender?.id ?? space.id

  try {
    await message.react('👍').catch(() => undefined)
    await space.responding(async () => {
      const { bubbles } = await runHireTurn({
        agentId,
        dataDir,
        senderId,
        userText,
      })
      for (let i = 0; i < bubbles.length; i++) {
        if (i === 0) await message.reply(bubbles[i]!)
        else await space.send(bubbles[i]!)
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
