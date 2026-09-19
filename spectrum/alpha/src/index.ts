import { Spectrum, UnsupportedError, app as appCard, attachment, contact, fromVCard, markdown, type ContentInput } from 'spectrum-ts'
import { effect, imessage } from '@spectrum-ts/imessage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultReplyCard, getAgent, runHireTurn, runMemoryMaintenance, sanitizeOutbound } from '../../shared/runHireTurn'
import { groupTurnLine, groupTurnNote, type SpaceParticipant } from '../../shared/groupChat'
import { fetchLiveProfile } from '../../shared/liveContext'
import { extractMessageText, fetchLiveProfile, findInboundVoice, handleInboundPhoto, resolveInboundVoiceTurn } from '../../shared/liveContext'
import { mintMiniAppCard, onboardingCard } from '../../shared/miniApps'
import { claimInbound } from '../../shared/inboundGuard'
import { onceAsync } from '../../shared/delivery'
import { createReactionGate, bubbleGapMs } from '../../shared/progressiveDelivery'
import { createTapbackRhythm, determineInboundReaction } from '../../shared/smartReactions'
import { createMessageBursts } from '../../shared/messageBursts'
import { startReminderScheduler } from '../../shared/reminders'
import { buildSaveContactText, startTaskLoopPoller } from '../../shared/taskLoops'
import { INTRO_TEXTS, startIntroPoller } from '../../shared/introQueue'
import { startScheduledTextPoller } from '../../shared/scheduledTexts'
import { startHealthServer, startHeartbeat } from '../../shared/health'
import { backfillScores, hashPhone, logTurn, readTurns } from '../../shared/evals'
import { buildAlphaVcard, resolveAlphaContactPhone } from '../../shared/alphaContact'

const reactOccasionally = createReactionGate()
const tapbackRhythm = createTapbackRhythm()
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
 * contact card with Alpha's avatar logo. Resolves the user's assigned line
 * best-effort, falling back to Alpha's primary line, and embeds the official photo. */
async function sendContactVcf(
  space: { phone?: string; send: (content: ContentInput) => Promise<unknown> },
  phone: string,
): Promise<void> {
  const tel = await resolveAlphaContactPhone(phone, space.phone)
  if (!tel) throw new Error(`Photon has not provided an assigned line for ${phone}`)
  const vcf = buildAlphaVcard(tel)

  try {
    await space.send(contact(await fromVCard(vcf)))
    console.log(`[${agentId}] sent vcf contact card to ${phone} (${tel}) with logo`)
  } catch (err) {
    console.error(`[${agentId}] vcf contact send failed`, err)
    throw err
  }
}

/** Send the branded vCard directly. Native contact sharing is Business-only,
 * while a vCard preserves Alpha's name, logo, and actual sending number on
 * every Photon tier. */
async function shareAlphaContact(
  space: { send: (content: ContentInput) => Promise<unknown> },
  phone: string,
): Promise<void> {
  await sendContactVcf(space, phone)
}

if (introTo) {
  try {
    const user = await im.user(introTo)
    const space = await im.space.create(user)
    await space.responding(async () => {
      await sendIntroText(space, INTRO_TEXTS[agent.id])
      await shareAlphaContact(space, introTo).catch((err) => console.error(`[${agent.id}] intro contact card failed`, err))
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
      if (cleaned) await sendIntroText(space, cleaned)
      await shareAlphaContact(space, phone).catch((err) => console.error(`[${agent.id}] intro contact card failed`, err))
      // Deliver the onboarding mini-app card so the user can tap to configure Alpha right away
      try {
        const card = await onboardingCard(phone, agent.id)
        if (card) await sendCardSafe(space, card.url, card.live)
      } catch (cardErr) {
        console.warn(`[${agent.id}] intro onboarding card failed`, cardErr)
      }
    })
  },
})

// Scheduled send-on-behalf ("wish mom happy birthday at midnight"): the bot
// side of hire_scheduled_texts. Plain text, no onboarding chrome.
startScheduledTextPoller(agent.id, async (phone, text) => {
  const user = await im.user(phone)
  const space = await im.space.create(user)
  await space.responding(async () => {
    const cleaned = sanitizeOutbound(text)
    if (cleaned) await space.send(styledText(cleaned))
  })
})

startHealthServer(agent.id, {
  readEvals: () => readTurns(dataDir, { limit: 60 }),
  scoreEvals: () => backfillScores(dataDir, 20),
})
startHeartbeat(agent.id)
console.log(`[${agent.id}] listening as ${agent.imsgName} (${agent.phoneNumber})`)

startTaskLoopPoller({
  persona: agent.id,
  send: async (phone, text, image) => {
    const user = await im.user(phone)
    const space = await im.space.create(user)
    await space.responding(async () => {
      // Strip the internal marker so it never shows to the user.
      const visible = text.replace(/^\[savecontact\]\s*/i, '')
      const cleaned = sanitizeOutbound(visible)
      if (cleaned) await space.send(styledText(cleaned))
      // A screenshot is the proof a browser run happened and a way for the user
      // to check the choice before money moves. Best-effort: a failed image
      // must never cost the text that explains it.
      if (image?.dataUrl) {
        try {
          const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image.dataUrl)
          if (match) {
            const bytes = Buffer.from(match[2]!, 'base64')
            // iMessage rejects very large attachments; 4MB is comfortably under
            // the limit and a page JPEG at quality 45 is far smaller.
            if (bytes.byteLength > 0 && bytes.byteLength <= 4_000_000) {
              await space.send(attachment(bytes, { mimeType: match[1]!, name: 'session.jpg' }))
              // The caption is a label for a picture sent without prose; when
              // the bubble already carries the result text, a trailing
              // "Step 9" line is noise (seen live glued to the receipt).
              const caption = sanitizeOutbound(image.caption || '').slice(0, 300)
              if (caption && !String(text || '').trim()) await space.send(styledText(caption))
            }
          }
        } catch (err) {
          console.warn(`[${agentId}] screenshot send failed`, err)
        }
      }
      // One-off save-contact nudge uses the same native-first path as intro.
      if (/^\[savecontact\]/i.test(text)) {
        await shareAlphaContact(space, phone).catch((err) => console.error(`[${agentId}] contact card failed`, err))
      }
    })
  },
  runKind: {
    save_contact: async (task) => ({
      text: `[savecontact] ${buildSaveContactText(String(task.phone || ''))}`,
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
      if (cleaned) await space.send(styledText(cleaned))
      if (card) await sendCardSafe(space, card.url, card.live)
    })
  },
})

type Incoming = typeof app.messages extends AsyncIterable<infer T> ? T : never
async function handleIncoming([space, message]: Incoming, combinedText?: string) {
  if (message.direction === 'outbound') return

  if (message.content.type === 'read') {
    try {
      const target = message.content.target
      console.log(
        `[${agent.id}] ${message.sender?.id ?? 'reader'} read ${target.id} at ${message.timestamp.toISOString()}`,
      )
    } catch {
      /* ignore */
    }
    return
  }

  if (message.content.type !== 'text') {
    // Non-text: a bare food photo, an iMessage text+photo group, or a location
    // share ("You started sharing location with Alpha" rides the thread as a
    // system bubble — acknowledge it instead of ignoring it silently).
    const senderId = message.sender?.id ?? space.id
    const contentKind = (message.content as { type?: string; payload?: { type?: string } }).type || ''
    if (contentKind === 'location' || (message.content as { location?: unknown }).location) {
      try {
        const reply = sanitizeOutbound("Got your location — I'll use it for nearby searches. What are we finding?")
        if (reply) {
          await space.responding(async () => {
            await message.reply(styledText(reply))
          })
        }
      } catch (err) {
        console.warn(`[${agent.id}] location ack failed`, err)
      }
      return
    }
    // Voice note: transcribe it and run it as the user's own turn.
    if (findInboundVoice(message.content)) {
      await runTurn(space, message, senderId, () => resolveInboundVoiceTurn(senderId, agent.id, message.content))
      return
    }
    try {
      const photoReply = await handleInboundPhoto(senderId, agent.id, message.content)
      const photoText = extractMessageText(message.content)
      if (!photoReply && !photoText) return
      if (photoText) {
        // Text came with the photo: run the normal turn with a note so the
        // reply can acknowledge the logged meal.
        if (!claimInbound(senderId, photoText, message.id)) {
          console.warn(`[${agent.id}] duplicate inbound skipped: ${message.id}`)
          return
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
          await message.reply(styledText(texts[0]!))
          for (let i = 1; i < texts.length; i++) {
            await new Promise((resolve) => setTimeout(resolve, bubbleGapMs(i, texts[i]!.length)))
            await space.send(styledText(texts[i]!))
          }
          // The mini-app card lands after the LAST bubble only, never between them.
          const delivered = card ?? (await defaultReplyCard(senderId, agentId))
          if (delivered) await sendCardSafe(space, delivered.url, delivered.live)
          if (source === 'gmi') {
            void runMemoryMaintenance({ dataDir, senderId, agentId, authoritative, userText: photoText, reply })
              .catch(() => undefined)
          }
        })
        return
      }
      if (photoReply) {
        const cleaned = sanitizeOutbound(photoReply)
        if (cleaned) {
          await message.reply(styledText(cleaned))
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
    return
  }

  const userText = combinedText ?? message.content.text.trim()
  if (!userText) return
  const senderId = message.sender?.id ?? space.id
  /* A group thread changes who is being answered and what may be said in it.
   * The note is null for a DM, so nothing about the ordinary path changes. */
/* Which member of a group owns the account Alpha works for — the person who
 * added it. Cached per space: the answer cannot change often, and every group
 * turn would otherwise spend a lookup per member. Falls back to the speaker so
 * a group with no account holder still gets the stranger path rather than
 * silence. */
const groupOwnerCache = new Map<string, string>()
async function resolveGroupOwner(spaceId: string, members: SpaceParticipant[] | undefined, speakerId: string): Promise<string> {
  const hit = groupOwnerCache.get(spaceId)
  if (hit) return hit
  const candidates = (members || [])
    .map((m) => String(m.id || m.address || ''))
    .filter((id) => /^\+?\d{7,}$/.test(id))
    .slice(0, 6)
  for (const phone of candidates) {
    try {
      const live = await fetchLiveProfile(phone, 'friend')
      if (live.found && live.hired) {
        groupOwnerCache.set(spaceId, phone)
        return phone
      }
    } catch {
      /* try the next member */
    }
  }
  return speakerId
}

  const groupNote = groupTurnNote({
    ...(space.type ? { spaceType: space.type } : {}),
    ...(Array.isArray(space.members) ? { members: space.members } : {}),
    speakerId: senderId,
    speakerName: (message.sender as { name?: string } | undefined)?.name || '',
  })
  if (groupNote) {
    /* The thread is the account holder's — one conversation with named people,
     * not one thread per member — while the note explains who is speaking and
     * what may be said in front of the others. The stored line carries the
     * speaker so next week's history still reads as a group. */
    const owner = await resolveGroupOwner(space.id, space.members, senderId)
    const speaker = (message.sender as { name?: string } | undefined)?.name || senderId
    console.log(`[${agent.id}] group turn from ${speaker} in ${space.id} (owner ${owner})`)
    await runTurn(space, message, owner, { text: userText, note: groupNote, threadLine: groupTurnLine(speaker, userText) })
    return
  }
  await runTurn(space, message, senderId, userText)
}

type SpaceLike = {
  id: string
  send: (content: ContentInput) => Promise<unknown>
  responding: <T>(fn: () => T | Promise<T>) => Promise<T>
  /** The provider's space type. 'group' means a multi-member thread; absent
   * means the older shape and is treated as a DM. */
  type?: string
  /** Members, when the provider exposes them. Read defensively: the field is
   * optional in the SDK's shape and absent on some spaces. */
  members?: SpaceParticipant[]
}
type MessageLike = {
  reply: (content: ContentInput) => Promise<unknown>
  react: (value: string) => Promise<unknown>
}

/** A turn's user text: a typed message, or a voice note whose transcript has
 * to be fetched first. Lazy so the transcription can run inside the responding
 * block and the typing indicator covers the wait. */
type TurnInput =
  | string
  | { text: string; note: string; threadLine?: string }
  | (() => Promise<{ userText: string; note?: string; threadLine?: string } | null>)

/**
 * Run one inbound user turn and deliver it: tapback rhythm, retry past
 * Photon's new-user gate, bubble pacing, the mini-app card, and the eval log.
 * Typed messages and transcribed voice notes both land here, so a voice note
 * gets exactly the same treatment as a typed ask.
 */
async function runTurn(
  space: SpaceLike,
  message: MessageLike,
  senderId: string,
  turn: TurnInput,
): Promise<void> {
  let sentAnything = false
  let progressTexts = 0
  let reacted = false

  // Resolution, the opening tapback, and the turn itself all sit inside one
  // once-guard: respondWithRetry replays the body after Photon's new-user gate,
  // and a replayed voice note must not be transcribed or reacted to twice.
  const getTurn = onceAsync(async () => {
    const resolved =
      typeof turn === 'string'
        ? { userText: turn, note: undefined, threadLine: undefined }
        : typeof turn === 'function'
          ? await turn()
          : { userText: turn.text, note: turn.note, threadLine: turn.threadLine }
    if (!resolved) return null
    const { userText, note, threadLine } = resolved
    console.log(`[${agent.id}] inbound from ${senderId}: ${userText.slice(0, 120)}`)

    const startReaction = determineInboundReaction({ dataDir, senderId, userText })
    // A live conversation still gets tapbacks, just not every turn: the rhythm
    // counts inbound turns and spends one every few. An opening reaction restarts
    // the count so the next mid-thread one is never back-to-back with it.
    const smartReaction = startReaction ?? tapbackRhythm.note(senderId, userText)
    if (startReaction) tapbackRhythm.reset(senderId)
    if (smartReaction) {
      reacted = true
      console.log(`[${agent.id}] smart reaction to ${senderId}: ${smartReaction}`)
      message.react(smartReaction).catch(err => console.warn(`[${agent.id}] initial react failed:`, err))
    }

    const result = await runHireTurn({ agentId, dataDir, senderId, userText, ...(note ? { inboundNote: note } : {}), ...(threadLine ? { threadLine } : {}), delivery: {
      onProgress: async text => {
        const clean = sanitizeOutbound(text)
        if (!clean) throw new Error('Progress text was filtered')
        // Mark attempted before sending: ambiguous delivery must not restart work.
        sentAnything = true
        await space.send(styledText(clean))
        progressTexts++
      },
      onReaction: reaction => {
        if (reacted) return Promise.resolve()
        return reactOccasionally(JSON.stringify([space.id, senderId]), reaction, value => {
          reacted = true
          return message.react(value)
        })
      },
    } })
    return { ...result, userText }
  })

  try {
    await respondWithRetry(space, () => sentAnything, async () => {
      const t0 = Date.now()
      const turnResult = await getTurn()
      if (!turnResult) {
        // A voice note we could not transcribe: ask for it again rather than
        // running a turn on an empty ask.
        await message.reply(styledText("That voice note didn't come through. Send it again, or just type it?"))
        sentAnything = true
        return
      }
      const { bubbles, source, authoritative, reply, card, contactCardFirst, userText, images } = turnResult
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
        await shareAlphaContact(space, senderId).catch((err) => console.error(`[${agent.id}] contact card failed`, err))
      }
      await message.reply(styledText(texts[0]!))
      sentAnything = true
      for (let i = 1; i < texts.length; i++) {
        // Bubbles arrive with a human gap instead of all at once, so a reply
        // split into parts reads as someone typing, not a batch landing.
        await new Promise((resolve) => setTimeout(resolve, bubbleGapMs(i, texts[i]!.length)))
        await space.send(styledText(texts[i]!))
      }
      // A generated picture goes out as a real attachment, the same path a
      // browser screenshot takes. Best-effort: a failed image must never cost
      // the text that describes it.
      for (const image of images || []) {
        try {
          const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image.dataUrl)
          if (!match) continue
          const bytes = Buffer.from(match[2]!, 'base64')
          if (!bytes.byteLength || bytes.byteLength > 4_000_000) {
            console.warn(`[${agent.id}] image dropped: ${bytes.byteLength} bytes`)
            continue
          }
          const ext = match[1]!.includes('png') ? 'png' : 'jpg'
          await space.send(attachment(bytes, { mimeType: match[1]!, name: `alpha-image.${ext}` }))
        } catch (err) {
          console.warn(`[${agent.id}] image send failed`, err)
        }
      }
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
        texts: texts.length + progressTexts,
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
      await space.send(styledText('Got tripped up for a sec. Try me again?'))
    } catch {
      /* ignore */
    }
  }
}

const bursts = createMessageBursts<Incoming>({
  run: async (items) => {
    const last = items[items.length - 1]!
    const combined = items.every(([, message]) => message.content.type === 'text')
      ? items.map(([, message]) => message.content.type === 'text' ? message.content.text.trim() : '').join('\n')
      : undefined
    await handleIncoming(last, combined)
  },
  onError: (error) => console.error(`[${agent.id}] inbound batch failed:`, error),
})

/** One inbound message, from wherever it arrived (the live stream or the boot
 * catch-up below). Identical body either way, so a replayed message is claimed,
 * read and queued exactly like a live one. */
function intakeMessage(incoming: Incoming): void {
  const [space, message] = incoming
  if (message.direction === 'outbound') return
  if (message.content.type === 'read') {
    void handleIncoming(incoming).catch(() => undefined)
    return
  }
  const senderId = message.sender?.id ?? space.id
  const isText = message.content.type === 'text'
  if (isText) {
    const text = message.content.type === 'text' ? message.content.text.trim() : ''
    if (!text || !claimInbound(senderId, text, message.id)) return
    // Acknowledge receipt immediately; response generation waits for the burst.
    void message.read().catch(() => undefined)
  } else if (findInboundVoice(message.content)) {
    // A voice note is a real ask: claim it so a redelivery can't be
    // transcribed and answered twice, and read it so the sender sees it land.
    if (!claimInbound(senderId, '', message.id)) return
    void message.read().catch(() => undefined)
  }
  bursts.enqueue(JSON.stringify([space.id, senderId]), incoming, isText)
}

/* Started BEFORE the stream loop, which never returns: anything after
 * `for await` would be dead code, and the first version of this shipped exactly
 * that way — the boot log proved it (health and "listening as", no catch-up
 * line). The stream buffers while this runs, so a live message is not lost. */
void catchUpMissedMessages().catch((err) => console.warn(`[${agent.id}] inbound catch-up failed:`, err))

for await (const incoming of app.messages) intakeMessage(incoming)

/* A message that arrives while this process is booting is otherwise lost for
 * good: the intake below is a live stream, so anything delivered during a
 * rolling update — a deploy, a restart, an OOM kill — is never seen again and
 * the user just gets silence. Measured 2026-09-19: a picks ask landed at the
 * exact second a container swapped (boot 17:41:29Z, ask 17:41:29Z) and never
 * appeared in the new container's log; the thread has no reply to this day.
 *
 * On boot, ask Photon for what arrived in the last few minutes and replay any
 * inbound message with nothing after it. `claimInbound` makes this idempotent:
 * a message the stream already handled is claimed and skipped, so the worst
 * case of a race is one duplicate attempt, and the common case of a restart is
 * a message that gets its answer instead of vanishing. */
const CATCHUP_WINDOW_MS = Number(process.env.INBOUND_CATCHUP_WINDOW_MS || 20 * 60 * 1000)
const CATCHUP_MAX = Number(process.env.INBOUND_CATCHUP_MAX || 10)

type HistoryMessage = {
  id: string
  direction?: string
  content?: { type?: string }
  sender?: { id?: string }
  timestamp?: Date | string
}
type RecentLister = (options?: { after?: Date; pageSize?: number; isFromMe?: boolean }) => Promise<{ messages: readonly HistoryMessage[] }>

/** How to page history. The provider exposes its handles on the object
 * `imessage(app)` returns — measured in production, they are `user, space,
 * messages, getMessage, getMembers, getAvatar, getDisplayName, getAttachment`,
 * and the first version of this looked for a `.client` that does not exist and
 * logged the list so this could be fixed from the boot log instead of guessed. */
function photonListRecent(): RecentLister | null {
  const direct = (im as unknown as { messages?: { listRecent?: unknown } }).messages
  if (typeof direct?.listRecent === 'function') return (direct.listRecent as RecentLister).bind(direct)
  const viaClient = (app as unknown as { client?: { messages?: { listRecent?: unknown } } }).client?.messages
  if (typeof viaClient?.listRecent === 'function') return (viaClient.listRecent as RecentLister).bind(viaClient)
  return null
}

async function catchUpMissedMessages(): Promise<void> {
  const listRecent = photonListRecent()
  if (!listRecent) {
    /* Name the handles the provider does expose. The history handle is the one
     * missing piece, and a warning that says only "unavailable" costs another
     * deploy cycle to chase down. */
    const handles = Object.keys((im ?? {}) as unknown as Record<string, unknown>).join(', ')
    console.warn(
      `[${agent.id}] inbound catch-up unavailable: no history handle (provider handles: ${handles || 'none'}); a message delivered during a restart will be lost`,
    )
    return
  }
  const after = new Date(Date.now() - CATCHUP_WINDOW_MS)
  const page = await listRecent({ after, isFromMe: false, pageSize: 50 })
  const rows = (page.messages || []).filter((m) => m.content?.type === 'text' && m.sender?.id)
  if (!rows.length) return
  /* The newest message per sender decides: if the last thing in a thread is
   * theirs, nobody answered it. Anything older than that last one was already
   * answered or superseded. */
  const newestAt = new Map<string, number>()
  for (const m of rows) {
    const at = m.timestamp ? new Date(m.timestamp).getTime() : 0
    const key = m.sender!.id!
    if (!newestAt.has(key) || at > newestAt.get(key)!) newestAt.set(key, at)
  }
  const missed = rows
    .filter((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0) >= (newestAt.get(m.sender!.id!) || 0))
    .slice(0, CATCHUP_MAX)
  if (!missed.length) return
  console.warn(`[${agent.id}] catch-up: replaying ${missed.length} inbound message(s) from the last ${Math.round(CATCHUP_WINDOW_MS / 60000)} min`)
  for (const message of missed) {
    try {
      const user = await im.user(message.sender!.id!)
      const space = await im.space.create(user)
      intakeMessage([space, message] as unknown as Incoming)
    } catch (err) {
      console.warn(`[${agent.id}] catch-up replay failed for ${message.sender?.id}:`, err)
    }
  }
}


