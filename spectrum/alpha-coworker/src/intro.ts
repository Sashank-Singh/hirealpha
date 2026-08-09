/**
 * One-shot intro texts to INTRO_TO without holding the message loop.
 * Usage: bun src/intro.ts   (from each bot folder)
 */
import { Spectrum } from 'spectrum-ts'
import { imessage } from '@spectrum-ts/imessage'

const text = process.argv[2]
if (!text) {
  console.error('Usage: bun src/intro.ts "message text"')
  process.exit(1)
}

const introTo = process.env.INTRO_TO || '+12163032166'

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
})

const im = imessage(app)
const user = await im.user(introTo)
const space = await im.space.create(user)
await space.send(text)
console.log(`Intro sent to ${introTo}`)
await app.stop()
