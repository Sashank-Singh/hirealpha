import { Spectrum, app as appCard, contact, fromVCard } from 'spectrum-ts'
import { imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultReplyCard, getAgent, runHireTurn, runMemoryMaintenance, sanitizeOutbound } from '../../shared/runHireTurn'
import { extractMessageText, fetchLiveProfile, handleInboundPhoto } from '../../shared/liveContext'
import { mintMiniAppCard } from '../../shared/miniApps'
import { claimInbound } from '../../shared/inboundGuard'
import { onceAsync } from '../../shared/delivery'
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

/** Mini-app cards ride a different RPC than text (SendCustomizedMiniAppMessage)
 * and Photon briefly rejects rich sends to a brand-new project user with
 * "Target not allowed" even after the text reply landed. Retry past it — the
 * thread is real, the gate just settles late. */
async function sendCardSafe(
  space: { send: (content: unknown) => Promise<unknown> },
  url: string,
  live: boolean,
): Promise<void> {
  const delays = [0, 2000, 5000]
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      await space.send(appCard(url, { live }))
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i === delays.length - 1 || !/Target not allowed/i.test(msg)) throw err
      console.warn(`[${agentId}] card send gated, retry ${i + 1}`)
    }
  }
}

/** Run a turn's send body inside space.responding, tolerating Photon's
 * new-user gate: the typing indicator RPC can reject with "Target not allowed"
 * for a few seconds after first contact. Retry once after 3s unless something
 * already sent (never double-send). */
async function respondWithRetry(
  space: { responding: <T>(fn: () => T | Promise<T>) => Promise<T> },
  sent: () => boolean,
  fn: () => Promise<void>,
): Promise<void> {
  const attempt = () => space.responding(fn)
  try {
    await attempt()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Target not allowed/i.test(msg) && !sent()) {
      console.warn(`[${agentId}] gate on first turn, retrying in 3s`)
      await new Promise((r) => setTimeout(r, 3000))
      await attempt()
      return
    }
    throw err
  }
}

/** Send Alpha's contact as a real .vcf attachment so iOS shows a tappable
 * contact card. Builds the vCard locally (no HTTP round-trip) so it can't
 * fail because the API URL is unreachable from this host; resolves the
 * user's assigned line best-effort, falling back to Alpha's primary line. */
async function sendContactVcf(
  space: { send: (content: unknown) => Promise<unknown> },
  phone: string,
): Promise<void> {
  const base = (process.env.HIREALPHA_API_URL || 'https://hirealpha.chat').replace(/\/$/, '')
  let tel = '+14155951440'
  try {
    const res = await fetch(`${base}/api/assigned-phone?phone=${encodeURIComponent(phone)}`, {
      headers: { Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}` },
    })
    const body = res.ok ? ((await res.json()) as { assignedPhone?: string | null }) : null
    if (body?.assignedPhone) tel = body.assignedPhone
  } catch (err) {
    console.warn(`[${agentId}] assigned-phone lookup failed, using default line`, err)
  }
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'N:;Alpha;;;', 'FN:Alpha', 'ORG:HireAlpha', `TEL;TYPE=CELL:${tel}`, 'END:VCARD'].join('\r\n')
  try {
    await space.send(contact(await fromVCard(vcf)))
    console.log(`[${agentId}] sent vcf contact card to ${phone} (${tel})`)
  } catch (err) {
    console.error(`[${agentId}] vcf contact send failed`, err)
    throw err
  }
}

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
      await space.shareContactCard().catch((err) => console.error(`[${agent.id}] intro shareContactCard failed`, err))
      // Native card alone doesn't always render — the .vcf attachment is what
      // iOS reliably offers "Add Contact" for. The save_contact loop (~15 min
      // later) repeats the nudge for anyone who missed it.
      await sendContactVcf(space, phone).catch((err) => console.error(`[${agent.id}] intro vcf failed`, err))
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
      // Strip the internal marker so it never shows to the user.
      const visible = text.replace(/^\[savecontact\]\s*/i, '')
      const cleaned = sanitizeOutbound(visible)
      if (cleaned) await space.send(cleaned)
      // One-off "save Alpha's number" nudge: share the native card AND send a
      // real .vcf file so iOS offers "Add Contact" regardless of the line
      // identity sync state (native card alone showed nothing).
      if (/^\[savecontact\]/i.test(text)) {
        await space.shareContactCard().catch((err) => console.error(`[${agentId}] shareContactCard failed`, err))
        await sendContactVcf(space, phone).catch((err) => console.error(`[${agentId}] sendContactVcf failed`, err))
      }
    })
  },
  runKind: {
    save_contact: async () => ({
      text: "[savecontact] If you haven't saved Alpha's number, tap Add so I always reach you.",
      outcome: 'done',
    }),
    // Onboarding just completed in the setup wizard: one warm welcome that names
    // the connected tools, offers the week review, and introduces Alpha Apps.
    // The server enqueues this exactly once per (user, persona) on done: true.
    onboard_done: async (task) => {
      const profile = await fetchLiveProfile(task.phone, 'friend')
      const first = String(profile?.name || '').trim().split(/\s+/)[0] || ''
      const connected = Array.isArray(profile?.connected)
        ? profile.connected.map((id) => String(id).toLowerCase())
        : []
      const tools = connected.includes('calendar')
        ? connected.includes('gmail')
          ? ['Gmail', 'Calendar']
          : ['Calendar']
        : connected.includes('gmail')
          ? ['Gmail']
          : []
      const pieces: string[] = []
      if (tools.length) {
        const greet = first ? `You're all set, ${first}.` : "You're all set."
        pieces.push(
          `${greet} I'm connected to ${tools.join(' and ')}. I can tell you which emails matter and which are junk, and review the week's email and calendar.`,
        )
      } else {
        const greet = first ? `You're all set, ${first}.` : "You're all set."
        pieces.push(`${greet} I'm your Alpha in texts, ready when you are.`)
      }
      pieces.push('Text @ apps to open Alpha apps, your nutrition, sleep, spending, and everything else in one place.')
      pieces.push('I will start using your connected tools now.')
      return { text: pieces.join(' '), outcome: 'done' }
    },
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
      if (card) await sendCardSafe(space, card.url, card.live)
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
            if (card) await sendCardSafe(space, card.url, card.live)
            return
          }
          await message.reply(texts[0]!)
          for (let i = 1; i < texts.length; i++) await space.send(texts[i]!)
          // The mini-app card lands after the LAST bubble only, never between them.
          const delivered = card ?? (await defaultReplyCard(senderId, agentId))
          if (delivered) await sendCardSafe(space, delivered.url, delivered.live)
          if (source === 'gmi') {
            void runMemoryMaintenance({ dataDir, senderId, agentId, authoritative, userText: photoText, reply })
              .catch(() => undefined)
          }
        })
        continue
      }
      if (photoReply) {
        const cleaned = sanitizeOutbound(photoReply)
        if (cleaned) {
          await message.reply(cleaned)
          /* A photo log has a natural destination: the Nutrition app. Send its
           * card so the tap-through goes straight to the log instead of a
           * general menu the user has to search. Only on photo-log replies. */
          try {
            const card = await mintMiniAppCard(senderId, agentId, 'nutrition')
            if (card) await sendCardSafe(space, card.url, card.live)
          } catch (err) {
            console.warn(`[${agent.id}] nutrition card after photo log failed`, err)
          }
        }
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
    let sentAnything = false
    const getTurn = onceAsync(() => runHireTurn({ agentId, dataDir, senderId, userText }))
    await respondWithRetry(space, () => sentAnything, async () => {
      const t0 = Date.now()
      const { bubbles, source, authoritative, reply, card, contactCardFirst } = await getTurn()
      const texts = bubbles.map((b) => sanitizeOutbound(b)).filter(Boolean)
      if (!texts.length) {
        if (card) {
          console.log(`[${agent.id}] sending card only: ${card.url}`)
          await sendCardSafe(space, card.url, card.live)
          sentAnything = true
        } else {
          console.warn(`[${agent.id}] dropped empty/banned outbound`)
        }
        logTurn(dataDir, {
          ts: new Date().toISOString(),
          persona: agentId,
          sender: hashPhone(senderId),
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
      if (contactCardFirst) {
        await space.shareContactCard().catch((err) => console.error(`[${agent.id}] shareContactCard failed`, err))
        await sendContactVcf(space, senderId).catch((err) => console.error(`[${agent.id}] sendContactVcf failed`, err))
      }
      await message.reply(texts[0]!)
      sentAnything = true
      for (let i = 1; i < texts.length; i++) await space.send(texts[i]!)
      // Every response carries the mini-app card, attached after the LAST bubble.
      const delivered = card ?? (await defaultReplyCard(senderId, agentId))
      if (delivered) {
        console.log(`[${agent.id}] sending card: ${delivered.url}`)
        await sendCardSafe(space, delivered.url, delivered.live)
      }
      logTurn(dataDir, {
        ts: new Date().toISOString(),
        persona: agentId,
        sender: hashPhone(senderId),
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
