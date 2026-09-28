/**
 * HireAlpha live config + connectors API (Postgres).
 * Dashboard writes here. iMessage bots read here.
 */
import { sweepExpiredArtifacts, artifactsRoot } from './workshop'
import { handleWorkshopRoutes } from './routes/workshop'
import { handleBrowserRoutes } from './routes/browser'
import { handleCancelWorkRoutes } from './routes/cancelWork'
import { handlePlanRoutes } from './routes/plans'
import type { SQL } from 'bun'
import {
  extractOtherPerson,
  formatClock,
  formatDigestEventLabel,
  isHotelStayEvent,
  isTravelOrStayTitle,
  parseFormattedEventLine,
  type CalItem,
} from './calendarEvents'
import { COMPOSIO_READ, composioLooksFailed } from './composioPlugins'
// The canonical persona capability matrix. deploy/ has no prior src/ import;
// this one is deliberate — the skill lists must have exactly one home.
import {
  DEMO_PHONE,
  demoModeEnabled,
  isDemoUserId,
} from './demoData'
import { handleVaultApi } from './browserVault'
import { runPortalTask } from './browserRunner'
import {
  handleUserPaymentsApi,
} from './userPayments'
import { openBaoBrokerFromEnv, userKeyBrokerFromEnv } from '../services/trust/userKeyBroker'
import { handleTrustApi } from '../services/trust/trustApi'
import {
  ensureMemoryConsent,
} from '../services/trust/memoryLifecycle'
import {
  type MemoryRow,
  getMemoryIndex,
  recallMemories,
} from './memory/store'
import { scanSubscriptions } from '../spectrum/shared/smartFeatures'
import { PLACE_ASK_RE } from '../spectrum/shared/toolLoop'
import { inQuietHours } from '../spectrum/shared/judgment'
import {
  isValidTimeZone,
  localDateStrInTz,
  nextLocalTimeUtc,
  nextWeekdayLocalUtc,
  resolveIanaTimezone,
  todayWindowUtc,
  weekWindowUtc,
  shiftDateStr,
  ymdOf,
  mondayOfDateStr,
  userMonday,
} from './timezones'
import { PERSONAS, isPersona, PERSONA_DENIED, type Persona } from './personas'
import { normalizePhone } from './utils/phone'
import { json, appBase } from './utils/http'
import {
  type AuthedUser,
  getUserByEmail,
  getUserByPhone,
} from './db/users'
import {
  ensureHireSchema,
  purgeExpiredChatData,
} from './db/schema'
export { ensureHireSchema, purgeExpiredChatData }
import {
  mintMiniToken,
  verifyMiniToken,
  verifySessionToken,
  requestIdentity,
  resolveAuthedUser,
} from './auth/session'
import {
  resetLoginFailures,
  attachPasswordToAccount,
} from './auth/passwords'
import { handleAuthRoutes } from './routes/auth'
import { handleConnectorRoutes, GOOGLE_CONNECTORS } from './routes/connectors'
import {
  billingConfigured,
  subscriptionActive,
  verifyStripeSignature,
  upgradePromoSubscriptions,
  paymentsOn,
} from './billing/stripe'
import { handleBillingRoutes } from './routes/billing'
import {
  TASK_LOOP_MAX_ATTEMPTS,
  seedDefaultLoops,
  trialTierLabel,
  armTrialEndingLoops,
  armBirthdayReminders,
  armStreakEndedLoops,
  armOverworkCheckLoops,
  armQuietCheckLoops,
  scheduleDay1Checkin,
  claimDueLoops,
  finishTaskLoop,
} from './loops/engine'
import { handleLoopRoutes } from './routes/loops'
import { sleepHoursBetween } from './habits/parsers'
import {
  loadMiniPrefs,
  saveMiniPrefs,
  type MiniPrefs,
} from './habits/prefs'
import { handleHabitRoutes } from './routes/habits'
import { handleMemoryRoutes } from './routes/memory'
import { handleMediaRoutes } from './routes/media'
import { handleCofounderRoutes } from './routes/cofounder'
import { handleCorpusRoutes } from './routes/corpus'
import { handleMiniRoutes } from './routes/mini'
import { loadContext, upsertContext, parseSetupField } from './db/context'
import {
  stripNudgeDashes,
  meetingWho,
  loopNudgeText,
  decisionNudgeText,
  meetingNudgeText,
  slugNudge,
  slackMentionText,
  linearAssignedText,
} from './nudges/formatters'
import {
  minutesAgo,
  localClock,
  isGenZUser,
  NUDGE_SKIP_LOG_INTERVAL_MS,
  type NudgeSkipRecord,
  shouldEmitNudgeSkip,
  nudgeSkipLogMemo,
  outboundNudgeBlock,
} from './nudges/gating'
import {
  type FlightEventHit,
  extractFlightEvent,
  isTravelConfirmation,
  WATCHTOWER_REGEX_BAR,
  WATCHTOWER_JUDGE_BAR,
  WATCHTOWER_URGENT_SCORE,
  WATCHTOWER_MIN_HOURS_BETWEEN_PINGS,
  type WatchtowerCandidate,
  pickWatchtowerCandidates,
} from './nudges/watchtower'
import { type EventNudge } from './nudges/types'
import { handleNudgeRoutes } from './routes/nudges'
import { handleInviteRoutes } from './routes/invites'
import { handleReviewRoutes } from './routes/reviews'
import { handlePipelineRoutes } from './routes/pipeline'
import { handleNetworkRoutes } from './routes/network'
import { handleTaskRoutes } from './routes/tasks'
import { handleWorkRoutes } from './routes/work'
import { handleMailRoutes } from './routes/mail'
import { handleDigestRoutes } from './routes/digest'
import { handleHomeRoutes } from './routes/home'
import { handleSetupRoutes } from './routes/setup'
import { handleLearningRoutes } from './routes/learning'
import { handleDecisionRoutes } from './routes/decisions'
import { handleDropzoneRoutes } from './routes/dropzone'
import { handleMeetingRoutes } from './routes/meetings'
import { handleReminderRoutes } from './routes/reminders'
import { handleMeRoutes } from './routes/me'
import { handleLiveRoutes, WORK_READ_TOOLS, type LiveToolWant } from './routes/live'
import { handleProposalRoutes } from './routes/proposals'
import { handleAnchorRoutes } from './routes/anchors'
import { loadGmailFullMessage } from './google/attachments'
import { upsertThreadState } from './mailState'
import { mailWaitingOnYou } from './gmailHelpers'

export {
  loadContext,
  upsertContext,
  parseSetupField,
  type FlightEventHit,
  extractFlightEvent,
  WATCHTOWER_REGEX_BAR,
  WATCHTOWER_JUDGE_BAR,
  WATCHTOWER_URGENT_SCORE,
  WATCHTOWER_MIN_HOURS_BETWEEN_PINGS,
  isTravelConfirmation,
  type WatchtowerCandidate,
  pickWatchtowerCandidates,
  isGenZUser,
  NUDGE_SKIP_LOG_INTERVAL_MS,
  type NudgeSkipRecord,
  shouldEmitNudgeSkip,
  outboundNudgeBlock,
  slackMentionText,
  linearAssignedText,
  type EventNudge,
}

export {
  type AuthedUser,
  getUserByEmail,
  verifySessionToken,
  resetLoginFailures,
  attachPasswordToAccount,
  billingConfigured,
  subscriptionActive,
  verifyStripeSignature,
  upgradePromoSubscriptions,
  TASK_LOOP_MAX_ATTEMPTS,
  seedDefaultLoops,
  trialTierLabel,
  armTrialEndingLoops,
  armBirthdayReminders,
  armStreakEndedLoops,
  armOverworkCheckLoops,
  armQuietCheckLoops,
  scheduleDay1Checkin,
  claimDueLoops,
  finishTaskLoop,
  type MiniPrefs,
  loadMiniPrefs,
  saveMiniPrefs,
}
export {
  isClock,
  toHHMM,
  sleepHoursBetween,
  estimateNutrition,
  parseWorkoutText,
  parseSleepText,
  sleepFromHours,
  parseGratitudeText,
  parseSpendText,
  parseMoodReply,
  parseDecisionText,
  parsePipelineText,
  PIPELINE_STAGES,
  SPEND_CATEGORIES,
} from './habits/parsers'
import {
  cleanMailSnippet,
  formatBriefPreview,
  importantMailQuery,
  groupBriefMail,
  groupMailByKind,
  classifyBriefMail,
  mailTally,
  topNeedsYou,
  MAIL_READ_CAP,
  MAIL_READ_WINDOW,
  mailResultsBlock,
  mailRow,
  type MailKindItem,
} from './gmailHelpers'

import {
  JUDGE_MAIL_CAP,
  judgeRowFresh,
  type JudgeMeetIn,
  type JudgeAll,
  type MailVerdict,
} from './aiJudge'
import {
  gmiBriefChat,
  judgeBriefMail,
  judgeAllBatch,
  readJudgeRow,
  loadJudgeVerdicts,
  judgedAttentionPick,
  meetJudgeKey,
  loadMailKindVocab,
  saveMailKindVocab,
  briefRowFresh,
  briefRowSameDay,
  readBriefDb,
  writeBriefDb,
} from './briefs/judgment'
export {
  briefRowFresh,
  briefRowSameDay,
  loadJudgeVerdicts,
  judgedAttentionPick,
  meetJudgeKey,
  gmiBriefChat,
  judgeBriefMail,
  readBriefDb,
  writeBriefDb,
}
import { createStaleCache } from './staleCache'
import { createBoundedMap } from './utils/boundedMap'
import { withIdempotency } from './utils/idempotency'
import { composeWeekReview, type WeekSnap } from './weekRun'

export { PERSONAS, isPersona, PERSONA_DENIED, type Persona } from './personas'
import { stripHtml } from './utils/text'
import {
  buildPrepBundle,
  buildMeetingPrep,
  nextSharedMeeting,
  buildPrepBrief,
  loadGmailMessageBody,
  type PrepCandidate,
  type PrepThread,
  type PrepBrief,
} from './work/prep'
export {
  buildPrepBundle,
  buildMeetingPrep,
  nextSharedMeeting,
  buildPrepBrief,
  type PrepCandidate,
  type PrepThread,
  type PrepBrief,
}
import {
  type StandupFacts,
  assembleStandupText,
  assembleAutoStandup,
  formatSlotLabel,
  type SlotRange,
  partOfDayWindow,
  suggestSlotRanges,
  suggestSlotsFromBusy,
  type LinearIssueInput,
  parseLinearIssues,
  scoreLinearIssues,
  walkLinearIssues,
  listLinearIssues,
  type NextRow,
  buildNextStack,
} from './work/stack'
export {
  assembleStandupText,
  assembleAutoStandup,
  formatSlotLabel,
  partOfDayWindow,
  suggestSlotRanges,
  suggestSlotsFromBusy,
  parseLinearIssues,
  scoreLinearIssues,
  buildNextStack,
  type StandupFacts,
  type SlotRange,
  type LinearIssueInput,
  type NextRow,
}
export { normalizePhone, phonesMatch } from './utils/phone'
export { todayWindowUtc, weekWindowUtc, nextDailyUtc, nextWeeklyUtc, nextEveryDaysUtc } from './timezones'

/** Personas a NEW signup can hire today. The rest render as coming soon — the
 * bots stay live for people who already hired them, but no new roster entries,
 * intros, or signups book them until they ship. One list, flipped per launch. */
export const HIRES_LIVE: readonly string[] = ['friend']
export function hireIsLive(p: string): boolean {
  return HIRES_LIVE.includes(p)
}

export { GOOGLE_CONNECTORS }
import {
  UI_TO_COMPOSIO,
  COMPOSIO_SLUG_ALIASES,
  composioKey,
  composioClient,
  dropDuplicateConnections,
  composioResolveAccountId,
  composioPinnedAccountId,
  composioInvalidatePin,
  composioConnected,
  clearComposioCache,
  composioDisconnect,
  googleUiConnected,
  googleConnected,
  connectedForUser,
  composioAuthConfigId,
  composioAuthorize,
  googleAccessToken,
  fetchGmail,
  startOfLocalDay,
  fetchCalendarItems,
  isCalendarToolResult,
  fetchCalendarViaComposio,
  loadCalendar,
  formatEmailOverview,
  toolkitForToolSlug,
  composioExecuteWithPin,
  composioExecuteData,
  composioExecute,
  composioFirst,
  googleScopesFor,
  GOOGLE_SCOPES,
  GOOGLE_READONLY_SCOPES,
  loadGmailRich,
  loadGmail,
  loadDrive,
  fetchDrive,
  runComposioPlugin,
  readGmailExact,
  gmailAccess,
  fetchGmailRich,
  composioGmailRich,
  composioMailData,
  composioMailBody,
  composioMailHeaders,
  normalizeGmailQuery,
  relaxedGmailQuery,
  googleTokenWithStatus,
  type ConnectorFailureReason,
  type ConnectorStatus,
} from './connectors/hub'
export {
  UI_TO_COMPOSIO,
  COMPOSIO_SLUG_ALIASES,
  composioKey,
  composioClient,
  dropDuplicateConnections,
  composioResolveAccountId,
  composioPinnedAccountId,
  composioInvalidatePin,
  composioConnected,
  clearComposioCache,
  composioDisconnect,
  googleUiConnected,
  googleConnected,
  connectedForUser,
  composioAuthConfigId,
  composioAuthorize,
  googleAccessToken,
  fetchGmail,
  startOfLocalDay,
  fetchCalendarItems,
  isCalendarToolResult,
  fetchCalendarViaComposio,
  loadCalendar,
  formatEmailOverview,
  toolkitForToolSlug,
  composioExecuteWithPin,
  composioExecuteData,
  composioExecute,
  composioFirst,
  googleScopesFor,
  GOOGLE_SCOPES,
  GOOGLE_READONLY_SCOPES,
  loadGmailRich,
  loadGmail,
  loadDrive,
  fetchDrive,
  runComposioPlugin,
  readGmailExact,
  gmailAccess,
  fetchGmailRich,
  composioGmailRich,
  composioMailData,
  composioMailBody,
  composioMailHeaders,
  normalizeGmailQuery,
  relaxedGmailQuery,
}
import {
  rfc822Raw,
  gmailSendMessage,
  gmailCreateDraft,
  calItemsToNextRows,
  googleEventsRaw,
  localHourParts,
  findFreeSlots,
  calendarHold,
} from './google/actions'
export {
  rfc822Raw,
  gmailSendMessage,
  gmailCreateDraft,
  calItemsToNextRows,
  googleEventsRaw,
  localHourParts,
  findFreeSlots,
  calendarHold,
}

/* Connectors a persona may not touch even when the account is connected.
 * The friend list is deliberately empty now: it used to refuse Slack, Notion,
 * Linear, GitHub, Stripe and Figma outright, which meant a user who connected
 * their own Notion or Slack was told the connector was "off limits for this
 * hire" by the assistant that was supposed to use it — exactly what the
 * Integrations and Permissions dimensions score. Connection is the gate: the
 * user opted in by authorizing the account, and nothing in the friend path can
 * write to those services (they are read-only tool specs). Proactive work data
 * still never enters a friend brief unless the user made that connection.
 * Founder: this reverses a prior posture — revert this one line if the friend
 * should stay out of work connectors. */

export { artifactsRoot, sweepExpiredArtifacts }




function internalOk(req: Request) {  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!key) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${key}`
}

import {
  enqueueIntro,
} from './db/intros'

/**
 * A phone-only signup gets an account before it has an email, so the intro is
 * followed by a real thread: touch, memory, and pokes attach on the first
 * reply. The email is a placeholder; when the person later signs in with
 * Google, ensureUser adopts this row by phone instead of colliding with the
 * phone_e164 unique index.
 */
export async function ensurePhoneUser(
  sql: SQL,
  phone: string,
  persona: Persona,
  name?: string,
  timezone?: string,
): Promise<string | null> {
  await enqueueIntro(sql, phone, persona)
  const e164 = normalizePhone(phone)
  if (!e164) return null
  const cleanName = String(name || '').trim().slice(0, 80) || null
  const cleanTz = timezone && isValidTimeZone(timezone) ? timezone : null
  const existing = await getUserByPhone(sql, e164)
  let userId = existing?.id
  if (!userId) {
    const placeholder = `${e164.replace(/\D/g, '')}@phone.hirealpha.chat`
    const inserted = (await sql`
      INSERT INTO hire_users (id, email, phone_e164, name, timezone)
      VALUES (${crypto.randomUUID()}, ${placeholder}, ${e164}, ${cleanName}, ${cleanTz})
      ON CONFLICT (phone_e164) DO UPDATE SET
        name = COALESCE(${cleanName}, hire_users.name),
        timezone = COALESCE(${cleanTz}, hire_users.timezone),
        updated_at = now()
      RETURNING id
    `) as Array<{ id: string }>
    userId = inserted[0]?.id
  }
  if (!userId) return null
  // Register the number with Photon right here, carrying the person's name and
  // email so the dashboard shows a contact, not "Unnamed user". Idempotent per
  // the create-user API. The assigned shared number is what this user must
  // text — await it, store it, and return it so every CTA can point at the
  // right line instead of the hardcoded bot number.
  const existingEmail = existing?.email || `${e164.replace(/\D/g, '')}@phone.hirealpha.chat`
  let assigned: string | null = existing?.assignedPhone || null
  try {
    assigned = (await registerPhotonUser(e164, cleanName, existingEmail)) || assigned
    if (assigned) {
      await sql`
        UPDATE hire_users SET assigned_phone = ${assigned}, updated_at = now()
        WHERE id = ${userId} AND (assigned_phone IS NULL OR assigned_phone <> ${assigned})
      `
    }
  } catch (err) {
    console.warn('[photon] register failed', err)
  }
  await sql`
    INSERT INTO hire_roster (user_id, persona) VALUES (${userId}, ${persona})
    ON CONFLICT (user_id, persona) DO NOTHING
  `
  // Hired means the person agreed to be remembered. Grant the persona's memory
  // categories here so the consent gate has something to pass on the first
  // fact; without it every memory write is refused and the hire is amnesiac.
  await ensureMemoryConsent(sql, { userId, persona, source: 'hire_activation' }).catch((err) => {
    console.warn('[memory] consent grant at activation failed', err)
  })
  // The number is armed: give this hire its default recurring jobs. The
  // wakeup lands at 8am in the user's zone when one was captured at signup,
  // else 8am Pacific until the zone is learned later.
  await seedDefaultLoops(sql, userId, e164, persona, cleanTz || undefined)
  // Anyone who gets a hire by phone is set up enough for the daily brief: arm
  // the default 8am digest unless a digest reminder or judge morning already
  // exists (a chosen brief time or the poke defaults win).
  await armMorningBrief(sql, { id: userId, timezone: cleanTz }, persona)
  return assigned
}

/** Best-effort Photon project-user registration. Needs PHOTON_PROJECT_ID and
 * PHOTON_PROJECT_SECRET on the web app; resolves to null when unset (the bot
 * retries phone-only before each intro send). The create-user API is
 * idempotent on an existing shared phoneNumber, updating name/email. Returns
 * the shared number Photon assigned (null when skipped/failed) so callers can
 * point the user at the right line. */
async function registerPhotonUser(phone: string, name: string | null, email: string): Promise<string | null> {
  const pid = process.env.PHOTON_PROJECT_ID || ''
  const secret = process.env.PHOTON_PROJECT_SECRET || ''
  if (!pid || !secret) return null
  try {
    const res = await fetch(`https://spectrum.photon.codes/projects/${pid}/users/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${pid}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'shared', phoneNumber: phone, firstName: name, email }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      console.warn(`[photon] register ${phone} -> ${res.status} ${body.message || ''}`)
      return null
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { assignedPhoneNumber?: string }
    }
    return body.data?.assignedPhoneNumber || null
  } catch (err) {
    console.warn('[photon] register failed', err)
    return null
  }
}

/** Live lookup of the shared number Photon currently assigns a phone, so
 * contact cards and CTAs always show the right line even if the pool
 * re-assigns. Null when unconfigured / not registered. */
async function photonAssignedNumber(phone: string): Promise<string | null> {
  const pid = process.env.PHOTON_PROJECT_ID || ''
  const secret = process.env.PHOTON_PROJECT_SECRET || ''
  if (!pid || !secret) return null
  try {
    const res = await fetch(`https://spectrum.photon.codes/projects/${pid}/users/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${pid}:${secret}`).toString('base64')}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => ({}))) as { data?: { users?: Array<{ phoneNumber?: string; assignedPhoneNumber?: string }> } }
    const hit = (body.data?.users || []).find((u) => u.phoneNumber === phone)
    return hit?.assignedPhoneNumber || null
  } catch (err) {
    console.warn('[photon] assigned lookup failed', err)
    return null
  }
}



/* ---- Calendar defense ----
 * One evening ping before a heavy day: real overlaps, tight gaps between
 * different places (the leave-now flag), and the single meeting most worth
 * prepping for. Quiet days arm nothing — no "clear calendar!" spam. Dedupe
 * rides on the date marker in last_result, same pattern as quiet_check. */

const PREP_TITLE_RE =
  /\b(interview|investor|board|performance\s*review|negotiat|offer|client|demo|pitch|kickoff|discovery|first\s*call|screening)\b/i

export type DayDefensePrep = { title: string; time: string; who: string; place: string }
export type DayDefense = {
  date: string
  conflicts: Array<{ a: string; b: string }>
  tights: Array<{ from: string; to: string; gapMin: number }>
  prep: DayDefensePrep | null
  firstOut: { title: string; time: string; place: string } | null
}

/** Pure overlap/gap/prep analysis over tomorrow's items. Null means a quiet
 * day — the arm stays silent. Pinned by tests. */
export function analyzeDayDefense(items: CalItem[], tz: string): DayDefense | null {
  const timed = items
    .filter((i) => !i.allDay && !Number.isNaN(i.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  if (!timed.length) return null
  const withEnd = timed.map((i) => ({
    ...i,
    end: i.end && i.end.getTime() > i.start.getTime() ? i.end : new Date(i.start.getTime() + 60 * 60 * 1000),
  }))
  const stamp = (d: Date) => formatClock(d, tz)
  const conflicts: DayDefense['conflicts'] = []
  for (let i = 0; i < withEnd.length; i++) {
    for (let j = i + 1; j < withEnd.length; j++) {
      if (withEnd[j]!.start.getTime() >= withEnd[i]!.end.getTime()) break
      conflicts.push({
        a: `${withEnd[i]!.title} (${stamp(withEnd[i]!.start)})`,
        b: `${withEnd[j]!.title} (${stamp(withEnd[j]!.start)})`,
      })
    }
  }
  const tights: DayDefense['tights'] = []
  for (let i = 0; i + 1 < withEnd.length; i++) {
    const gapMin = Math.round((withEnd[i + 1]!.start.getTime() - withEnd[i]!.end.getTime()) / 60_000)
    if (gapMin < 0 || gapMin >= 30) continue
    const aLoc = withEnd[i]!.location || ''
    const bLoc = withEnd[i + 1]!.location || ''
    const placeChange = aLoc !== bLoc && (!!aLoc || !!bLoc)
    if (placeChange || gapMin < 15) {
      tights.push({
        from: `${withEnd[i]!.title} (${stamp(withEnd[i]!.start)})`,
        to: `${withEnd[i + 1]!.title} (${stamp(withEnd[i + 1]!.start)})`,
        gapMin,
      })
    }
  }
  const prepSrc =
    withEnd.find((i) => PREP_TITLE_RE.test(i.title)) ??
    withEnd.find((i) => (i.attendeeCount ?? 0) >= 3) ??
    null
  const prep: DayDefensePrep | null = prepSrc
    ? (() => {
        const parsed = parseCalMeet(prepSrc.title)
        return {
          title: prepSrc.title,
          time: stamp(prepSrc.start),
          who: parsed.who,
          place: parsed.place || prepSrc.location || '',
        }
      })()
    : null
  const firstOutSrc = withEnd.find((i) => i.kind === 'In person' && i.location) ?? null
  const firstOut = firstOutSrc
    ? { title: firstOutSrc.title, time: stamp(firstOutSrc.start), place: firstOutSrc.location || '' }
    : null
  if (!conflicts.length && !tights.length && !prep && !firstOut) return null
  const date = startOfLocalDay(tz, 1).toLocaleDateString('en-CA', { timeZone: tz })
  return { date, conflicts, tights, prep, firstOut }
}

/** Arm tomorrow's defense for calendar-connected actives. Runs daily; each
 * user gets at most one ping per date, only when the day needs defending. */
export async function armCalendarDefense(sql: SQL): Promise<number> {
  const users = (await sql`
    SELECT DISTINCT u.id AS "userId", u.phone_e164 AS phone, u.timezone AS tz
    FROM hire_users u
    JOIN hire_google_tokens g ON g.user_id = u.id
    LEFT JOIN hire_brief_cache b ON b.user_id = u.id AND b.built_at > now() - interval '7 days'
    LEFT JOIN hire_intro_queue q ON q.phone_e164 = u.phone_e164 AND q.status = 'sent' AND q.created_at > now() - interval '7 days'
    WHERE b.user_id IS NOT NULL OR q.phone_e164 IS NOT NULL
    LIMIT 100
  `) as Array<{ userId: string; phone: string; tz: string | null }>
  let armed = 0
  for (const u of users) {
    try {
      if (!u.userId || !normalizePhone(u.phone)) continue
      const tz = u.tz || 'America/Los_Angeles'
      const access = await googleAccessToken(sql, u.userId, 'calendar')
      if (!access) continue
      const got = await withTimeout(
        fetchCalendarItems(access, { timeMin: startOfLocalDay(tz, 1), timeMax: startOfLocalDay(tz, 2), maxResults: 20 }),
        12000,
        null,
      )
      if (!got || !got.ok || !got.items.length) continue
      const defense = analyzeDayDefense(got.items, tz)
      if (!defense) continue
      const existing = (await sql`
        SELECT status, last_result AS "lastResult"
        FROM hire_task_loops
        WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'calendar_defense'
        LIMIT 1
      `) as Array<{ status: string; lastResult: string | null }>
      const row = existing[0]
      if (row) {
        if (row.status === 'pending' || row.status === 'running') continue
        if (row.status === 'done' && row.lastResult?.includes(defense.date)) continue
        await sql`
          UPDATE hire_task_loops SET
            title = 'Tomorrow needs defending',
            phone_e164 = ${u.phone},
            payload = ${JSON.stringify(defense)}::jsonb,
            status = 'pending',
            attempts = 0,
            last_result = NULL,
            next_run = now(),
            updated_at = now()
          WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'calendar_defense'
        `
        armed++
        continue
      }
      await sql`
        INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
        VALUES (${crypto.randomUUID()}, ${u.userId}, 'friend', ${u.phone}, 'calendar_defense',
          'Tomorrow needs defending', ${JSON.stringify(defense)}::jsonb, 'pending', now())
        ON CONFLICT (user_id, persona, kind) DO NOTHING
      `
      armed++
    } catch (err) {
      console.warn('[loops] calendar defense user failed', err)
    }
  }
  if (armed) console.log(`[loops] calendar_defense armed: ${armed}`)
  return armed
}

/* ---- Flight check-in (dimension 6) ----
 * The bot has had a flight_checkin handler since the beginning and NOTHING
 * ever created a flight_checkin loop, so a flight on the calendar produced at
 * most a "new calendar event" ping. Detection here is deliberately narrow: an
 * airline word or a carrier+number code, a timed (not all-day) start, and a
 * start in the future. Anything ambiguous stays null rather than pinging a
 * person about a flight they do not have. */

/** Arm a flight_checkin loop for a flight within the next 7 days. Idempotent
 * per user+departure: a re-scan updates the same row instead of texting twice.
 * next_run = check-in window (departure - 24h, clamped to now). */
export async function armFlightCheckins(sql: SQL): Promise<number> {
  const users = (await sql`
    SELECT DISTINCT u.id AS "userId", u.phone_e164 AS phone, u.timezone AS tz
    FROM hire_users u
    JOIN hire_google_tokens g ON g.user_id = u.id
    LEFT JOIN hire_brief_cache b ON b.user_id = u.id AND b.built_at > now() - interval '7 days'
    LEFT JOIN hire_intro_queue q ON q.phone_e164 = u.phone_e164 AND q.status = 'sent' AND q.created_at > now() - interval '7 days'
    WHERE (b.user_id IS NOT NULL OR q.phone_e164 IS NOT NULL)
      AND u.phone_e164 IS NOT NULL
    LIMIT 100
  `) as Array<{ userId: string; phone: string; tz: string | null }>
  let armed = 0
  for (const u of users) {
    try {
      if (!u.userId || !normalizePhone(u.phone)) continue
      const tz = u.tz || 'America/Los_Angeles'
      const access = await googleAccessToken(sql, u.userId, 'calendar')
      if (!access) continue
      const got = await withTimeout(
        fetchCalendarItems(access, { timeMin: new Date(), timeMax: new Date(Date.now() + 7 * 86_400_000), maxResults: 30 }),
        12000,
        null,
      )
      if (!got || !got.ok || !got.items.length) continue
      for (const item of got.items) {
        const hit = extractFlightEvent(item)
        if (!hit) continue
        const departMs = new Date(hit.departAt).getTime()
        if (!Number.isFinite(departMs) || departMs <= Date.now()) continue
        const windowAt = new Date(Math.max(Date.now(), departMs - 24 * 60 * 60 * 1000)).toISOString()
        const payload = JSON.stringify({
          airline: hit.airline,
          flight: hit.flight,
          date: hit.departAt,
          checkin_at: windowAt,
          confirmation_url: hit.confirmationUrl,
          destination: hit.destination,
          home_tz: tz,
        })
        const existing = (await sql`
          SELECT id, status, payload->>'date' AS "flightDate" FROM hire_task_loops
          WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'flight_checkin'
          LIMIT 1
        `) as Array<{ id: string; status: string; flightDate: string | null }>
        const row = existing[0]
        if (row && row.flightDate === hit.departAt) break
        if (row) {
          await sql`
            UPDATE hire_task_loops SET
              title = ${`Check in ${hit.flight || 'flight'}`.slice(0, 120)},
              phone_e164 = ${u.phone},
              payload = ${payload}::jsonb,
              status = 'pending',
              attempts = 0,
              last_result = NULL,
              next_run = ${windowAt},
              updated_at = now()
            WHERE id = ${row.id}
          `
        } else {
          await sql`
            INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
            VALUES (${crypto.randomUUID()}, ${u.userId}, 'friend', ${u.phone}, 'flight_checkin',
              ${`Check in ${hit.flight || 'flight'}`.slice(0, 120)}, ${payload}::jsonb, 'pending', ${windowAt})
          `
        }
        armed++
        // One tracked flight per user (the unique index allows one row per
        // kind anyway, and the calendar is walk-forward so the first hit is
        // the next departure). A return flight is armed on the next scan.
        break
      }
    } catch (err) {
      console.warn('[loops] flight check-in arm failed', err)
    }
  }
  if (armed) console.log(`[loops] flight_checkin armed: ${armed}`)
  return armed
}

/* ---- Inbox watchtower ----
 * Push, don't wait: VIP mail, deadlines, interview invites, money owed, and
 * travel confirmations earn a proactive text. Promos, newsletters, and blasts
 * never do — two gates (free regex scoring, then one model call) must both
 * pass, the score bar is high, and each user gets at most one ping per day
 * unless the model calls it truly urgent (90+). Dedupe rides on the loop row:
 * pinged mail ids accumulate in the payload, so a mail is never announced
 * twice even across re-arms. */

type WatchtowerPingState = { pingedIds: string[]; lastPingAt: string | null }

async function readInboxPingState(sql: SQL, userId: string): Promise<{ status: string | null; state: WatchtowerPingState }> {
  try {
    const rows = (await sql`
      SELECT status, payload FROM hire_task_loops
      WHERE user_id = ${userId} AND persona = 'friend' AND kind = 'inbox_ping'
      LIMIT 1
    `) as Array<{ status: string; payload: unknown }>
    const row = rows[0]
    if (!row) return { status: null, state: { pingedIds: [], lastPingAt: null } }
    const p = (row.payload || {}) as Partial<WatchtowerPingState>
    return {
      status: row.status,
      state: {
        pingedIds: Array.isArray(p.pingedIds) ? p.pingedIds.map(String) : [],
        lastPingAt: typeof p.lastPingAt === 'string' ? p.lastPingAt : null,
      },
    }
  } catch (err) {
    console.warn('[watchtower] readInboxPing failed', { error: (err as any)?.message })
    return { status: null, state: { pingedIds: [], lastPingAt: null } }
  }
}

async function writeInboxPing(
  sql: SQL,
  userId: string,
  phone: string,
  hit: { id: string; from: string; subject: string; why: string; score: number; kind?: string },
  state: WatchtowerPingState,
  exists: boolean,
) {
  const now = new Date().toISOString()
  const payload = JSON.stringify({
    mailId: hit.id,
    from: hit.from,
    subject: hit.subject,
    why: hit.why,
    score: hit.score,
    // The bot turns the kind into the fitting offer ("want the reply
    // drafted?"), so a ping ends in a decision rather than a notification.
    ...(hit.kind ? { kind: hit.kind } : {}),
    pingedIds: [...state.pingedIds, hit.id].slice(-50),
    lastPingAt: now,
  })
  if (exists) {
    await sql`
      UPDATE hire_task_loops SET
        title = 'Inbox ping',
        phone_e164 = ${phone},
        payload = ${payload}::jsonb,
        status = 'pending',
        attempts = 0,
        last_result = NULL,
        next_run = now(),
        updated_at = now()
      WHERE user_id = ${userId} AND persona = 'friend' AND kind = 'inbox_ping'
    `
    return
  }
  await sql`
    INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
    VALUES (${crypto.randomUUID()}, ${userId}, 'friend', ${phone}, 'inbox_ping',
      'Inbox ping', ${payload}::jsonb, 'pending', now())
    ON CONFLICT (user_id, persona, kind) DO NOTHING
  `
}

/**
 * One-time "the watch covers you now" text.
 *
 * The watchtower arms itself for anyone Gmail-connected and recently active,
 * so without this the capability is invisible until the first hit — the user
 * never learns they have it, and the first ping reads as a bot talking to
 * itself. Users who already received a ping are skipped: they know.
 */
async function armInboxWatchOn(sql: SQL, userId: string, phone: string): Promise<boolean> {
  const prior = (await sql`
    SELECT 1 FROM hire_task_loops
    WHERE user_id = ${userId} AND persona = 'friend' AND kind IN ('inbox_ping', 'inbox_watch_on')
    LIMIT 1
  `) as unknown[]
  if (prior.length) return false
  await sql`
    INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
    VALUES (${crypto.randomUUID()}, ${userId}, 'friend', ${phone}, 'inbox_watch_on',
      'Inbox watch on', '{}'::jsonb, 'pending', now())
    ON CONFLICT (user_id, persona, kind) DO NOTHING
  `
  return true
}

/** Scan Gmail-connected, recently active users for newly arrived high-signal
 * mail and arm one inbox_ping loop each. Runs every 30 minutes; the model
 * judge only fires when the free regex gate already found a candidate, so the
 * common case (nothing urgent) costs zero model calls. */
export async function armInboxWatchtower(sql: SQL): Promise<number> {
  // Gmail arrives two ways: a Google OAuth token row, or a Composio connection.
  // The inner join here used to require the former, so an account whose Gmail
  // was connected through Composio was never scanned at all: the watch existed,
  // read mail fine everywhere else, and silently never covered that user.
  const users = (await sql`
    SELECT DISTINCT u.id AS "userId", u.phone_e164 AS phone,
      (g.user_id IS NOT NULL) AS "hasGoogle"
    FROM hire_users u
    LEFT JOIN hire_google_tokens g ON g.user_id = u.id
    LEFT JOIN hire_brief_cache b ON b.user_id = u.id AND b.built_at > now() - interval '7 days'
    LEFT JOIN hire_intro_queue q ON q.phone_e164 = u.phone_e164 AND q.status = 'sent' AND q.created_at > now() - interval '7 days'
    WHERE b.user_id IS NOT NULL OR q.phone_e164 IS NOT NULL
    LIMIT 100
  `) as Array<{ userId: string; phone: string; hasGoogle: boolean }>
  let armed = 0
  for (const u of users) {
    try {
      if (!u.userId || !normalizePhone(u.phone)) continue
      // Only pay the connector lookup for users without a Google token; the
      // Composio list is a cached network call, not a cheap SQL predicate.
      if (!u.hasGoogle) {
        const toolkits = await composioConnected(u.userId).catch(() => [])
        if (!toolkits.some((t) => /gmail/i.test(t))) continue
      }
      // Arm the one-time "watch is on" text first: it must go out even when
      // the very first scan finds nothing, which is the common case.
      await armInboxWatchOn(sql, u.userId, u.phone).catch(() => false)
      const { status, state } = await readInboxPingState(sql, u.userId)
      if (status === 'pending' || status === 'running') continue
      const rich = await withTimeout(loadGmailRich(sql, u.userId, importantMailQuery(MAIL_READ_WINDOW), MAIL_READ_CAP), 12000, [])
      if (!rich.length) continue
      const signals = await loadMailSenderSignals(sql, u.userId)
      const candidates = pickWatchtowerCandidates(
        rich,
        (k) => {
          const s = signals.get(k)
          return s ? { replies: s.replies, skips: s.skips } : undefined
        },
        new Set(state.pingedIds),
      )
      if (!candidates.length) continue
      // Second gate: the model judge confirms keep + urgency on the shortlist
      // only, so promos that slip the regexes still never ping.
      const verdicts = await judgeAllBatch(
        candidates.slice(0, 3).map((c) => ({ id: c.id, from: c.from, subject: c.subject, snippet: c.snippet })),
        [],
        await loadMailKindVocab(sql, u.userId),
      )
      const confirmed = candidates
        .map((c) => ({ c, v: verdicts.mails.get(c.id) }))
        .filter(({ v }) => v && v.keep && v.score >= WATCHTOWER_JUDGE_BAR)
        .sort((a, b) => (b.v?.score ?? 0) - (a.v?.score ?? 0))
      if (!confirmed.length) continue
      const best = confirmed[0]!
      const urgent = (best.v?.score ?? 0) >= WATCHTOWER_URGENT_SCORE
      if (!urgent && state.lastPingAt) {
        const hours = (Date.now() - new Date(state.lastPingAt).getTime()) / 3_600_000
        if (hours < WATCHTOWER_MIN_HOURS_BETWEEN_PINGS) continue
      }
      await writeInboxPing(
        sql,
        u.userId,
        u.phone,
        {
          id: best.c.id,
          from: best.c.from,
          subject: best.c.subject,
          why: best.v?.why || 'needs your eyes',
          score: best.v?.score ?? best.c.score,
          kind: best.c.kind,
        },
        state,
        status !== null,
      )
      armed++
    } catch (err) {
      console.warn('[loops] watchtower user failed', err)
    }
  }
  if (armed) console.log(`[loops] inbox_ping armed: ${armed}`)
  return armed
}



/** Backfill: anyone whose intro already went out (or who was hired before this
 * shipped) but never got a save_contact row gets one now. Idempotent — the
 * unique index makes re-runs a no-op. Runs on boot and daily. */
export async function armSaveContactLoops(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT DISTINCT u.id AS "userId", q.persona AS persona, q.phone_e164 AS phone
    FROM hire_intro_queue q
    JOIN hire_users u ON u.phone_e164 = q.phone_e164
    WHERE q.status = 'sent'
    AND NOT EXISTS (
      SELECT 1 FROM hire_task_loops l
      WHERE l.user_id = u.id AND l.persona = q.persona AND l.kind = 'save_contact'
    )
  `) as Array<{ userId: string; persona: string; phone: string }>
  let armed = 0
  for (const r of rows) {
    if (!isPersona(r.persona)) continue
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${r.userId}, ${r.persona}, ${r.phone}, 'save_contact',
        'Save this number to contacts', '{}'::jsonb, 'pending', now())
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
    armed++
  }
  if (armed) console.log(`[loops] save_contact armed: ${armed}`)
  return armed
}

/* ---- Billing ----
 * Stripe over plain fetch: one price per hire, checkout creates a
 * session, the webhook keeps hire_subscriptions honest. Nothing gates on it
 * until BILLING_ENFORCE=1 — ship the plumbing first, flip the switch when the
 * prices exist in the Stripe dashboard. */

/**
 * Payments are OFF: HireAlpha is free to use while it is being built, so no
 * signup goes to Stripe, no price is shown, and a skip-the-checkout account is
 * treated as a full one.
 *
 * Nothing below this line was deleted. The checkout session, the webhook, the
 * price envs, the subscription rows, and the pro gating all still work — flip
 * this one flag (env `HIREALPHA_PAYMENTS=1`, or change the default here) and
 * the paid product comes back exactly as it was. Restore steps:
 *   1. HIREALPHA_PAYMENTS=1 on the Web app.
 *   2. Free-tier rationing returns automatically (also honours FREE_TIER_LIMIT).
 *   3. Redeploy Web + Friend.
 * The one thing a skipped signup does NOT get is a hire_subscriptions row, so
 * if you ever turn payments on with existing free users in the database, they
 * fall back to the free tier rather than being silently charged. */
export const PAYMENTS_ENABLED = process.env.HIREALPHA_PAYMENTS === '1'




/**
 * Direct demo entry points, no public button anywhere. With DEMO_MODE=1 the
 * seeded demo account is reachable only through these signed links (7 day
 * mini tokens bound to the demo phone). Printed at web-server boot.
 */
export function demoDirectUrls(baseUrl: string): string[] {
  if (!demoModeEnabled()) return []
  const base = baseUrl.replace(/\/+$/, '')
  const out: string[] = []
  for (const persona of ['coworker', 'cofounder', 'friend'] as Persona[]) {
    const token = mintMiniToken(DEMO_PHONE, persona, 'home')
    if (!token) continue
    out.push(`${base}/app/mini/${persona}/home?t=${token}`)
  }
  return out
}


export type MailSenderSignal = { replies: number; skips: number }

/** Per-sender reply/skip counts over the last 60 days, for brief mail scoring. */
async function loadMailSenderSignals(
  sql: SQL,
  userId: string,
): Promise<Map<string, MailSenderSignal>> {
  const out = new Map<string, MailSenderSignal>()
  try {
    const rows = await sql`
      SELECT sender,
             count(*) FILTER (WHERE action IN ('drafted', 'replied'))::int AS replies,
             count(*) FILTER (WHERE action = 'skip')::int AS skips
      FROM hire_mail_feedback
      WHERE user_id = ${userId} AND created_at > now() - interval '60 days'
      GROUP BY sender
    `
    for (const r of rows as Array<{ sender: string; replies: number; skips: number }>) {
      if (!r.sender) continue
      out.set(r.sender, { replies: Number(r.replies) || 0, skips: Number(r.skips) || 0 })
    }
  } catch {
    // A missing or mid-migration table must not take the brief down.
  }
  return out
}

/**
 * Gmail ids the user finished handling. A draft is still awaiting review and
 * send, so it must remain in the brief. Kept for 21
 * days so a newsletter skipped once stays gone without growing forever.
 */
async function triagedMailIds(sql: SQL, userId: string): Promise<Set<string>> {
  try {
    const rows = await sql`
      SELECT DISTINCT gmail_id FROM hire_mail_feedback
      WHERE user_id = ${userId}
        AND action IN ('done', 'skip', 'replied')
        AND created_at > now() - interval '21 days'
    `
    return new Set((rows as Array<{ gmail_id: string }>).map((r) => r.gmail_id).filter(Boolean))
  } catch {
    return new Set()
  }
}


import {
  type LocationRow,
  getLocation,
  pickActiveLocation,
  locationLabel,
  coordsUsable,
} from "./db/locations"
export type { LocationRow }

async function rememberUserTimezone(sql: SQL, userId: string, raw: string, persona?: Persona) {
  const tz = resolveIanaTimezone(raw)
  if (!tz) return null
  await sql`UPDATE hire_users SET timezone = ${tz}, updated_at = now() WHERE id = ${userId}`
  if (persona) {
    const ctx = await loadContext(sql, userId, persona)
    if (ctx.timezone !== tz) await upsertContext(sql, userId, persona, { timezone: tz })
  }
  return tz
}

async function loadRoster(sql: SQL, userId: string): Promise<Persona[]> {
  const rows = await sql`SELECT persona FROM hire_roster WHERE user_id = ${userId}`
  return rows
    .map((r: { persona: string }) => r.persona)
    .filter(isPersona)
}

function wantsEmail(text: string) {
  return /\b(e-?mails?|inbox|gmail|unread|debrief|digest|brief me)\b/i.test(text)
}
function wantsImportantEmail(text: string) {
  return /\b(important|flagged|priority|debrief|digest|brief)\b/i.test(text)
}
function wantsCalendar(text: string) {
  return /\b(calendar|meeting|meetings|schedule|free time|what.?s on|agenda|tomorrow|today|standup|debrief|digest|brief)\b/i.test(text)
}
function wantsMaps(text: string) {
  return /\b(dinner|restaurants?|cafes?|bars?|coffee shops?|tonight|date night|places?|booth|maps|hangout|where (?:should|can) we)\b/i.test(
    text,
  )
}
function wantsWebSearch(text: string) {
  return /\b(ticket|tickets|showtime|showtimes|imax|70\s?mm|movie|movies|theater|theatre|fandango|cinema|regal|amc|concert|flight|hotel|price|cost|search (?:the )?(?:web|internet|online)|web search|look online|look up|browse|for accuracy|latest news|news about|how (?:much|many|do|to|old|far)|what (?:is|are|was|were|does)|when (?:is|does|did|was)|where (?:is|are|was|did)|who (?:is|was|are)|why (?:is|does|did)|define|meaning of|price of|recipe for|nutrition(?:al)? (?:info|facts|value|content)|calories? in|protein in)\b/i.test(text)
}
function wantsSlack(text: string) {
  return /\b(slack|thread|channel|#\w+)\b/i.test(text)
}
function wantsLinear(text: string) {
  return /\b(linear|ticket|tickets|issue|issues|backlog|triage)\b/i.test(text)
}
function wantsNotion(text: string) {
  return /\b(notion|wiki|doc|docs|notes?)\b/i.test(text)
}
function wantsDrive(text: string) {
  return /\b(drive|deck|slides|spreadsheet|google doc)\b/i.test(text)
}
function wantsGithub(text: string) {
  return /\b(github|pull requests?|\bprs?\b|repos?)\b/i.test(text)
}
function wantsFigma(text: string) {
  return /\b(figma|design file|mockups?)\b/i.test(text)
}
function wantsSpotify(text: string) {
  return /\b(spotify|playlist|now playing|what.?s playing)\b/i.test(text)
}
function wantsTwitch(text: string) {
  return /\b(twitch|stream(er|ing)?|live channel)\b/i.test(text)
}
function wantsYoutube(text: string) {
  return /\b(?:youtube|yt)\b.{0,24}\b(search|find|video|tutorial|transcript|channel)\b|\b(?:search|find)\b.{0,16}\b(youtube|yt)\b|\bhow to\b.{0,40}\bvideo\b/i.test(text)
}
function wantsVimeo(text: string) {
  return /\bvimeo\b/i.test(text)
}
function wantsLoom(text: string) {
  return /\bloom\b/i.test(text)
}
function wantsZoom(text: string) {
  return /\b(zoom|zoom meeting|zoom link)\b/i.test(text)
}
function wantsMeet(text: string) {
  return /\b(google meet|gmeet|meet link|meet room)\b/i.test(text)
}
function wantsStripe(text: string) {
  return /\b(stripe|revenue|mrr|arr|charges?|invoices?)\b/i.test(text)
}
function wantsPlaid(text: string) {
  return /\b(plaid|bank|bank account|checking account|savings account|bank balance|bank transactions|mercury|brex|chase|bofa|wells fargo|credit card balance)\b/i.test(text)
}



async function fetchPublic(url: URL, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}


import {
  fetchMapSearch,
  classifyMapQuery,
  mapAreaFromQuery,
  mapPlaceWords,
  hotelConstraintsFromAsk,
  mapAreaCandidates,
  dietsFromQuery,
  buildOverpassQuery,
  metersBetween,
  formatMapResults,
  geocodeRowUsableForTest,
  geocodeMapArea,
  nominatimArea,
  timezoneCountry,
} from "./maps"
export {
  fetchMapSearch,
  classifyMapQuery,
  mapAreaFromQuery,
  mapPlaceWords,
  hotelConstraintsFromAsk,
  mapAreaCandidates,
  dietsFromQuery,
  buildOverpassQuery,
  metersBetween,
  formatMapResults,
  geocodeRowUsableForTest,
  geocodeMapArea,
  PLACE_ASK_RE,
}

import {
  webSearchWithSerpFallback,
} from "./travel/service"
function notConnectedNote(tool: string, persona: Persona = 'friend') {
  const directUrl = `https://hirealpha.chat/app/hires/${persona}?connect=${encodeURIComponent(tool)}`
  return `${tool} is not connected yet. Tell them: "You can connect ${tool} directly here: ${directUrl}" so they can tap and connect it instantly with one tap without searching the site. Never claim you already did the action.`
}

/** A timezone's GMT offset at one instant, as ±HH:MM. Used to echo an exact
 * accepted calendar range and to fill in an offset the model omitted. */
function timezoneOffsetFor(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: isValidTimeZone(timezone) ? timezone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '00'
    const localMs = Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(get('hour')) % 24,
      Number(get('minute')),
      Number(get('second')),
    )
    const diffMin = Math.round((localMs - date.getTime()) / 60000)
    const sign = diffMin < 0 ? '-' : '+'
    const abs = Math.abs(diffMin)
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  } catch {
    return '+00:00'
  }
}

/** The exact shape the calendar branch accepts, written with real numbers so
 * the model copies it instead of guessing. */
function calendarHintExample(timezone: string): string {
  const tz = isValidTimeZone(timezone) ? timezone : 'UTC'
  const now = new Date()
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const offset = timezoneOffsetFor(now, tz)
  return `Example that is accepted: start=${ymd}T00:00:00${offset} end=${ymd}T23:59:00${offset}`
}

export async function runToolsForMessage(
  sql: SQL,
  input: {
    userId: string
    persona: Persona
    message: string
    connected: string[]
    want?: LiveToolWant
    timezone?: string
    location?: LocationRow | null
    /** Who is asking. Only used to decide whether a metered SerpAPI call is
     * allowed for this number (see deploy/serpapi.ts). */
    phone?: string
    idempotencyKey?: string
  },
): Promise<string[]> {
  const execute = async (): Promise<string[]> => {
  const results: string[] = []
  const denied = PERSONA_DENIED[input.persona]
  const can = (id: string) => input.connected.includes(id) && !denied.has(id)
  const asked = (id: string, hit: boolean) => {
    if (!hit) return
    if (can(id)) return
    if (denied.has(id)) {
      results.push(`${id} is off limits for this hire. Do not offer it.`)
      return
    }
    // An empty connector list is not proof the account is unconnected — the
    // Composio list read can time out during a latency spike, and telling a
    // connected user to go connect is worse than admitting the check failed.
    results.push(
      input.connected.length
        ? notConnectedNote(id, input.persona)
        : `${id} could not be checked right now (the connector list did not answer). Do not claim it is connected or disconnected; offer to retry.`,
    )
  }
  const askedAllowed = (id: string, hit: boolean) => {
    if (!hit) return
    if (denied.has(id)) return
    asked(id, hit)
  }

  // A model-selected tool is an explicit operation, not another natural-language
  // intent classification. Preserve its query and never fan out because a mail
  // subject happens to contain "calendar", "drive", or another connector name.
  if (input.want) {
    const query = input.message.trim().slice(0, 1000)
    if (!query) return ['A lookup query is required.']
    if (input.want === 'web') return [await webSearchWithSerpFallback(query, input.phone)]
    if (input.want === 'maps') return [await fetchMapSearch(query, timezoneCountry(input.timezone), input.location, input.phone)]
    if (input.want === 'weather') {
      // Strip the ask words, keep the place: "weather in SF this weekend?" -> "SF".
      const place = query.replace(/\b(weather|forecast|temperature|degrees|like|going|today|tonight|tomorrow|this weekend|weekend|this|in|for|at|near me|right now|outside|expect|should i pack|will it)\b/gi, ' ').replace(/[?!]/g, ' ').replace(/\s+/g, ' ').trim()
      return [await fetchWeatherLookup(place, input.timezone || 'America/Los_Angeles', timezoneCountry(input.timezone || 'America/Los_Angeles'))]
    }
    // A model-selected work tool is one targeted connector read, never a fan
    // out — same invariant as the google-native wants below.
    const workRead = WORK_READ_TOOLS[input.want]
    if (workRead) {
      if (!can(workRead)) {
        asked(workRead, true)
        return results
      }
      const spec = COMPOSIO_READ[workRead]
      if (!spec) return [`${workRead} is not wired. Do not invent a result.`]
      const out = await composioFirst(input.userId, spec.slugs, spec.args(query))
      return [!out || composioLooksFailed(out) ? spec.empty : `${workRead}\n${out}`]
    }
    if (input.want === 'gmail') {
      let canMail = can('gmail')
      if (!canMail) {
        const hasGoogle = await googleConnected(sql, input.userId).catch(() => null)
        if (hasGoogle && hasGoogle.scopes.includes('gmail')) canMail = true
        else {
          const comp = await composioConnected(input.userId).catch(() => [])
          if (comp.some((c) => /gmail/i.test(c))) canMail = true
        }
      }
      if (!canMail) {
        asked('gmail', true)
        return results
      }
      // One 12s deadline over the whole read. The mail path can chain a token
      // refresh, a Gmail list and a Composio fallback; without the cap a slow
      // connector produced a stalled turn (the bot aborts at 20s), and the
      // hard cap now answers with the graceful empty instead.
      const byId = /^id=([A-Za-z0-9_-]+)$/.exec(query)
      if (byId) {
        const messageId = byId[1]!
        // One full fetch carries the body AND the attachment list, so "what did
        // they attach" is answerable and each attachment stays bound to this
        // thread (attachmentId + filename ride along for the read/forward verbs).
        const full = await withTimeout(loadGmailFullMessage(sql, input.userId, messageId), 8000, { ok: false as const })
        if (full.ok && full.message) {
          const atts = full.message.attachments
          const attLine = atts.length
            ? `\nAttachments (${atts.length}): ${atts.map((a) => `${a.filename || '(unnamed)'} [${a.mimeType}] ${a.size} bytes attachmentId=${a.attachmentId}`).join('; ')}\nUse the mail_attachment capability to read or summarize one; use forward_email to pass the message (attachments included) on.`
            : ''
          if (full.message.threadId) {
            void upsertThreadState(sql, input.userId, '', {
              threadId: full.message.threadId,
              participant: full.message.from,
              subject: full.message.subject,
              direction: 'inbound',
              awaiting: 'none',
              lastMessageId: messageId,
            }).catch(() => undefined)
          }
          const bodyText = full.message.bodyText || full.message.snippet || ''
          return [bodyText ? `Email body id=${messageId}, subject "${full.message.subject}", from ${full.message.from} (up to 12000 characters):\n${bodyText.slice(0, 12000)}${attLine}` : `The message opened but produced no readable text.${attLine}`]
        }
        const text = await withTimeout(
          (async () => {
            const direct = await withTimeout(loadGmailMessageBody(sql, input.userId, messageId, 12000), 6000, '')
            if (direct) return direct
            const mail = await withTimeout(composioMailBody(input.userId, messageId), 5000, null)
            return mail?.id === messageId ? mail.bodyText || stripHtml(mail.bodyHtml) || mail.snippet || '' : ''
          })(),
          12000,
          '',
        )
        return [text ? `Email body id=${messageId} (up to 12000 characters; attachment list unavailable on this read):\n${text.slice(0, 12000)}` : `Could not retrieve the body for id=${messageId}. Do not infer its contents from the subject.`]
      }
      const mailQuery = normalizeGmailQuery(query)
      const row = mailRow
      const first = await withTimeout(readGmailExact(sql, input.userId, mailQuery, MAIL_READ_CAP), 12000, { items: [], failed: true })
      if (first.failed) {
        const status = 'status' in first ? first.status : 'timeout'
        const reconnect = status === 'auth_expired' || status === 'not_connected'
          ? ' Reconnect Gmail at /app/hires/friend?connect=gmail, then retry the same question.' : ' Preserve the original question and offer to retry.'
        return [`Gmail read failed: ${status}.${reconnect} Do not say there were no matches and do not suggest changing the search.`]
      }
      if (!first.items.length && !first.failed && mailQuery !== 'newer_than:7d') {
        /* A real zero-match search stays a zero-match answer. Filling the gap
         * with the last 7 days' mail under the query's name is how "from:sam
         * Thursday" came back as a KAYAK receipt and the assistant reported
         * that Sam had not written. Relax to the operator-only core once, and
         * label the rows for what they are. */
        const relaxed = relaxedGmailQuery(mailQuery)
        if (relaxed) {
          const wider = await withTimeout(readGmailExact(sql, input.userId, relaxed, MAIL_READ_CAP), 8000, { items: [], failed: true })
          if (wider.items.length) {
            return [`No email matched ${JSON.stringify(query)}. Closest matches instead (${JSON.stringify(relaxed)} — same sender or window, but not every term):\n${wider.items.map(row).join('\n')}`]
          }
        }
        return [`No email matched ${JSON.stringify(query)}. This is a real zero-match result, not a failed read and not an empty inbox: say plainly that no message matches that search, and offer a wider query (for example just the sender) if they want it.`]
      }
      let mail = first.items
      if (!mail.length && mailQuery !== 'newer_than:7d') {
        mail = await withTimeout(loadGmailRich(sql, input.userId, 'newer_than:7d', MAIL_READ_CAP), 8000, [])
      }
      // Self-healing reply-state: every conversational read seeds per-thread
      // waiting-on rows (an ask-language mail means the user owes the reply),
      // so "who am I ignoring?" works past the read window.
      for (const item of mail.slice(0, 10)) {
        if (!item.threadId) continue
        void upsertThreadState(sql, input.userId, '', {
          threadId: item.threadId,
          participant: item.from,
          subject: item.subject,
          direction: 'inbound',
          awaiting: mailWaitingOnYou(item) ? 'me' : 'none',
          lastMessageId: item.id,
        }).catch(() => undefined)
      }
      /* A capped read is not a whole window. Live, 2026-09-20, the triage replied
       * "Read the last 2 days, 30 emails" — 30 being exactly MAIL_READ_CAP, so a
       * busy window with more mail behind the cap was reported as if it had all
       * been read. The count is real; the completeness was not claimed by any
       * tool. mailResultsBlock() names the cap and lets the model ask to widen. */
      return [mailResultsBlock(query, mail)]
    }
    if (!can(input.want)) {
      asked(input.want, true)
      return results
    }
    if (input.want === 'drive') return [await loadDrive(sql, input.userId, query)]
    if (input.want === 'calendar') {
      // Explicit instants avoid a second model call and ambiguous server-local
      // date parsing. An invalid range must not silently become "next week".
      // Extraction is deliberately forgiving: the model reliably includes
      // start=/end= (or startTime/start_time/from/to) but wraps them with
      // prose, quotes, brackets or a space instead of the T separator; an
      // anchored pattern bounced those lookups and the whole reply died.
      const tz = input.timezone || 'UTC'
      const clean = (v: string | undefined) => (v || '').replace(/^[\s"'[(]+|[\s"'\]),.;]+$/g, '')
      const grab = (keys: string[]) => {
        for (const key of keys) {
          // Whitespace inside the value is real ("2026-09-11 09:30:00-07:00"),
          // so prefer a whole datetime before falling back to one token.
          const m = new RegExp(
            `\\b${key}(?:\\s*_?(?:datetime|date|time))?[="'\\s:]+(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?|\\S+)`,
            'i',
          ).exec(query)
          if (m?.[1]) return clean(m[1])
        }
        return ''
      }
      const withOffset = (raw: string) => {
        let v = raw.trim()
        // "2026-09-11 00:00:00-07:00": a space where ISO wants a T. An offset
        // is still required — without one the range is ambiguous, and the
        // hint below teaches the exact accepted shape instead of guessing.
        if (/^\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}/i.test(v)) v = v.replace(/^(\d{4}-\d{2}-\d{2})[ t]/i, '$1T')
        return v
      }
      const startRaw = withOffset(grab(['start', 'from']))
      const endRaw = withOffset(grab(['end', 'to']))
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
      if (!iso.test(startRaw) || !iso.test(endRaw)) {
        return [`Calendar lookup needs start=<ISO datetime with offset> end=<ISO datetime with offset>, using the user timezone. ${calendarHintExample(tz)}. No calendar lookup ran.`]
      }
      const timeMin = new Date(startRaw)
      const timeMax = new Date(endRaw)
      const span = timeMax.getTime() - timeMin.getTime()
      if (!Number.isFinite(span) || span <= 0 || span > 31 * 86400000) return ['Calendar range must be valid, increasing, and no longer than 31 days. No calendar lookup ran.']
      const calendar = await loadCalendar(sql, input.userId, { timeMin, timeMax, maxResults: 100 }, tz)
      const block = calendar.replace('No events on the calendar in the next 7 days.', 'No events found in the requested window.')
      return [`Calendar window ${startRaw} to ${endRaw}:\n${block}\nThis is an event listing; do not assume complete availability if results are capped.`]
    }
  }

  const mailHit = input.want === 'gmail' || wantsEmail(input.message)
  const calHit = input.want === 'calendar' || wantsCalendar(input.message)
  const mailQuery = /\b(debrief|digest|brief)\b/i.test(input.message)
    ? '(newer_than:1d) OR (is:important newer_than:2d)'
    : wantsImportantEmail(input.message)
      ? 'is:important newer_than:14d'
      : 'newer_than:5d'
  if (mailHit && can('gmail') && calHit && can('calendar')) {
    const brief = /\b(debrief|digest|brief|today|calendar|agenda|schedule)\b/i.test(input.message)
    const tz = input.timezone || 'America/Los_Angeles'
    const calOpts = brief
      ? { timeMin: startOfLocalDay(tz), timeMax: startOfLocalDay(tz, 2), maxResults: 20 }
      : undefined
    const [mail, cal] = await Promise.all([
      loadGmail(sql, input.userId, mailQuery, 8),
      loadCalendar(sql, input.userId, calOpts, tz),
    ])
    if (mail) results.push(mail)
    if (cal) results.push(cal)
  } else {
    let canMail = can('gmail')
    if (mailHit && !canMail) {
      const hasGoogle = await googleConnected(sql, input.userId).catch(() => null)
      if (hasGoogle && hasGoogle.scopes.includes('gmail')) canMail = true
      else {
        const comp = await composioConnected(input.userId).catch(() => [])
        if (comp.some((c) => /gmail/i.test(c))) canMail = true
      }
    }
    if (mailHit && canMail) {
      results.push(await loadGmail(sql, input.userId, mailQuery, 8))
    } else {
      askedAllowed('gmail', mailHit)
    }

    if (calHit && can('calendar')) {
      const brief = /\b(debrief|digest|brief|today|calendar|agenda|schedule)\b/i.test(input.message)
      const tz = input.timezone || 'America/Los_Angeles'
      const calOpts = brief
        ? { timeMin: startOfLocalDay(tz), timeMax: startOfLocalDay(tz, 2), maxResults: 20 }
        : undefined
      results.push(await loadCalendar(sql, input.userId, calOpts, tz))
    } else {
      askedAllowed('calendar', calHit)
    }
  }

  const mapsHit = input.want === 'maps' || (wantsMaps(input.message) && !calHit)
  if (mapsHit) {
    let mapsOut = ''
    if (can('maps')) mapsOut = await runComposioPlugin(input.userId, 'maps', input.message)
    if (!mapsOut || composioLooksFailed(mapsOut) || mapsOut === COMPOSIO_READ.maps!.empty) {
      mapsOut = await fetchMapSearch(input.message, timezoneCountry(input.timezone), input.location)
    }
    results.push(mapsOut)
  }

  if ((wantsWebSearch(input.message) && !wantsMaps(input.message) && input.want !== 'maps') || input.want === 'web') {
    results.push(await webSearchWithSerpFallback(input.message, input.phone))
  }

  if (wantsSlack(input.message) && can('slack')) {
    results.push(await runComposioPlugin(input.userId, 'slack', input.message))
  } else {
    askedAllowed('slack', wantsSlack(input.message))
  }
  if (wantsLinear(input.message) && can('linear')) {
    results.push(await runComposioPlugin(input.userId, 'linear', input.message))
  } else {
    askedAllowed('linear', wantsLinear(input.message))
  }
  if (wantsNotion(input.message) && can('notion')) {
    results.push(await runComposioPlugin(input.userId, 'notion', input.message))
  } else {
    askedAllowed('notion', wantsNotion(input.message))
  }
  const driveHit = input.want === 'drive' || wantsDrive(input.message)
  if (driveHit && can('drive')) {
    results.push(await loadDrive(sql, input.userId, input.message.slice(0, 40)))
  } else {
    askedAllowed('drive', driveHit)
  }
  if (wantsGithub(input.message) && can('github')) {
    results.push(await runComposioPlugin(input.userId, 'github', input.message))
  } else {
    askedAllowed('github', wantsGithub(input.message))
  }
  if (wantsFigma(input.message) && can('figma')) {
    results.push(await runComposioPlugin(input.userId, 'figma', input.message))
  } else {
    askedAllowed('figma', wantsFigma(input.message))
  }
  if (wantsSpotify(input.message) && can('spotify')) {
    results.push(await runComposioPlugin(input.userId, 'spotify', input.message))
  } else {
    askedAllowed('spotify', wantsSpotify(input.message))
  }
  if (wantsYoutube(input.message) && can('youtube')) {
    results.push(await runComposioPlugin(input.userId, 'youtube', input.message))
  } else {
    askedAllowed('youtube', wantsYoutube(input.message))
  }
  if (wantsTwitch(input.message) && can('twitch')) {
    results.push(await runComposioPlugin(input.userId, 'twitch', input.message))
  } else {
    askedAllowed('twitch', wantsTwitch(input.message))
  }
  if (wantsVimeo(input.message) && can('vimeo')) {
    results.push(await runComposioPlugin(input.userId, 'vimeo', input.message))
  } else {
    askedAllowed('vimeo', wantsVimeo(input.message))
  }
  if (wantsLoom(input.message) && can('loom')) {
    results.push(await runComposioPlugin(input.userId, 'loom', input.message))
  } else {
    askedAllowed('loom', wantsLoom(input.message))
  }
  if (wantsZoom(input.message) && can('zoom')) {
    results.push(await runComposioPlugin(input.userId, 'zoom', input.message))
  } else {
    askedAllowed('zoom', wantsZoom(input.message))
  }
  if (wantsMeet(input.message) && can('meet')) {
    results.push(await runComposioPlugin(input.userId, 'meet', input.message))
  } else {
    askedAllowed('meet', wantsMeet(input.message))
  }
  if (wantsStripe(input.message) && can('stripe')) {
    results.push(await runComposioPlugin(input.userId, 'stripe', input.message))
  } else {
    askedAllowed('stripe', wantsStripe(input.message))
  }
  if (wantsPlaid(input.message) && can('plaid')) {
    results.push(await runComposioPlugin(input.userId, 'plaid', input.message))
  } else {
    askedAllowed('plaid', wantsPlaid(input.message))
  }

  return results
  }

  if (input.idempotencyKey) {
    const { result } = await withIdempotency(input.idempotencyKey, execute)
    return result
  }
  return execute()
}

const PERSONA_LABEL: Record<Persona, string> = {
  friend: 'Alpha',
  coworker: 'Alpha (Coworker)',
  cofounder: 'Alpha (CoFounder)',
}

function digestLines(block?: string): string[] {
  if (!block) return []
  return block.split('\n').filter((l) => l.startsWith('- '))
}

function formatCalTime(iso: string, timezone: string): string {
  const allDay = !iso.includes('T')
  const d = new Date(allDay ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  if (allDay) return 'All day'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

function formatMailLine(line: string): string {
  const [from, , subject] = line.replace(/^-\s*/, '').split(' | ')
  const s = (subject || '(no subject)').slice(0, 60)
  return from ? `${s} · ${from}` : s
}

function formatMailLineFromParts(from: string, subject: string): string {
  const cleanFrom = from.replace(/<[^>]+>/g, '').trim()
  const s = (subject || '(no subject)').slice(0, 60)
  return cleanFrom ? `${s} · ${cleanFrom}` : s
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }).catch(() => {
      clearTimeout(t)
      resolve(fallback)
    })
  })
}

function parseCalMeet(title: string): { who: string; place: string } {
  const t = title.replace(/\s+/g, ' ').trim()
  const at = t.match(
    /^(?:meet(?:ing)?(?:\s+with)?|call(?:\s+with)?|coffee|lunch|dinner|drinks|hang(?:out)?)\s+(.+?)\s+at\s+(.+)$/i,
  )
  if (at) return { who: at[1]!.trim(), place: at[2]!.trim() }
  const withAt = t.match(/^(.+?)\s+at\s+(.+)$/i)
  if (withAt) {
    const who = withAt[1]!.replace(/^(?:meet(?:ing)?|call)\s+(?:with\s+)?/i, '').trim()
    return { who: who || withAt[1]!.trim(), place: withAt[2]!.trim() }
  }
  const who = t.replace(/^(?:meet(?:ing)?|call)\s+(?:with\s+)?/i, '').trim()
  return { who: who || t, place: '' }
}

type CalMeet = { time: string; title: string; who: string; place: string; day: 'today' | 'tomorrow' }

function parseCalendarMeets(
  calendarBlock: string | undefined,
  tz: string,
): CalMeet[] {
  const tomorrowYmd = startOfLocalDay(tz, 1).toLocaleDateString('en-CA', { timeZone: tz })
  const todayYmd = startOfLocalDay(tz).toLocaleDateString('en-CA', { timeZone: tz })
  const out: CalMeet[] = []
  for (const line of digestLines(calendarBlock)) {
    const parsed = parseFormattedEventLine(line)
    if (!parsed) continue
    const iso = parsed.iso
    const title = parsed.title
    const raw = iso.includes('T') ? iso : `${iso}T12:00:00`
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) continue
    const day = d.toLocaleDateString('en-CA', { timeZone: tz })
    const meet = parseCalMeet(title)
    out.push({
      time: parsed.clock || formatCalTime(iso, tz),
      title,
      who: meet.who,
      place: meet.place,
      day: day === tomorrowYmd ? 'tomorrow' : day === todayYmd ? 'today' : 'today',
    })
  }
  return out
}

type TodayMeet = { time: string; title: string; who: string; place: string; kind: string }
type TodayResult = {
  meets: TodayMeet[]
  stay: { title: string; place: string } | null
  calendarConnected: boolean
  calendarFailed?: boolean
  calendarStatus?: ConnectorStatus
  calendarErrorReason?: string
}

export async function todayCalendarMeets(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
): Promise<TodayResult> {
  const tz = user.timezone || 'America/Los_Angeles'
  const connected = (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
  const myName = user.name || null

  function stayWhere(title: string, place: string) {
    const hotel = place || title.replace(/^(stay(?:ing)?(?:\s+at)?)\s+/i, '').trim()
    return { title: hotel || title, place: place || hotel }
  }

  function itemsToResult(items: CalItem[]): TodayResult {
    let stay: { title: string; place: string } | null = null
    const meets: TodayMeet[] = []
    for (const e of items) {
      const calParsed = parseCalMeet(e.title)
      const travel = isHotelStayEvent(e) || isTravelOrStayTitle(e.title, calParsed.place)
      if (travel) {
        if (!stay && (isHotelStayEvent(e) || isTravelOrStayTitle(e.title, calParsed.place))) {
          stay = stayWhere(e.title, calParsed.place)
        }
        continue
      }
      const who = extractOtherPerson(e.title, myName) || calParsed.who || e.title
      const row = {
        time: e.allDay ? 'All day' : formatClock(e.start, tz),
        title: e.title,
        who,
        place: calParsed.place,
        kind: e.kind,
      }
      meets.push(row)
    }
    return { meets, stay, calendarConnected: true, calendarStatus: 'ok' }
  }

  if (!connected.includes('calendar')) {
    return { meets: [], stay: null, calendarConnected: false, calendarStatus: 'not_connected' }
  }

  let knownStatus: ConnectorFailureReason = 'provider_error'
  const tokenStatus = await googleTokenWithStatus(sql, user.id, 'calendar')
  if (tokenStatus.ok) {
    const got = await fetchCalendarItems(tokenStatus.accessToken, {
      timeMin: startOfLocalDay(tz),
      timeMax: startOfLocalDay(tz, 1),
      maxResults: 100,
      checkSecondary: true,
    })
    if (got.ok) return itemsToResult(got.items)
    knownStatus = got.reason || 'provider_error'
  } else {
    knownStatus = tokenStatus.reason
  }

  /* A read that did not answer must not read as an empty day. The sink is set
   * when the connector refused or the budget ran out. */
  const failureSink = { failed: false }
  const cached = await googleEventsRaw(sql, user.id, {
    timeMin: startOfLocalDay(tz),
    timeMax: startOfLocalDay(tz, 1),
    maxResults: 100,
    budgetMs: 6000,
    failureSink,
  }).catch(() => [])
  if (cached.length) {
    return itemsToResult(
      cached.map((e) => ({
        start: new Date(e.start),
        title: e.title,
        description: '',
        allDay: !!e.allDay,
        kind: 'Meeting',
        rawStart: e.start,
      })),
    )
  }

  const results = await withTimeout(
    runToolsForMessage(sql, {
      userId: user.id,
      persona,
      message: 'calendar today',
      connected,
      timezone: tz,
    }),
    6000,
    [] as string[],
  )
  const calendarBlock = results.find((t) => isCalendarToolResult(t))
  if (calendarBlock) {
    const calMeets = parseCalendarMeets(calendarBlock, tz).filter((e) => e.day === 'today')
    let stay: { title: string; place: string } | null = null
    const meets: TodayMeet[] = []
    for (const e of calMeets) {
      const who = extractOtherPerson(e.title, myName) || e.who || e.title
      const row = { time: e.time, title: e.title, who, place: e.place, kind: 'Meeting' }
      if (isTravelOrStayTitle(e.title, e.place) || isTravelOrStayTitle(who, e.place) || /^all day$/i.test(e.time)) {
        if (!stay && isTravelOrStayTitle(e.title, e.place)) stay = stayWhere(e.title, e.place)
        continue
      }
      meets.push(row)
    }
    return { meets, stay, calendarConnected: true, calendarStatus: 'ok' }
  }

  if (results.some((t) => /lookup failed|failed to|not connected/i.test(t))) failureSink.failed = true
  if (results.length === 0 && knownStatus !== 'auth_expired') knownStatus = 'timeout'

  return {
    meets: [],
    stay: null,
    calendarConnected: true,
    calendarFailed: true,
    calendarStatus: knownStatus,
  }
}

/**
 * Refresh the judgment cache ahead of any request, on a 15-minute clock. Users
 * with a brief built in the last six hours get their mail and meetings re-judged
 * if the cached row is stale, so an open of any brief inside the window is a
 * cache hit with zero model calls. Errors are per-user and swallowed: a failed
 * prewarm costs nothing, the on-demand path judges on first open anyway.
 */
export async function prewarmJudgeCaches(sql: SQL) {
  try {
    pruneBriefCaches()
    const rows = (await sql`
      SELECT DISTINCT user_id AS "userId" FROM hire_brief_cache
      WHERE built_at > now() - interval '6 hours'
      LIMIT 50
    `) as Array<{ userId: string }>
    for (const { userId } of rows) {
      try {
        const urows = (await sql`
          SELECT timezone AS tz, name FROM hire_users WHERE id = ${userId} LIMIT 1
        `) as Array<{ tz: string | null; name: string | null }>
        const tz = urows[0]?.tz
        const today = localDateStrInTz(new Date(), tz)
        const row = await readJudgeRow(sql, userId)
        if (row && judgeRowFresh(row.builtAt, Date.now(), row.day, today)) continue
        const rich = await withTimeout(loadGmailRich(sql, userId, importantMailQuery('2d'), JUDGE_MAIL_CAP), 9000, [])
        const cal = await todayMeetsCache
          .read(
            `${userId}|friend`,
            () => todayCalendarMeets(sql, { id: userId, timezone: tz, name: urows[0]?.name ?? undefined }, 'friend'),
            8000,
          )
          .then((r) => r.value ?? EMPTY_TODAY_RESULT)
        const judgeMeets: JudgeMeetIn[] = cal.meets.map((m) => ({
          id: meetJudgeKey(m),
          time: m.time,
          title: m.who || m.title,
        }))
        await loadJudgeVerdicts(sql, userId, rich, judgeMeets, tz)
        /* Home rides the same sweep. The sweep just filled todayMeetsCache and
         * the judge row, so warming the world slice costs one extra Gmail list
         * read and leaves /api/home a cache hit for the next quarter hour —
         * an open after a deploy or a quiet stretch paints instantly instead
         * of rebuilding the world in front of the user. */
        void homeWorldCache
          .read(
            `${userId}|${tz || 'America/Los_Angeles'}`,
            () =>
              loadHomeWorld(
                sql,
                {
                  id: userId,
                  timezone: tz || 'America/Los_Angeles',
                  name: urows[0]?.name ?? undefined,
                } as AuthedUser,
                tz || 'America/Los_Angeles',
              ),
          )
          .catch(() => undefined)
      } catch {
        // One user's prewarm must not stop the others.
      }
    }
  } catch (err) {
    console.warn('[judge] prewarm failed', err)
  }
}

/* ---- Home's slow half ----
 * Everything on home that leaves this process: the calendar, the inbox, and the
 * model pass that names the mail piles. It used to run inside the request, so
 * opening home cost a Google round trip plus an LLM call every time even though
 * none of it changes minute to minute. Now it loads through a stale-while-
 * revalidate cache and the request only waits when there is nothing at all to
 * show.
 */
type HomeWorld = {
  upcoming: Array<{ time: string; title: string }>
  mail: Array<{ from: string; subject: string }>
  mailGroups: Array<{
    kind: string
    label: string
    count: number
    items: Array<{ id: string; from: string; subject: string; snippet?: string }>
  }>
  meetings: DigestMeeting[]
  attention: AttentionPick | null
}

export const EMPTY_TODAY_RESULT: TodayResult = { meets: [], stay: null, calendarConnected: false, calendarStatus: 'not_connected' }

/* Today's meetings, read by home and by every screen that lists who you are
 * seeing. One calendar fetch per user per minute and a half is plenty — an event
 * booked elsewhere shows up on the next pull. */
const todayMeetsCache = createStaleCache<TodayResult>({
  ttlMs: 90_000,
  maxWaitMs: 2_500,
  failureCooldownMs: 15_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[calendar] today fetch failed', key, err),
})

/* 90s is short enough that a meeting booked from another device shows up on the
 * next pull, and long enough that opening home twice in a minute is free. The
 * 1.5s cold wait is the one case a user waits at all: it beats a blank Today
 * section, and the load keeps going into the cache either way. */
const homeWorldCache = createStaleCache<HomeWorld>({
  ttlMs: 300_000,
  maxWaitMs: 700,
  failureCooldownMs: 15_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[home] world slice failed', key, err),
})

/** Warm the home cache off the back of a brief build: the person just read the
 * brief and will tap Home next. Background single-flight read fills the cache
 * so the home open paints instantly instead of shimmering through a cold
 * calendar + mail + judge pass. Never awaited, never fatal. */
function prewarmHomeWorld(sql: SQL, user: { id: string; name?: string | null; timezone: string | null }, tzLocal: string) {
  try {
    void homeWorldCache
      .read(`${user.id}|${tzLocal}`, () => loadHomeWorld(sql, user as AuthedUser, tzLocal))
      .catch(() => undefined)
  } catch {
    /* prewarm is a nicety */
  }
}

/* The brief is home's problem at a heavier weight: two calendar reads, an inbox
 * pull, a model pass over the mail, and a dozen small queries, all inside one
 * request that used to run them serially. Ninety seconds stays honest about
 * mail that landed since the last look — past that the refresh runs behind
 * whatever is already on screen.
 *
 * maxWaitMs is a floor on how long a first open can feel slow, not a deadline on
 * the work — the load keeps running into the cache after the wait expires, so a
 * short wait plus a retry a few hundred ms later gets the brief on screen sooner
 * than one long stare at a spinner ever did. 900ms is the crossover: a load that
 * finishes under it is served on the spot, and anything slower is better handed
 * to the client's retry ladder than held open. */
/* Both brief caches hold the loader's full result, payload plus the throttling
 * flags, never a bare payload. Every writer goes through briefLoader, so a
 * reader that spread a bare payload next to a wrapped one would serve
 * `{ cardUrl }` — an empty brief — depending on which writer landed first. */
const digestCache = createStaleCache<BriefLoadResult<Awaited<ReturnType<typeof digestPayload>>>>({
  ttlMs: 90_000,
  maxWaitMs: 4000,
  failureCooldownMs: 10_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[digest] load failed', key, err),
})

/* The evening brief is the same weight as the morning one — a two-day calendar
 * range, an inbox pull, a model pass, and eleven log queries — and until now it
 * was the only brief with no cache at all, so every open paid the whole bill.
 *
 * Its own cache rather than a shared one: the two briefs have different payload
 * shapes, and keying them together would let a morning read serve an evening
 * open. Same 90-second window, since both are answering "what has landed". */
const eveningCache = createStaleCache<BriefLoadResult<Awaited<ReturnType<typeof miniPayload>>>>({
  ttlMs: 90_000,
  maxWaitMs: 4000,
  failureCooldownMs: 10_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[evening] load failed', key, err),
})

/* Long enough to mean "this caller actually needs the value, not a fast paint".
 * Used by the paths that build the brief *text* Alpha sends: they have to wait
 * for the real payload anyway, and going through the cache means the card link
 * they are about to text is already warm when it gets tapped. */
const BRIEF_WARM_WAIT_MS = 60_000

/* ---- Persisted brief cache ----
 * The in-memory stale caches above live and die with the container. A brief is
 * still useful the moment a tap lands after a deploy, so the last successful
 * build of the day is kept in Postgres as a one-minute stand-in — anything the
 * client holds is a paint that must not be *served* as if it were current. */
/* The whole point of the client keeping a 4-hour copy is a fast paint; the
 * server must never serve that copy as current. Mail only stays true for
 * minutes, so a persisted row is trusted for a single minute and every later
 * open rebuilds (calendar + Gmail + model) behind the client's already-painted
 * screen — the retry ladder swaps in the fresh mail a couple of seconds later
 * instead of showing you three-hour-old mail as today's. The in-memory cache
 * above already makes repeat opens within four minutes free. */

/**
 * Free tier rationing. With FREE_TIER_LIMIT unset the brief builds free, exactly
 * as before. When set, a user with no active subscription gets that many brief
 * kinds refreshed per rolling week: each build stamps built_at on its
 * (persona, kind) row in hire_brief_cache, so counting rows touched this week
 * counts builds. Past the cap the last cached build is served stale; a kind
 * with no cache row still builds once, because there is nothing to serve.
 *
 * Returns { allowed, used, limit } so the caller can surface "you've used N of
 * M brief refreshes this week" instead of silently serving yesterday's brief
 * as today's. */
export interface BriefBuildStatus {
  allowed: boolean
  used?: number
  limit?: number
}
async function briefBuildAllowed(sql: SQL, userId: string): Promise<BriefBuildStatus> {
  // Free mode: nothing is rationed, whatever FREE_TIER_LIMIT says.
  if (!paymentsOn()) return { allowed: true }
  const limit = Number(process.env.FREE_TIER_LIMIT || '')
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true }
  try {
    const subs = (await sql`
      SELECT 1 FROM hire_subscriptions
      WHERE user_id = ${userId} AND status IN ('active', 'trialing')
      LIMIT 1
    `) as unknown[]
    if (subs.length) return { allowed: true }
    const counts = (await sql`
      SELECT count(*) AS n FROM hire_brief_cache
      WHERE user_id = ${userId} AND built_at > now() - interval '7 days'
    `) as Array<{ n: string | number }>
    const used = Number(counts[0]?.n ?? 0)
    return { allowed: used < limit, used, limit }
  } catch {
    // Rationing must never take the brief down.
    return { allowed: true }
  }
}

/** What the route handler hands back: the payload it was going to serve, plus
 * a flag telling the client that this came from the rationing path so the
 * brief can show "free refreshes used up, here's what we have until next week"
 * instead of pretending today's brief was fresh. */
export interface BriefLoadResult<T> {
  payload: T
  throttled: boolean
  used?: number
  limit?: number
}

/** Serve today's persisted brief when it is still fresh-ish; otherwise build and persist.
 *
 * `force: true` skips every stale cache (in-memory, persisted, and rationing)
 * and rebuilds against the live calendar/inbox/model — the right answer for the
 * user's "I just hit refresh, give me a real answer" button. Without it the
 * rationing path can serve yesterday's row for a user who is over the free-tier
 * cap, and the brief looks frozen on the wrong day.
 *
 * When the rationing path serves a stale-but-same-day row on purpose, the
 * returned result is marked `throttled: true` with the `used`/`limit` numbers
 * so the route handler can surface "you've used N of M" — silent stale
 * delivery is what made users think the brief never updated. */
async function briefLoader<T>(
  sql: SQL,
  userId: string,
  persona: string,
  kind: string,
  build: () => Promise<T>,
  day: string,
  opts?: { force?: boolean },
): Promise<BriefLoadResult<T>> {
  const row = await readBriefDb(sql, userId, persona, kind)
  if (!opts?.force && row && briefRowFresh(Date.now() - new Date(row.builtAt).getTime(), day, row.day)) {
    return { payload: row.payload as T, throttled: false }
  }
  /* The rationing path intentionally serves a stale rows for users past the free-tier
   * build cap — but only when that rows is for TODAY. A cross-day rows served "stale
   * on purpose" would paint yesterday's brief as today's, which is the bug that
   * reports the brief as stuck on the wrong date. Same-day stale is still OK. */
  if (!opts?.force && row && briefRowSameDay(row.day, day)) {
    const status = await briefBuildAllowed(sql, userId)
    if (!status.allowed) {
      return { payload: row.payload as T, throttled: true, used: status.used, limit: status.limit }
    }
  }
  const payload = await build()
  await writeBriefDb(sql, userId, persona, kind, day, payload)
  return { payload, throttled: false }
}

async function loadHomeWorld(sql: SQL, user: AuthedUser, tzLocal: string): Promise<HomeWorld> {
  const world: HomeWorld = { upcoming: [], mail: [], mailGroups: [], meetings: [], attention: null }
  const jobs: Array<Promise<void>> = []
  jobs.push(
    (async () => {
      // Shared with /api/network, so opening home and the People list is one
      // calendar fetch between them rather than two.
      const cal = await withTimeout(
        todayMeetsCache
          .read(`${user.id}|friend`, () => todayCalendarMeets(sql, user, 'friend'))
          .then((r) => r.value ?? EMPTY_TODAY_RESULT),
        8000,
        EMPTY_TODAY_RESULT,
      )
      world.upcoming = cal.meets
        .map((m) => ({ time: m.time, title: m.who || m.title }))
      world.meetings = remainingTodayMeets(cal.meets, tzLocal)
      if (world.upcoming.length) return
      const rows = await withTimeout(loadWorldCalendar(sql, user, tzLocal), 8000, [] as string[])
      world.upcoming = rows
        .slice(0, 8)
        .map((line) => {
          const parts = line.split(' · ')
          return { time: parts[0] || '', title: parts.slice(1).join(' · ') || line }
        })
      world.meetings = remainingTodayMeets(
        world.upcoming.map((e) => ({ time: e.time, title: e.title, who: e.title })),
        tzLocal,
      )
    })(),
  )
  jobs.push(
    withTimeout(
      (async () => {
        const rich = await loadGmailRich(sql, user.id, importantMailQuery('2d'), JUDGE_MAIL_CAP)
        if (!rich.length) return []
        // One model call judged everything, from cache when fresh. The regex
        // pick stays only for the run where the model answers nothing.
        const [vocab, verdicts] = await Promise.all([
          loadMailKindVocab(sql, user.id),
          loadJudgeVerdicts(sql, user.id, rich, [], user.timezone),
        ])
        const labelled: MailKindItem[] = rich.map((m) => ({ ...m, kind: verdicts?.mails.get(m.id)?.kind }))
        // One email above the pile counts: the model's highest-urgency needs-you
        // mail, with its reason line. Regex pick is the model-down fallback.
        const attentionLines = new Map(
          rich.map((m) => [
            m.id,
            { label: formatMailLineFromParts(m.from, m.subject), snippet: cleanMailSnippet(m.snippet || '') },
          ]),
        )
        // When the model answered, its pick rules — even when it names nothing,
        // the slot drops quietly instead of regexes resurfacing a promo. Regex
        // pick only for the model-down run.
        world.attention = verdicts
          ? judgedAttentionPick(verdicts, attentionLines)
          : pickAttentionEmail(
            labelled.map((m) => ({
              id: m.id,
              label: formatMailLineFromParts(m.from, m.subject),
              snippet: cleanMailSnippet(m.snippet || ''),
              kind: m.kind,
              sender: m.from,
            })),
          )
        // Home shows the whole batch grouped rather than a judged top three:
        // the pile counts are what the section is for. Unjudged items still
        // land somewhere via the regex fallback inside groupMailByKind.
        const groups = groupMailByKind(labelled, { vocab, maxGroups: 4 })
        // Not awaited: the vocabulary is an optimisation for tomorrow's run,
        // and it must not spend this request's mail budget. It swallows its
        // own errors, so there is nothing here to reject.
        void saveMailKindVocab(sql, user.id, groups)
        return groups
      })(),
      8000,
      [] as ReturnType<typeof groupMailByKind>,
    ).then((groups) => {
      world.mailGroups = groups.map((g) => ({
        kind: g.kind,
        label: g.label,
        count: g.count,
        items: g.items.slice(0, 4).map((m) => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          snippet: cleanMailSnippet(m.snippet || ''),
        })),
      }))
      // The flat list stays alongside the groups so a client built before this
      // change still shows mail instead of an empty section.
      world.mail = groups
        .flatMap((g) => g.items)
        .slice(0, 3)
        .map((m) => ({ from: m.from, subject: m.subject }))
    }),
  )
  // One failing half must not throw away the other half, and a wholly failed
  // load must reject so the cache keeps the last good answer instead of caching
  // emptiness for ninety seconds.
  const settled = await Promise.allSettled(jobs)
  const failures = settled.filter((s) => s.status === 'rejected')
  if (failures.length === settled.length) throw (failures[0] as PromiseRejectedResult).reason
  for (const failure of failures) console.warn('[home] world job failed', (failure as PromiseRejectedResult).reason)
  return world
}

/** The work personas' morning pull: one boxed section set per hire, appended to
 * the digest text so the thread itself replaces opening Slack/Linear/Notion. */
export function workPullSections(input: {
  persona: 'coworker' | 'cofounder'
  linear?: Array<{ identifier: string; title: string; state?: string }>
  prs?: string[]
  draftsCount?: number
  pipeline?: Array<{ stage: string; value: number }>
  decisionsOpen?: number
  oldestDecisionDays?: number
  runway?: { cash: number; burn: number; months: number } | null
}): Array<{ title: string; lines: string[] }> {
  const sections: Array<{ title: string; lines: string[] }> = []
  if (input.persona === 'coworker') {
    const needsYou = (input.linear || []).filter((i) => !/done|canceled|closed/i.test(i.state || ''))
    if (needsYou.length) {
      sections.push({
        title: 'Linear',
        lines: needsYou.slice(0, 4).map((i) => `${i.identifier} ${i.title}`),
      })
    }
    if (input.prs?.length) {
      sections.push({ title: 'PRs needing your pass', lines: input.prs.slice(0, 4) })
    }
    if (input.draftsCount) {
      sections.push({ title: 'Drafts ready to send', lines: [`${input.draftsCount} waiting`] })
    }
  } else if (input.persona === 'cofounder') {
    const live = input.pipeline || []
    const total = live.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0)
    const offers = live.filter((p) => p.stage === 'offer').length
    if (live.length) {
      sections.push({
        title: 'Pipeline',
        lines: [
          `${live.length} live${total > 0 ? ` · $${Math.round(total / 1000)}k` : ''}${offers ? ` · ${offers} offers out` : ''}`,
        ],
      })
    }
    if (input.decisionsOpen) {
      sections.push({
        title: 'Decisions',
        lines: [`${input.decisionsOpen} open${input.oldestDecisionDays ? ` · oldest ${input.oldestDecisionDays}d` : ''}`],
      })
    }
    if (input.runway && input.runway.months > 0) {
      sections.push({
        title: 'Runway',
        lines: [
          `${Math.round(input.runway.months)} months ($${Math.round(input.runway.cash)} cash @ $${Math.round(input.runway.burn)}/mo)`,
        ],
      })
    }
  }
  return sections
}

/* ---- What is left of today, and the one email to look at ----
 * Both briefs and home already load the calendar and the inbox; these two pure
 * helpers package what those loads returned for the screens that show it. */

export type DigestMeeting = { time: string; title: string; startsInMin?: number; prep?: boolean; prepWhy?: string }

/** Minutes after midnight for "2:30 PM", "10am" or "14:05". NaN for anything else. */
function parseClockMinutes(value: string): number {
  const m = String(value || '')
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return NaN
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return NaN
  return h * 60 + min
}

function nowMinutesInTz(tz: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now)
    const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24
    const min = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(h) || !Number.isFinite(min)) return NaN
    return h * 60 + min
  } catch {
    return NaN
  }
}

/**
 * Today's meetings still ahead of the user, soonest first, eight max. End times
 * are not carried on the meet rows, so a meeting that already started counts as
 * in progress for an hour and then leaves the list. Eight because the promise
 * this screen makes is that nothing on today's calendar goes unseen; a busy day
 * used to silently lose its tail past five.
 */
export function remainingTodayMeets(
  meets: Array<{ time: string; title: string; who?: string }>,
  tz: string,
  now = new Date(),
): DigestMeeting[] {
  const nowMin = nowMinutesInTz(tz, now)
  if (Number.isNaN(nowMin)) return []
  const out: DigestMeeting[] = []
  for (const m of meets) {
    if (/^all day$/i.test(String(m.time || '').trim())) continue
    const startMin = parseClockMinutes(m.time)
    if (Number.isNaN(startMin)) continue
    if (startMin < nowMin && nowMin - startMin > 60) continue
    out.push({ time: m.time, title: m.who || m.title, startsInMin: Math.max(0, startMin - nowMin) })
  }
  out.sort((a, b) => (a.startsInMin ?? 0) - (b.startsInMin ?? 0))
  return out.slice(0, 8)
}

export type AttentionCandidate = {
  id: string
  label: string
  snippet?: string
  kind?: string
  sender?: string
}
export type AttentionPick = { id: string; label: string; snippet?: string; why: string }

/* One pile name or sender is enough to call a mail money, but a bare receipt is
 * not — receipts only count when the text still owes something. */
const MONEY_KIND_RE = /money|bill|invoice|payment|due|expense|finance|statement|banking/i
const MONEY_SENDER_RE = /billing|invoic|payment|statement|utility|\bbank|accounts? receivable/i
const RECEIPT_RE = /receipt|order|confirmation/i
const OWED_RE = /amount due|balance|owed|past due|payment due|due by|\$\s?\d/i
const NEWSLETTER_RE = /newsletter|promo|deals?|digest|unsubscribe|no[- ]?reply|daily brief|notification/i
const URGENT_RE = /\b(today|tonight|eod|deadline|overdue|rsvp|expires?|final notice)\b/i

function attentionIsNewsletter(item: AttentionCandidate): boolean {
  return NEWSLETTER_RE.test(`${item.kind || ''} ${item.label} ${item.snippet || ''}`)
}

function attentionName(item: AttentionCandidate): string {
  const fromLabel = String(item.label || '').split(' · ').pop() || ''
  const raw = String(item.sender || fromLabel).replace(/<[^>]+>/g, '').trim()
  const name = raw.split('@')[0]!.replace(/[^\w '.-]/g, '').trim()
  return name.slice(0, 24)
}

/* Money: a pile or sender that bills, but a bare receipt only counts when the
 * text still owes something. Newsletters never count as money. */
function attentionMoneyWhy(item: AttentionCandidate): string | null {
  const kindSender = `${item.kind || ''} ${item.sender || ''}`
  if (attentionIsNewsletter(item)) return null
  const text = `${item.label} ${item.snippet || ''}`
  if (MONEY_KIND_RE.test(kindSender) && !RECEIPT_RE.test(kindSender)) {
    return /invoice/i.test(kindSender) ? 'invoice due' : 'bill due'
  }
  if (MONEY_SENDER_RE.test(item.sender || '') || (RECEIPT_RE.test(kindSender) && OWED_RE.test(text))) {
    return 'payment due'
  }
  return null
}

function attentionUrgentWhy(item: AttentionCandidate): string | null {
  const urgent = `${item.label} ${item.snippet || ''}`.match(URGENT_RE)
  if (!urgent) return null
  const w = urgent[1]!.toLowerCase()
  if (w === 'rsvp') return 'RSVP needed'
  if (w === 'overdue' || w === 'final notice') return 'past due'
  if (/expire/.test(w)) return 'expires soon'
  return 'deadline today'
}

function attentionPersonalWhy(item: AttentionCandidate): string | null {
  if (attentionIsNewsletter(item)) return null
  if (!item.snippet || !item.snippet.trim()) return null
  const name = attentionName(item)
  return name ? `from ${name}` : 'needs a reply'
}

/**
 * The one email worth putting above the pile counts. Priority over the whole
 * list: money that needs action, then deadline language, then the first mail
 * that reads like a person wrote it. Null when nothing qualifies, so screens
 * can drop the slot quietly.
 */
export function pickAttentionEmail(
  items: AttentionCandidate[],
  _now: Date = new Date(),
): AttentionPick | null {
  const tiers = [attentionMoneyWhy, attentionUrgentWhy, attentionPersonalWhy]
  for (const tier of tiers) {
    for (const item of items) {
      if (!item?.id) continue
      const why = tier(item)
      if (why) return { id: item.id, label: item.label, snippet: item.snippet, why }
    }
  }
  return null
}

/**
 * Promises found in judged mail become open loops: an email that carries a
 * commitment ("I'll send the deck Thursday") lands on the Promises card with
 * the mail it came from as context, instead of dying in the inbox. Deduped on
 * the loop title so the same email does not spawn a loop on every brief, and
 * capped at three per run so one noisy inbox cannot flood the card.
 */
async function saveMailPromiseLoops(
  sql: SQL,
  userId: string,
  persona: Persona,
  promises: Array<{ title: string; context: string }>,
) {
  for (const p of promises.slice(0, 3)) {
    const title = p.title.trim().slice(0, 200)
    if (!title) continue
    const existing = await sql`
      SELECT id FROM hire_loops
      WHERE user_id = ${userId} AND status = 'open' AND lower(title) = lower(${title})
      LIMIT 1
    `
    if (existing.length) continue
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context)
      VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${title}, ${p.context.slice(0, 500)})
    `
  }
}

/** Live weather for the chat lookup: a place in words, current plus a 4-day
 * forecast from open-meteo (free, no key). The brief has the user's own
 * coordinates; this answers "SF this weekend" and "good day to wash the car"
 * with real numbers instead of climate averages. */
async function fetchWeatherLookup(place: string, tz: string, countryHint: string): Promise<string> {
  const fallback = TZ_DEFAULT_COORDS[tz] || TZ_DEFAULT_COORDS['America/Los_Angeles']!
  let lat = fallback.lat
  let lon = fallback.lon
  let city = fallback.city
  const clean = place.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (clean) {
    const area = await nominatimArea(clean, countryHint).catch(() => null)
    if (area) {
      lat = area.lat
      lon = area.lon
      city = clean
    }
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&temperature_unit=fahrenheit&timezone=auto&forecast_days=4`
    const res = await withTimeout(fetch(url, { signal: AbortSignal.timeout(6000) }), 6000, null)
    if (!res || !res.ok) return 'Weather could not be loaded right now. Do not guess numbers.'
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number }
      daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; weather_code?: number[] }
    }
    const lines: string[] = []
    const cur = data.current
    if (cur?.temperature_2m !== undefined) {
      const w = weatherCodeToHuman(cur.weather_code ?? 0)
      lines.push(`Now in ${city}: ${w.icon} ${Math.round(cur.temperature_2m)}°F, ${w.condition.toLowerCase()}`)
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    for (let i = 0; i < Math.min(4, data.daily?.time?.length || 0); i++) {
      const hi = data.daily!.temperature_2m_max?.[i]
      const lo = data.daily!.temperature_2m_min?.[i]
      if (hi === undefined) continue
      const d = new Date(`${data.daily!.time![i]}T12:00:00`)
      const w = weatherCodeToHuman(data.daily!.weather_code?.[i] ?? 0)
      lines.push(`${dayNames[d.getDay()]}: ${w.icon} high ${Math.round(hi)}°F / low ${Math.round(lo ?? 0)}°F, ${w.condition.toLowerCase()}`)
    }
    return lines.length ? `Live weather (open-meteo):\n${lines.join('\n')}` : 'Weather service returned no data. Do not guess.'
  } catch {
    return 'Weather could not be loaded right now. Do not guess numbers.'
  }
}

const TZ_DEFAULT_COORDS: Record<string, { lat: number; lon: number; city: string }> = {
  'America/Los_Angeles': { lat: 37.7749, lon: -122.4194, city: 'San Francisco' },
  'America/New_York': { lat: 40.7128, lon: -74.0060, city: 'New York' },
  'America/Chicago': { lat: 41.8781, lon: -87.6298, city: 'Chicago' },
  'America/Denver': { lat: 39.7392, lon: -104.9903, city: 'Denver' },
  'America/Phoenix': { lat: 33.4484, lon: -112.0740, city: 'Phoenix' },
  'America/Anchorage': { lat: 61.2181, lon: -149.9003, city: 'Anchorage' },
  'Pacific/Honolulu': { lat: 21.3069, lon: -157.8583, city: 'Honolulu' },
  'Europe/London': { lat: 51.5074, lon: -0.1278, city: 'London' },
  'Europe/Paris': { lat: 48.8566, lon: 2.3522, city: 'Paris' },
  'Asia/Tokyo': { lat: 35.6762, lon: 139.6503, city: 'Tokyo' },
  'Asia/Singapore': { lat: 1.3521, lon: 103.8198, city: 'Singapore' },
  'Asia/Kolkata': { lat: 19.0760, lon: 72.8777, city: 'Mumbai' },
  'Australia/Sydney': { lat: -33.8688, lon: 151.2093, city: 'Sydney' },
}

export function weatherCodeToHuman(code: number): { condition: string; icon: string } {
  if (code === 0) return { condition: 'Sunny', icon: '☀️' }
  if (code === 1 || code === 2) return { condition: 'Partly cloudy', icon: '⛅' }
  if (code === 3) return { condition: 'Overcast', icon: '☁️' }
  if (code === 45 || code === 48) return { condition: 'Foggy', icon: '🌫️' }
  if (code >= 51 && code <= 55) return { condition: 'Drizzle', icon: '🌦️' }
  if (code >= 61 && code <= 65) return { condition: 'Rain', icon: '🌧️' }
  if (code >= 71 && code <= 77) return { condition: 'Snow', icon: '❄️' }
  if (code >= 80 && code <= 82) return { condition: 'Showers', icon: '🌧️' }
  if (code >= 85 && code <= 86) return { condition: 'Snow showers', icon: '🌨️' }
  if (code >= 95 && code <= 99) return { condition: 'Thunderstorms', icon: '⛈️' }
  return { condition: 'Clear', icon: '☀️' }
}

export type BriefWeather = {
  temp: number
  unit: string
  tempC?: number
  condition: string
  icon: string
  high?: number
  low?: number
  highC?: number
  lowC?: number
  summary: string
  city?: string
}

export async function fetchWeatherForUser(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
): Promise<BriefWeather | null> {
  const activeLoc = await pickActiveLocation(sql, user.id).catch(() => null)
  let lat = 37.7749
  let lon = -122.4194
  let city: string | undefined

  if (activeLoc && coordsUsable(activeLoc.latitude, activeLoc.longitude)) {
    lat = activeLoc.latitude
    lon = activeLoc.longitude
    city = activeLoc.label || locationLabel(activeLoc)
  } else {
    const tz = user.timezone || 'America/Los_Angeles'
    const fallback = TZ_DEFAULT_COORDS[tz] || TZ_DEFAULT_COORDS['America/Los_Angeles']!
    lat = fallback.lat
    lon = fallback.lon
    city = fallback.city
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&temperature_unit=fahrenheit&timezone=auto`
    const res = await withTimeout(fetch(url, { signal: AbortSignal.timeout(2500) }), 2500, null)
    if (!res || !res.ok) return null
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number }
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] }
    }
    const current = data?.current
    if (!current || current.temperature_2m === undefined) return null
    const code = current.weather_code ?? 0
    const { condition, icon } = weatherCodeToHuman(code)
    const temp = Math.round(current.temperature_2m)
    const tempC = Math.round(((temp - 32) * 5) / 9)
    const high = data.daily?.temperature_2m_max?.[0] !== undefined ? Math.round(data.daily.temperature_2m_max[0]) : undefined
    const low = data.daily?.temperature_2m_min?.[0] !== undefined ? Math.round(data.daily.temperature_2m_min[0]) : undefined
    const highC = high !== undefined ? Math.round(((high - 32) * 5) / 9) : undefined
    const lowC = low !== undefined ? Math.round(((low - 32) * 5) / 9) : undefined
    const range = high !== undefined && low !== undefined ? ` (high ${high}°F / ${highC}°C, low ${low}°F / ${lowC}°C)` : ''
    const summary = `${icon} ${temp}°F / ${tempC}°C · ${condition}${city ? ` in ${city}` : ''}${range}`
    return {
      temp,
      unit: 'F',
      tempC,
      condition,
      icon,
      high,
      low,
      highC,
      lowC,
      summary,
      city,
    }
  } catch {
    return null
  }
}

export async function digestPayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
) {
  const travelContext = await loadContext(sql, user.id, persona)
  const tz = effectiveTz(user.timezone, travelContext)

  const tomorrowStart = startOfLocalDay(tz, 1)
  const dayAfterStart = startOfLocalDay(tz, 2)
  const tomorrowYmd = tomorrowStart.toLocaleDateString('en-CA', { timeZone: tz })

  // Calendar, mail, and weather race concurrently; all fast and non-blocking.
  const [calToday, tomorrowCalItems, mail, weather] = await Promise.all([
    /* Shared with home and the People list. The brief is reached from home's
     * dock, so by the time it is opened this is usually a warm hit and today's
     * calendar costs nothing instead of another second on Google. The long wait
     * is for the cold case: unlike home, the brief cannot paint around a missing
     * calendar, and a 2.5s timeout here would cache an empty day for a TTL. */
    todayMeetsCache
      .read(`${user.id}|${persona}`, () => todayCalendarMeets(sql, user, persona), 8000)
      .then((r) => r.value ?? EMPTY_TODAY_RESULT),
    (async () => {
      const items: CalItem[] = []
      try {
        const access = await googleAccessToken(sql, user.id, 'calendar')
        if (!access) return items
        const got = await withTimeout(
          fetchCalendarItems(access, {
            timeMin: tomorrowStart,
            timeMax: dayAfterStart,
            maxResults: 12,
          }),
          8000,
          { ok: false as const, status: 0 },
        )
        if (got.ok) {
          for (const e of got.items) {
            const ymd = e.start.toLocaleDateString('en-CA', { timeZone: tz })
            if (ymd === tomorrowYmd && !isHotelStayEvent(e)) items.push(e)
          }
        }
      } catch {
        // Tomorrow is decoration; never let it hold the brief.
      }
      return items
    })(),
    (async () => {
      type NeedsYouRowT = { id: string; label: string; snippet?: string; score: number; reasons: string[] }
      type GroupT = { kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }
      let ny: NeedsYouRowT[] = []
      let groups: GroupT[] = []
      let tallyLine = ''
      let judgeOut: JudgeAll | null = null
      let mailStatus: ConnectorStatus = 'ok'
      try {
        // The judge decides keep-or-drop, the pile, needs-you, urgency, and
        // promises in one pass — from cache when it is fresh. A run where the
        // model is unavailable falls back to the regex kinds inside
        // groupMailByKind. The full batch is still shown either way.
        const [vocab, doneIds, signals, mailResult] = await Promise.all([
          loadMailKindVocab(sql, user.id),
          triagedMailIds(sql, user.id),
          loadMailSenderSignals(sql, user.id),
          withTimeout(
            readGmailExact(sql, user.id, importantMailQuery('3d'), JUDGE_MAIL_CAP),
            9000,
            { items: [] as Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }>, failed: true, status: 'timeout' as const },
          ),
        ])
        const richItems = mailResult.items
        mailStatus = mailResult.status || 'ok'
        // Today's meetings ride in the same single model call. The extra
        // todayMeetsCache read is deduped with the calendar job racing in
        // parallel above, so this costs a fetch only in the cold case.
        const calForJudge = await todayMeetsCache
          .read(`${user.id}|${persona}`, () => todayCalendarMeets(sql, user, persona), 8000)
          .then((r) => r.value ?? EMPTY_TODAY_RESULT)
        const judgeMeets: JudgeMeetIn[] = calForJudge.meets.map((m) => ({
          id: meetJudgeKey(m),
          time: m.time,
          title: m.who || m.title,
        }))
        const allVerdicts = await loadJudgeVerdicts(sql, user.id, richItems, judgeMeets, tz, vocab)
        judgeOut = allVerdicts
        const verdicts = allVerdicts?.mails ?? new Map<string, MailVerdict>()
        const labelled: MailKindItem[] = richItems.map((m) => ({ ...m, kind: verdicts.get(m.id)?.kind }))
        // Promises: judged mail that carries a commitment becomes an open loop
        // on the Promises card. Best effort and fire and forget, so it never
        // holds or breaks the brief.
        const mailPromises = richItems
          .map((m) => ({ promise: verdicts.get(m.id)?.promise?.trim(), m }))
          .filter((r): r is { promise: string; m: (typeof richItems)[number] } => !!r.promise)
          .map(({ promise, m }) => ({
            title: promise,
            context: `From mail: ${formatMailLineFromParts(m.from, m.subject)}`,
          }))
        if (mailPromises.length) {
          void saveMailPromiseLoops(sql, user.id, persona, mailPromises).catch(() => {})
        }
        // Mail the user already handled leaves both Needs You and the piles. This
        // is what makes Done and Skip stick instead of popping back on reload.
        const visible: MailKindItem[] = labelled.filter((m) => !doneIds.has(m.id))
        // Needs You: the model's judgment now — the three needs-you mails with
        // the highest urgency, each with its own reason line. The regex scorer
        // runs only when the model answered nothing at all.
        type LeadT = { id: string; from: string; subject: string; snippet?: string; score: number; reasons: string[] }
        let leads: LeadT[] = allVerdicts
          ? visible
              .filter((m) => m.id && !m.id.startsWith('text-'))
              .map((m) => ({ m, v: verdicts.get(m.id) }))
              .filter((r): r is { m: (typeof visible)[number]; v: MailVerdict } => !!r.v && r.v.needsYou && r.v.keep)
              .sort((a, b) => b.v.score - a.v.score)
              .slice(0, 8)
              .map(({ m, v }) => ({
                id: m.id,
                from: m.from,
                subject: m.subject,
                snippet: m.snippet,
                score: v.score,
                reasons: [v.why].filter(Boolean),
              }))
          : []
        if (!leads.length) {
          leads = topNeedsYou(
            visible.filter((m) => m.id && !m.id.startsWith('text-')),
            (key) => signals.get(key),
            8,
          )
            .filter((m) => m.score >= 50)
            .map((m) => ({ ...m, reasons: m.reasons }))
        }
        const leadIds = new Set(leads.map((m) => m.id))
        const replyMails = visible.filter((m) => !leadIds.has(m.id) && (m.kind === 'reply' || classifyBriefMail(m) === 'reply'))
        for (const m of replyMails) {
          leads.push({
            id: m.id,
            from: m.from,
            subject: m.subject,
            snippet: m.snippet,
            score: 80,
            reasons: ['waiting_on_you'],
          })
          leadIds.add(m.id)
        }
        ny = leads.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet || ''),
          score: Math.round(m.score),
          reasons: m.reasons,
        }))
        const grouped = groupMailByKind(
          visible.filter((m) => !leadIds.has(m.id)),
          { vocab },
        )
        groups = grouped.map((g) => ({
          kind: g.kind,
          label: g.label,
          count: g.count,
          items: g.items.map((m) => ({
            id: m.id,
            label: formatMailLineFromParts(m.from, m.subject),
            snippet: cleanMailSnippet(m.snippet || ''),
          })),
        }))
        tallyLine = mailTally(grouped)
        void saveMailKindVocab(sql, user.id, grouped).catch(() => {})
      } catch {
        // best-effort
      }
      return {
        needsYou: ny,
        groups,
        tally: tallyLine,
        mailStatus,
        verdicts: judgeOut
          ? { mails: [...judgeOut.mails.values()], meets: [...judgeOut.meets.values()] }
          : null,
      }
    })(),
    fetchWeatherForUser(sql, user),
  ])

  const beats = calToday.meets
    .map((m) => ({ time: m.time, name: m.who || m.title, kind: m.kind }))
  let todayCal = beats.map((b) =>
    b.kind && b.kind !== 'Meeting' ? `${b.time} · ${b.name} · ${b.kind}` : `${b.time} · ${b.name}`,
  )
  if (!todayCal.length && calToday.calendarConnected) {
    if (calToday.calendarStatus === 'auth_expired') {
      todayCal = ['Calendar authorization expired. Reconnect in Settings.']
    } else if (calToday.calendarStatus === 'timeout') {
      todayCal = ['Calendar check timed out.']
    } else if (calToday.calendarFailed || calToday.calendarStatus === 'provider_error') {
      todayCal = ['Could not check your calendar just now.']
    }
  }

  const myName = user.name || null
  const tomorrowCal = tomorrowCalItems.map((e) => formatDigestEventLabel(e, tz, myName))

  // Pass empty events[] so the frontend never shows Yes/No RSVP buttons.
  // The brief is a read-only view; calendar is already in todayCal.
  const events: Array<{ id: string; label: string }> = []

  let finalEmailItems: Array<{ id: string; label: string; snippet?: string }> = []
  let finalEmails: string[] = []
  let mailGroups: Array<{ kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }> = []
  let mailTallyLine = ''
  let needsYou: Array<{ id: string; label: string; snippet?: string; score: number; reasons: string[] }> = []
  needsYou = mail.needsYou
  mailGroups = mail.groups
  mailTallyLine = mail.tally
  const judgeVerdicts = mail.verdicts
  finalEmailItems = mailGroups.flatMap((g) => g.items)
  finalEmails = finalEmailItems.map((e) => e.label)

  let mailReadFailed = mail.mailStatus === 'auth_expired' || mail.mailStatus === 'timeout' || mail.mailStatus === 'provider_error'
  if (mail.mailStatus === 'auth_expired' && !finalEmails.length) {
    mailTallyLine = 'Gmail authorization expired. Reconnect in Settings.'
  } else if (mail.mailStatus === 'timeout' && !finalEmails.length) {
    mailTallyLine = 'Gmail check timed out.'
  }

  if (!finalEmails.length && !mailReadFailed) {
    // A first read that comes back empty is usually a lost race, not an empty
    // inbox: the token refresh it started keeps running, so seconds later the
    // same read lands. Retry that before falling to the text-only scan below —
    // only this path hands back Gmail message ids, and an id is what makes a
    // row openable and its Draft reply button real.
    try {
      const retry = await withTimeout(
        readGmailExact(sql, user.id, importantMailQuery('3d'), JUDGE_MAIL_CAP),
        9000,
        { items: [] as Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }>, failed: true, status: 'timeout' as const },
      )
      if (retry.items.length) {
        const done = await triagedMailIds(sql, user.id).catch(() => new Set<string>())
        const grouped = groupBriefMail(retry.items.filter((m) => !done.has(m.id)))
        mailGroups = grouped.map((g) => ({
          kind: g.kind,
          label: g.label,
          count: g.count,
          items: g.items.map((m) => ({
            id: m.id,
            label: formatMailLineFromParts(m.from, m.subject),
            snippet: m.snippet,
          })),
        }))
        mailTallyLine = mailTally(grouped)
        finalEmailItems = mailGroups.flatMap((g) => g.items)
        finalEmails = finalEmailItems.map((e) => e.label)
      }
    } catch {
      // best-effort; the text scan below is the last resort
    }
  }

  /* Set when every mail read failed rather than finding nothing. Without this
   * the brief simply had no Mail section — Gmail down and an empty inbox looked
   * identical to the user, and the card's degraded notice requires rows that do
   * not exist in that case. */
  if (!finalEmails.length && !mailReadFailed) {
    try {
      const mailBlock = await withTimeout(
        loadGmail(sql, user.id, importantMailQuery('3d'), JUDGE_MAIL_CAP),
        8000,
        '',
      )
      if (/lookup failed|failed to|not connected|did not go through/i.test(mailBlock) && !digestLines(mailBlock).length) {
        mailReadFailed = true
      }
      const rows = digestLines(mailBlock)
        .map((line, i) => {
          const [from, , subject] = line.replace(/^-\s*/, '').split(' | ')
          return {
            id: `text-${i}`,
            from: from || '',
            subject: subject || formatMailLine(line),
            snippet: '',
          }
        })
        .filter((m) => m.from || m.subject)
      const grouped = groupBriefMail(rows)
      mailGroups = grouped.map((g) => ({
        kind: g.kind,
        label: g.label,
        count: g.count,
        items: g.items.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: '',
        })),
      }))
      mailTallyLine = mailTally(grouped)
      finalEmailItems = mailGroups.flatMap((g) => g.items)
      finalEmails = finalEmailItems.map((e) => e.label)
    } catch {
      // best-effort
    }
  }

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  )
  const brief = hour >= 16 ? 'evening' : 'morning'
  const wrapTitle = brief === 'evening' ? 'Evening brief' : 'Morning brief'

  const todayLocal = localDateStrInTz(new Date(), tz)
  const weekStartLocal = mondayOfDateStr(todayLocal)
  const lastNightKey = shiftDateStr(todayLocal, -1)

  // The screens want two things the raw piles do not surface: what is left of
  // the day on the calendar, and the single mail to see before the counts.
  // Both come from the model's verdicts when it answered; the regex layers are
  // the model-down fallback. A meeting the model flagged prep:true carries its
  // reason onto the digest row.
  const meetsWithPrep = remainingTodayMeets(calToday.meets, tz).map((m) => {
    const v = judgeVerdicts?.meets.find((j) => j.id === meetJudgeKey(m))
    return v && v.prep ? { ...m, prep: true, prepWhy: v.why } : m
  })
  const meetings: DigestMeeting[] = meetsWithPrep
  const attentionLines = new Map(
    [
      ...needsYou.map((n) => ({ id: n.id, label: n.label, snippet: n.snippet })),
      ...mailGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, label: it.label, snippet: it.snippet })),
      ),
    ].map((l) => [l.id, { label: l.label, snippet: l.snippet }]),
  )
  const attention =
    (judgeVerdicts &&
      judgedAttentionPick({ mails: new Map(judgeVerdicts.mails.map((m) => [m.id, m])), meets: new Map() }, attentionLines)) ||
    pickAttentionEmail([
      ...needsYou.map((n) => ({ id: n.id, label: n.label, snippet: n.snippet })),
      ...mailGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, label: it.label, snippet: it.snippet, kind: g.kind })),
      ),
    ])

  // The half-dozen small reads used to run one after another; none depends on
  // the next, so they all leave together.
  const [reminderRows, loopRows, lastNightRow, factExtras] = await Promise.all([
    sql`
      SELECT id, text, scheduled_at AS "scheduledAt" FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending'
      ORDER BY scheduled_at ASC LIMIT 8
    `,
    sql`
      SELECT title, due_at AS "dueAt" FROM hire_loops
      WHERE user_id = ${user.id} AND status = 'open'
      ORDER BY created_at DESC LIMIT 8
    `,
    sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
      WHERE user_id = ${user.id} AND (sleep_date = ${lastNightKey} OR sleep_date = ${todayLocal})
      ORDER BY sleep_date DESC LIMIT 1
    `,
    (async () => {
      try {
        const [liftRows, spendRows, budgetRow, habitRows] = await Promise.all([
          sql`SELECT count(*)::int AS n FROM hire_workouts
            WHERE user_id = ${user.id} AND (logged_at AT TIME ZONE ${tz})::date >= ${weekStartLocal}`,
          sql`SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
            WHERE user_id = ${user.id} AND (spent_at AT TIME ZONE ${tz})::date >= ${weekStartLocal}`,
          sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`,
          sql`SELECT id FROM hire_habits WHERE user_id = ${user.id}`,
        ])
        const liftsThisWeek = Number((liftRows[0] as { n?: number })?.n) || 0
        const spendWeek = Number((spendRows[0] as { total?: number })?.total) || 0
        const budget = Math.round((budgetRow as { weeklyBudget?: number }[])[0]?.weeklyBudget || 0)
        let bestStreak = 0
        if ((habitRows as unknown[]).length) {
          const logRows = await sql`
            SELECT habit_id AS "habitId", date FROM hire_habit_logs
            WHERE user_id = ${user.id} AND date >= ${shiftDateStr(todayLocal, -180)}
          `
          const byHabit = new Map<string, Set<string>>()
          for (const lr of logRows as Array<{ habitId: string; date: string }>) {
            if (!byHabit.has(lr.habitId)) byHabit.set(lr.habitId, new Set())
            byHabit.get(lr.habitId)!.add(String(lr.date).slice(0, 10))
          }
          for (const dates of byHabit.values()) {
            let cursor = dates.has(todayLocal) ? todayLocal : shiftDateStr(todayLocal, -1)
            let streak = 0
            while (dates.has(cursor)) {
              streak++
              cursor = shiftDateStr(cursor, -1)
            }
            bestStreak = Math.max(bestStreak, streak)
          }
        }
        return { liftsThisWeek, spendWeek, budget, bestStreak }
      } catch {
        return null
      }
    })(),
  ])

  const reminders = (reminderRows as { id: string; text: string; scheduledAt: Date }[])
    .filter((r) => !/^\[(judge|poke)\]/i.test(r.text) && !/daily brief|morning brief|evening brief/i.test(r.text))
    .map((r) => ({
      id: r.id,
      time: formatCalTime(new Date(r.scheduledAt).toISOString(), tz),
      text: r.text.replace(/^\[digest\]/i, '').trim() || r.text,
    }))

  const loops = (loopRows as { title: string; dueAt: Date | null }[]).map((r) => {
    const due = r.dueAt ? formatCalTime(new Date(r.dueAt).toISOString(), tz) : ''
    return due ? `${r.title} · ${due}` : r.title
  })

  const lastNight = (lastNightRow as { bedtime?: string; wake?: string; quality?: number }[])[0]
  const lastNightLogged = !!(lastNight?.bedtime && lastNight?.wake)
  const lastNightHours = lastNightLogged
    ? sleepHoursBetween(lastNight!.bedtime!, lastNight!.wake!)
    : 0

  // Fact strip: closed facts from the user's own logs, one source of truth per
  // fact. A gap never appears here and in the DO card at the same time.
  const factLine: Array<{ key: string; text: string; state: 'ok' | 'gap'; openKind?: string }> = []
  if (lastNightLogged) {
    const h = Math.floor(lastNightHours)
    const m = Math.round((lastNightHours - h) * 60)
    const q = lastNight!.quality && lastNight!.quality !== 3 ? `, quality ${lastNight!.quality}` : ''
    factLine.push({
      key: 'sleep',
      state: 'ok',
      text: `You slept ${h}${m ? `h ${m}m${q}` : 'h'}${m ? '' : q}`,
      openKind: 'sleep_tracker',
    })
  }
  if (factExtras) {
    if (factExtras.liftsThisWeek > 0) {
      factLine.push({ key: 'lifts', state: 'ok', text: `${factExtras.liftsThisWeek} lift${factExtras.liftsThisWeek === 1 ? '' : 's'} this week`, openKind: 'workout_log' })
    }
    if (factExtras.spendWeek > 0) {
      factLine.push(
        factExtras.budget > 0
          ? { key: 'spend', state: factExtras.spendWeek > factExtras.budget ? 'gap' : 'ok', text: `$${Math.round(factExtras.spendWeek)} of $${factExtras.budget} spent`, openKind: 'spending_snapshot' }
          : { key: 'spend', state: 'ok', text: `$${Math.round(factExtras.spendWeek)} spent this week`, openKind: 'spending_snapshot' },
      )
    }
    if (factExtras.bestStreak >= 2) {
      factLine.push({ key: 'habits', state: 'ok', text: `${factExtras.bestStreak} day habit best`, openKind: 'habit_streak' })
    }
  }

  const nextBeat = beats[0]
  // A morning with no sleep logged leads with the ask, never a fake number or
  // a weather report that pretends last night never happened.
  const lead = nextBeat
    ? `${nextBeat.name} at ${nextBeat.time}`
    : calToday.calendarStatus === 'auth_expired'
      ? 'Calendar authorization expired. Reconnect in Settings.'
      : !lastNightLogged && hour < 14
        ? "I didn't see your sleep last night. How many hours did you get?"
        : lastNightLogged
          ? `Last night ${Math.round(lastNightHours * 10) / 10}h`
          : calToday.calendarStatus === 'timeout'
            ? 'Calendar check timed out.'
            : calToday.calendarFailed
              ? 'Could not check your calendar just now'
              : calToday.calendarConnected
                ? 'A quiet day so far'
                : 'Connect Calendar in Settings'
  const leadReason = (reasons: string[]): string => {
    if (reasons.includes('waiting_on_you')) return 'They are waiting on you.'
    if (reasons.includes('deadline')) return 'There is a deadline on this.'
    if (reasons.includes('vip_sender')) return 'You usually reply to them.'
    return 'This rose to the top of your mail.'
  }
  // One card, strict priority: an unlogged night before the day starts, then a
  // hot mail, then prep for the next commitment, then a quiet today.
  const storyDo = !lastNightLogged && hour < 14
    ? {
        kicker: 'Last night',
        title: 'Log last night',
        hint: 'Bed and wake. Then the day can start.',
        cta: 'Log sleep',
        openKind: 'sleep_tracker',
        kind: 'sleep_log',
      }
    : needsYou[0]
      ? {
          kicker: 'Needs you',
          title: needsYou[0].label,
          hint: leadReason(needsYou[0].reasons),
          cta: 'Open mail',
          openKind: 'digest',
          kind: 'mail',
        }
      : nextBeat
        ? {
            kicker: 'Next',
            title: `${nextBeat.time}  ${nextBeat.name}`,
            hint: 'Show up ready.',
            cta: 'Prep me',
            openKind: 'digest',
            kind: 'prep',
            prepName: nextBeat.name,
          }
        : {
            kicker: 'Today',
            title: 'Nothing is on fire',
            hint: 'Text Alpha if you need a prep or a ping.',
            cta: 'Home',
            openKind: 'apps',
            kind: 'quiet',
          }

  /* ---- The work pull: the thread replacing Slack/Linear/ChatGPT ----
   * Both work personas get their own slice in the morning text — Linear and PRs
   * and drafts for coworker, pipeline and decisions and runway for cofounder —
   * so the brief is the reason you never open those tools. */
  let workSections: Array<{ title: string; lines: string[] }> = []
  let workData: Record<string, unknown> | null = null
  if (persona === 'coworker' || persona === 'cofounder') {
    const [linear, drafts, pipe, decAgg, runway, prs] = await Promise.all([
      persona === 'coworker'
        ? listLinearIssues(user.id).then((r) => r.issues || []).catch(() => [])
        : Promise.resolve([] as Array<{ identifier: string; title: string; state?: string }>),
      sql`SELECT count(*)::int AS n FROM hire_drafts WHERE user_id = ${user.id} AND status = 'pending'`,
      persona === 'cofounder'
        ? sql`SELECT stage, coalesce(value, 0)::real AS value FROM hire_pipeline
              WHERE user_id = ${user.id} AND stage NOT IN ('won', 'lost')`
        : Promise.resolve([] as Array<{ stage: string; value: number }>),
      persona === 'cofounder'
        ? sql`SELECT count(*) FILTER (WHERE outcome IS NULL)::int AS open,
                     max(created_at) AS oldest
              FROM hire_decisions WHERE user_id = ${user.id}`
        : Promise.resolve([{ open: 0, oldest: null }]),
      persona === 'cofounder'
        ? sql`SELECT cash, burn, months FROM hire_runway_snapshots
              WHERE user_id = ${user.id} ORDER BY taken_on DESC LIMIT 1`
        : Promise.resolve([] as Array<{ cash: number; burn: number; months: number }>),
      persona === 'coworker'
        ? (async () => {
            try {
              const raw = await composioFirst(user.id, ['GITHUB_LIST_PULL_REQUESTS'], { state: 'open' })
              return raw ? digestLines(raw).slice(0, 4) : []
            } catch {
              return []
            }
          })()
        : Promise.resolve([] as string[]),
    ])
    const draftsN = Number((drafts[0] as { n?: number })?.n || 0)
    const pipeRows = pipe as Array<{ stage: string; value: number }>
    const dec = (decAgg[0] as { open?: number; oldest?: Date | null }) || {}
    const run = (runway[0] as { cash?: number; burn?: number; months?: number }) || null
    const oldestDays = dec.oldest ? Math.floor((Date.now() - new Date(dec.oldest).getTime()) / 86400000) : 0
    workSections = workPullSections({
      persona,
      linear: linear as Array<{ identifier: string; title: string; state?: string }>,
      prs: prs as string[],
      draftsCount: persona === 'coworker' ? draftsN : undefined,
      pipeline: persona === 'cofounder' ? pipeRows : undefined,
      decisionsOpen: persona === 'cofounder' ? Number(dec.open) || 0 : undefined,
      oldestDecisionDays: oldestDays || undefined,
      runway: run
        ? { cash: Number(run.cash) || 0, burn: Number(run.burn) || 0, months: Number(run.months) || 0 }
        : null,
    })
    workData = {
      sections: workSections,
      linear: (linear as unknown[]).length,
      drafts: draftsN,
      pipeline: pipeRows.length,
      pipelineValue: pipeRows.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0),
      decisions: Number(dec.open) || 0,
      months: run ? Number(run.months) || 0 : 0,
    }
  }

  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.join('\n')}` : null

  const text = [
    `${PERSONA_LABEL[persona]} · ${wrapTitle} · ${dateLabel}`,
    lead,
    section('The day', todayCal),
    section('Tomorrow', tomorrowCal),
    ...workSections.map((s) => section(s.title, s.lines)),
    /* A mailbox that did not answer says so, in the section it belongs to:
     * previously the brief had no Mail section at all and the user could not
     * tell a quiet inbox from a broken read. */
    mailReadFailed && !finalEmails.length
      ? section('Mail', [mailTallyLine || "Couldn't read your inbox just now. The rest of this brief is unaffected."])
      : section('Mail', mailTallyLine ? [mailTallyLine, ...finalEmails] : finalEmails),
    section('Do not forget', reminders.map((r) => `${r.time} · ${r.text}`)),
    section('Promises', loops),
  ]
    .filter(Boolean)
    .join('\n\n')

  const rawPreview = formatBriefPreview({ calendar: todayCal, emails: finalEmails, tomorrow: tomorrowCal, lead })
  const preview = weather?.summary ? `${weather.summary}\n${rawPreview}`.trim() : rawPreview

  return {
    date: dateLabel,
    generatedAt: Date.now(),
    calendar: todayCal,
    meetings,
    attention,
    emails: finalEmails,
    emailItems: finalEmailItems,
    mailGroups,
    mailTally: mailTallyLine,
    needsYou,
    factLine,
    reminders,
    loops,
    tomorrow: tomorrowCal,
    events,
    work: workData,
    text,
    preview,
    brief,
    weather: weather || undefined,
    // Ground truth for the bot's outbound text: the brief already knows whether
    // last night was logged, so the morning message can ask for sleep instead
    // of ever claiming hours that are not there.
    lastNight: {
      logged: lastNightLogged,
      hours: Math.round(lastNightHours * 10) / 10,
      bedtime: lastNight?.bedtime ?? null,
      wake: lastNight?.wake ?? null,
    },
    story: {
      kicker: brief === 'evening' ? 'Evening' : 'Morning',
      date: dateLabel,
      lead,
      do: storyDo,
      beats,
      asks: finalEmailItems,
      mailGroups,
      mailTally: mailTallyLine,
      needsYou,
      factLine,
      due: [],
      later: tomorrowCal.slice(0, 2),
      calendarConnected: calToday.calendarConnected,
      /* Three states reach the card, not two: connected-and-quiet,
       * not-connected, and the read that did not answer. */
      calendarFailed: !!calToday.calendarFailed,
      calendarStatus: calToday.calendarStatus || (calToday.calendarFailed ? 'provider_error' : calToday.calendarConnected ? 'ok' : 'not_connected'),
      /* Gmail was down rather than empty: the mail section says so instead of
       * quietly not existing. */
      mailFailed: mailReadFailed,
      mailStatus: mail.mailStatus !== 'ok' && !finalEmails.length ? mail.mailStatus : (mailReadFailed ? 'provider_error' : 'ok'),
      weather: weather || undefined,
    },
  }
}



function parseStandupClock(raw: string | undefined): { hour: number; minute: number } {
  const m = (raw || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return { hour: 9, minute: 30 }
  let h = Number(m[1])
  const min = Number(m[2] || '0')
  const ap = (m[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (!ap && h < 7) h += 12
  return { hour: h, minute: min }
}

export const POKE_MARKER = '[poke]'
export const JUDGE_MARKER = '[judge]'

async function ensureJudgeTick(
  sql: SQL,
  userId: string,
  persona: Persona,
  text: string,
  scheduledAt: string,
  recurrence: 'daily' | 'weekly',
  timezone: string,
) {
  const existing = await sql`
    SELECT id FROM hire_reminders
    WHERE user_id = ${userId} AND persona = ${persona} AND text = ${text}
      AND (status = 'pending' OR recurrence = ${recurrence})
    LIMIT 1
  `
  if (existing[0]) return
  await sql`
    INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${text}, ${scheduledAt}, ${recurrence}, ${timezone}, 'pending')
  `
}

/** Heartbeats that wake the judgment loop. Canned poke copy is not sent. */
async function armPokes(
  sql: SQL,
  user: { id: string; timezone: string | null; phone?: string | null },
  persona: Persona,
  context: Record<string, string>,
) {
  const tz = context.timezone || user.timezone || 'America/Los_Angeles'

  // Renewal radar (A7): once a day, scan live mail for recurring charges and
  // turn anything renewing within 3 days into a reminder that shows up in the
  // morning brief's Do-not-forget list. Marker in context keeps it to one scan.
  const today = localDateStrInTz(new Date(), tz)
  if ((context.renewal_scan_day || '') !== today) {
    void (async () => {
      try {
        await sql`
          UPDATE hire_context
          SET fields = fields || ${JSON.stringify({ renewal_scan_day: today })}::jsonb, updated_at = now()
          WHERE user_id = ${user.id} AND persona = ${persona}
        `
        const live = await livePayload(sql, user.phone || '', persona)
        if (!live.found || !live.hired || !live.userId) return
        const bundle = await buildPrepBundle(
          sql,
          { id: live.userId, name: live.name, timezone: tz },
          'recurring charges subscription renewal',
        )
        const hits = scanSubscriptions(bundle?.text || '')
        const dueSoon = hits.filter((h) => {
          if (!h.date) return false
          const days = Math.ceil((new Date(h.date).getTime() - Date.now()) / 86_400_000)
          return days >= 0 && days <= 3
        })
        await sql`
          DELETE FROM hire_reminders
          WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending' AND text LIKE '[renewal]%'
        `
        // First renewal text ever carries the naming teach (P4): what this is
        // and that it scans daily. Gated by the nudge log so it shows once.
        let renewalTeach = ''
        const teachInsert = await sql`
          INSERT INTO hire_nudge_log (id, user_id, persona, nudge_key)
          VALUES (${crypto.randomUUID()}, ${user.id}, ${persona}, 'teach:renewal_radar')
          ON CONFLICT (user_id, nudge_key) DO NOTHING
          RETURNING id
        `
        if (teachInsert.length) renewalTeach = ' (This is your renewal radar: I scan your mail daily and flag charges before they hit.)'
        for (const h of dueSoon) {
          const amount = h.amount ? ` — $${h.amount}` : ''
          await sql`
            INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
            VALUES (${crypto.randomUUID()}, ${user.id}, ${persona},
              ${(`[renewal] ${h.merchant} renews ${h.date}${amount}${renewalTeach}`).slice(0, 200)},
              ${nextLocalTimeUtc(tz, 8, 0)}, 'once', ${tz}, 'pending')
          `
        }
        if (dueSoon.length) console.log(`[renewals] ${persona}: ${dueSoon.length} due within 3 days`)
      } catch (err) {
        console.warn('[renewals] scan failed', err)
      }
    })()
  }
  if (persona === 'friend') {
    const digest = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND status IN ('pending', 'paused')
      LIMIT 1
    `
    if (!digest[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}afternoon`, nextLocalTimeUtc(tz, 17, 0), 'daily', tz)
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}evening`, nextLocalTimeUtc(tz, 21, 0), 'daily', tz)
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}weekly`, nextWeekdayLocalUtc(tz, 5, 21, 0), 'weekly', tz)
  } else if (persona === 'coworker') {
    // The work personas get the same 8 AM morning digest friend does — the one
    // that now carries their Linear/PR/draft or pipeline/decision/runway pull.
    const morning = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND status IN ('pending', 'paused')
      LIMIT 1
    `
    if (!morning[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    const clock = parseStandupClock(context.standup_time)
    let minute = clock.minute - 12
    let hour = clock.hour
    if (minute < 0) {
      minute += 60
      hour = (hour + 23) % 24
    }
    await ensureJudgeTick(
      sql,
      user.id,
      persona,
      `${JUDGE_MARKER}standup`,
      nextLocalTimeUtc(tz, hour, minute),
      'daily',
      tz,
    )
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}weekly`, nextWeekdayLocalUtc(tz, 5, 21, 0), 'weekly', tz)
  } else {
    // Cofounder keeps its own 8 AM pull too.
    const morning = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND status IN ('pending', 'paused')
      LIMIT 1
    `
    if (!morning[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    await ensureJudgeTick(
      sql,
      user.id,
      persona,
      `${JUDGE_MARKER}weekly`,
      nextWeekdayLocalUtc(tz, 5, 21, 0),
      'weekly',
      tz,
    )
  }
  await sql`
    DELETE FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND text LIKE ${POKE_MARKER + '%'}
  `
  // Heal: a daily digest row (a chosen brief time) supersedes the default
  // [judge]morning tick. Both being armed now that briefs send unconditionally
  // would fire two morning briefs, so a stale judge morning is dropped whenever
  // the digest exists.
  await sql`
    DELETE FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
      AND EXISTS (
        SELECT 1 FROM hire_reminders d
        WHERE d.user_id = hire_reminders.user_id AND d.persona = hire_reminders.persona
          AND d.text LIKE '[digest]%' AND d.status IN ('pending', 'paused')
      )
  `
  if (!context.proactive) {
    await upsertContext(sql, user.id, persona, {
      proactive: context.proactive || 'on',
    })
  }
}

/** The digest reminder row that fires the daily brief. Every persona seeds the
 * same marker; the reminder text after the marker only names it. */
const DIGEST_BRIEF_TEXT = '[digest]Daily brief'

/** Arm-if-missing backstop for the morning brief: a phone user who has ever set
 * a brief time or finished onboarding expects a daily brief, so if the DB was
 * wiped or they re-signed without the wizard, an inbound or roster change
 * re-arms the default 8am digest reminder. Idempotent: no-op when a digest
 * reminder already exists (a chosen brief time is never overridden) or when a
 * daily [judge]morning tick already carries the brief (the armPokes default),
 * so the person can never receive two briefs at the same hour. */
async function armMorningBrief(sql: SQL, user: { id: string; timezone: string | null }, persona: Persona) {
  try {
    const existing = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND (text LIKE '[digest]%'
             OR text = ${JUDGE_MARKER + 'morning'})
        AND status IN ('pending', 'paused')
      LIMIT 1
    `
    if (existing[0]) return
    const tz = user.timezone || 'America/Los_Angeles'
    await sql`
      INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${persona}, ${DIGEST_BRIEF_TEXT},
        ${nextLocalTimeUtc(tz, 8, 0)}, 'daily', ${tz}, 'pending')
    `
    console.log(`[brief] ${persona} ${user.id}: re-armed default 8am digest`)
  } catch (err) {
    // A backstop must never fail the inbound that triggered it.
    console.warn(`[brief] ${persona} arm morning failed`, err)
  }
}


async function claimNudge(sql: SQL, userId: string, persona: Persona, key: string) {
  const id = crypto.randomUUID()
  const rows = await sql`
    INSERT INTO hire_nudge_log (id, user_id, persona, nudge_key)
    VALUES (${id}, ${userId}, ${persona}, ${key})
    ON CONFLICT (user_id, nudge_key) DO NOTHING
    RETURNING id
  `
  return !!rows[0]
}

/* ---- Trigger-based nudges: Slack mentions + Linear assignments ----
 * The collector polls, so a "trigger" here means: scan on every poll cycle,
 * throttle per user, and only fire on items strictly newer than the last
 * scan. Scans cost two Composio calls per user per 10 minutes; the mention
 * key (channel+ts / issue id) makes dedupe honest even across restarts. */

const TRIGGER_SCAN_THROTTLE_MS = 10 * 60_000
const triggerScanMemory = createBoundedMap<string, number>({ maxEntries: 2000, ttlMs: 24 * 60 * 60_000 })

export function pruneBriefCaches(): void {
  todayMeetsCache.prune()
  homeWorldCache.prune()
  digestCache.prune()
  eveningCache.prune()
  triggerScanMemory.prune()
}

async function scanSlackMentions(userId: string, displayName: string): Promise<Array<{ channel: string; ts: string; text: string; permalink?: string }>> {
  // Slack search indexes rendered mentions, so the user's display name is the
  // honest v1 query until we store their Slack member ID on connect.
  const query = displayName.trim()
  if (!query) return []
  const data = await composioExecuteData(userId, 'SLACK_SEARCH_MESSAGES', {
    query,
    limit: 10,
    verbose: false,
  })
  const messages = Array.isArray(data) ? data : []
  const out: Array<{ channel: string; ts: string; text: string; permalink?: string }> = []
  for (const raw of messages) {
    const o = (raw || {}) as Record<string, unknown>
    const ts = String(o.ts || '')
    const text = String(o.text || o.text_original || '').trim()
    const channel = String(
      (typeof o.channel === 'object' && o.channel ? (o.channel as { name?: string; id?: string }).name || (o.channel as { id?: string }).id : o.channel) || '',
    )
    if (!ts || !text) continue
    out.push({
      channel,
      ts,
      text,
      permalink: typeof o.permalink === 'string' ? o.permalink : undefined,
    })
  }
  return out
}

async function scanLinearAssigned(userId: string): Promise<Array<{ id: string; identifier: string; title: string; state?: string }>> {
  for (const slug of ['LINEAR_LIST_ISSUES', 'LINEAR_LIST_LINEAR_ISSUES', 'LINEAR_GET_ISSUES']) {
    const data = await composioExecuteData(userId, slug, { limit: 12 })
    if (!data) continue
    const all = walkLinearIssues(data)
    const issues = all
      .filter((i) => {
        const s = (i.state || '').toLowerCase()
        return s !== 'done' && s !== 'canceled' && s !== 'completed'
      })
      .slice(0, 12)
    if (issues.length) return issues
    // Data came back but empty: that is a real "nothing assigned", stop.
    if (!all.length) return []
  }
  return []
}

async function scanImportantEmail(
  sql: SQL,
  userId: string,
): Promise<Array<{ id: string; from: string; subject: string }>> {
  try {
    const access = await googleAccessToken(sql, userId, 'gmail')
    if (!access) return []
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    listUrl.searchParams.set('maxResults', '3')
    listUrl.searchParams.set('q', 'is:unread (is:important OR priority:high)')
    const list = await fetchPublic(listUrl, { headers: { Authorization: `Bearer ${access}` } }, 3500)
    if (!list.ok) return []
    const data = (await list.json()) as { messages?: Array<{ id: string }> }
    const ids = (data.messages || []).slice(0, 3)
    const out: Array<{ id: string; from: string; subject: string }> = []
    await Promise.all(
      ids.map(async (m) => {
        try {
          const got = await fetchPublic(
            new URL(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            ),
            { headers: { Authorization: `Bearer ${access}` } },
            3000,
          )
          if (!got.ok) return
          const msg = (await got.json()) as {
            snippet?: string
            payload?: { headers?: Array<{ name: string; value: string }> }
          }
          const headers = msg.payload?.headers || []
          const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
          const from = emailFromFromHeader(h('From')) || h('From') || 'Someone'
          const subject = h('Subject') || '(no subject)'
          out.push({ id: m.id, from, subject })
        } catch {}
      }),
    )
    return out
  } catch (err) {
    console.warn('[triggers] scanNewEmails failed', { error: (err as any)?.message })
    return []
  }
}

async function scanNewCalendarEvents(
  sql: SQL,
  userId: string,
  tz: string,
): Promise<Array<{ id: string; title: string; formattedStart: string }>> {
  try {
    const access = await googleAccessToken(sql, userId, 'calendar')
    if (!access) return []
    const now = new Date()
    const future = new Date(now.getTime() + 7 * 86_400_000)
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('timeMin', now.toISOString())
    url.searchParams.set('timeMax', future.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'updated')
    url.searchParams.set('maxResults', '5')
    const res = await fetchPublic(url, { headers: { Authorization: `Bearer ${access}` } }, 3500)
    if (!res.ok) return []
    const data = (await res.json()) as {
      items?: Array<{
        id?: string
        summary?: string
        created?: string
        updated?: string
        start?: { dateTime?: string; date?: string }
      }>
    }
    const out: Array<{ id: string; title: string; formattedStart: string }> = []
    for (const it of data.items || []) {
      if (!it.id || !it.summary) continue
      const created = it.created ? new Date(it.created).getTime() : 0
      if (Date.now() - created > 60 * 60_000) continue
      const startIso = it.start?.dateTime || it.start?.date
      let formattedStart = 'soon'
      if (startIso) {
        try {
          formattedStart = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(startIso))
        } catch {}
      }
      out.push({ id: it.id, title: it.summary.trim(), formattedStart })
    }
    return out
  } catch (err) {
    console.warn('[triggers] scanNewCalendarEvents failed', { error: (err as any)?.message })
    return []
  }
}

async function collectTriggerNudges(
  sql: SQL,
  user: { id: string; phone: string | null; timezone?: string | null; name?: string | null },
  persona: Persona,
  sentKeys: Set<string>,
  candidates: Array<Omit<EventNudge, 'phone'> & { order: number }>,
) {
  if (!user.phone) return
  // Throttle: one Composio scan per user per throttle window, friend only —
  // Slack/Linear pings belong to the personal assistant, not the work hires
  // (coworker already surfaces Linear in its own loop).
  if (persona !== 'friend') return
  const now = Date.now()
  const last = triggerScanMemory.get(user.id) || 0
  if (now - last < TRIGGER_SCAN_THROTTLE_MS) return
  triggerScanMemory.set(user.id, now)
  try {
    const connected = await composioConnected(user.id)
    const wantsSlack = connected.includes('slack')
    const wantsLinear = connected.includes('linear')
    const [mentions, issues, urgentEmails, newCals] = await Promise.all([
      wantsSlack ? scanSlackMentions(user.id, user.name || '') : Promise.resolve([]),
      wantsLinear ? scanLinearAssigned(user.id) : Promise.resolve([]),
      scanImportantEmail(sql, user.id),
      scanNewCalendarEvents(sql, user.id, user.timezone || 'America/Los_Angeles'),
    ])
    for (const m of mentions) {
      const key = `slackmention:${m.channel}:${m.ts}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 0,
        topic: 'slack_mention',
        key,
        urgent: true,
        text: stripNudgeDashes(slackMentionText(m)),
      })
    }
    for (const i of issues) {
      const key = `linearassign:${i.id}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 0,
        topic: 'linear_assigned',
        key,
        urgent: false,
        text: stripNudgeDashes(linearAssignedText(i)),
      })
    }
    for (const em of urgentEmails) {
      const key = `mail_urgent:${em.id}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 0,
        topic: 'email_urgent',
        key,
        urgent: true,
        text: stripNudgeDashes(`Important email from ${em.from}: ${em.subject}`),
      })
    }
    for (const ev of newCals) {
      const key = `cal_new:${ev.id}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 0,
        topic: 'calendar_new',
        key,
        urgent: true,
        text: stripNudgeDashes(`New calendar event: ${ev.title} on ${ev.formattedStart}`),
      })
    }
  } catch (err) {
    console.warn('[nudge] trigger scan failed', err)
  }
}

async function collectEventNudgesForUser(
  sql: SQL,
  user: { id: string; phone: string | null; timezone: string | null; name?: string | null },
  persona: Persona,
): Promise<EventNudge | null> {
  if (!user.phone) return null
  const tz = user.timezone || 'America/Los_Angeles'
  const context = await loadContext(sql, user.id, persona)
  const inbound = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const lastInboundAt = (inbound[0] as { lastInboundAt?: Date | null } | undefined)?.lastInboundAt || null
  const { weekday, today } = localClock(tz)
  const sent = await sql`
    SELECT nudge_key AS "nudgeKey" FROM hire_nudge_log
    WHERE user_id = ${user.id} AND sent_at > now() - interval '14 days'
  `
  const sentKeys = new Set((sent as Array<{ nudgeKey: string }>).map((r) => r.nudgeKey))
  const candidates: Array<Omit<EventNudge, 'phone'> & { order: number }> = []
  const roster = await loadRoster(sql, user.id)
  const meetingOwner: Persona | null = roster.includes('coworker')
    ? 'coworker'
    : roster.includes('cofounder')
      ? 'cofounder'
      : null

  const now = Date.now()
  const meetFrom = new Date(now + 15 * 60_000)
  const meetTo = new Date(now + 45 * 60_000)

  const meetings = meetingOwner === persona
    ? await sql`
    SELECT id, title, starts_at AS "startsAt", phase, briefing
    FROM hire_meetings
    WHERE user_id = ${user.id}
      AND starts_at >= ${meetFrom.toISOString()}
      AND starts_at <= ${meetTo.toISOString()}
      AND phase <> 'done'
    ORDER BY starts_at ASC
    LIMIT 4
  `
    : []
  for (const m of meetings as Array<{ id: string; title: string; startsAt: Date; phase: string; briefing: string | null }>) {
    const briefing = String(m.briefing || '').trim()
    if (briefing) continue
    const key = `meeting:${m.id}`
    if (sentKeys.has(key)) continue
    const mins = Math.max(1, Math.round((new Date(m.startsAt).getTime() - now) / 60_000))
    candidates.push({
      order: 0,
      topic: 'meeting_soon',
      key,
      urgent: true,
      text: stripNudgeDashes(meetingNudgeText(m.title, mins)),
    })
  }

  if (meetingOwner === persona) {
    try {
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const got = await fetchCalendarItems(access, { timeMin: meetFrom, timeMax: meetTo, maxResults: 6 })
        const events = got.ok ? got.items : []
        const prepped = new Set(
          (meetings as Array<{ title: string; briefing: string | null }>).map((m) => m.title.trim().toLowerCase()),
        )
        for (const ev of events) {
          if (prepped.has(ev.title.trim().toLowerCase())) continue
          const key = `cal:${ev.start.toISOString().slice(0, 16)}:${slugNudge(ev.title)}`
          if (sentKeys.has(key)) continue
          const mins = Math.max(1, Math.round((ev.start.getTime() - now) / 60_000))
          candidates.push({
            order: 0,
            topic: 'meeting_soon',
            key,
            urgent: true,
            text: stripNudgeDashes(meetingNudgeText(ev.title, mins)),
          })
        }
      }
    } catch (err) {
      console.warn('[nudge] calendar scan failed', err)
    }
  }

  if (persona === 'friend') {
    try {
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const got = await fetchCalendarItems(access, { timeMin: meetFrom, timeMax: meetTo, maxResults: 6 })
        const events = got.ok ? got.items.filter((e) => !e.allDay && !isHotelStayEvent(e)) : []
        for (const ev of events) {
          const key = `cal:${ev.start.toISOString().slice(0, 16)}:${slugNudge(ev.title)}`
          if (sentKeys.has(key)) continue
          const mins = Math.max(1, Math.round((ev.start.getTime() - now) / 60_000))
          const who = meetingWho(ev.title)
          const prep = await withTimeout(
            buildPrepBundle(sql, { id: user.id, name: user.name, timezone: tz }, who),
            7000,
            null,
          )
          const body = prep?.text
            ? `Meeting with ${who} in ${mins} mins.\n${prep.text}`
            : `Meeting with ${who} in ${mins} mins.`
          candidates.push({
            order: 0,
            topic: 'meeting_soon',
            key,
            urgent: true,
            text: stripNudgeDashes(body).slice(0, 500),
          })
        }
      }
    } catch (err) {
      console.warn('[nudge] friend calendar scan failed', err)
    }
  }

  // Debrief check: scan recent calendar events that ended 10-45 minutes ago
  if (meetingOwner === persona || persona === 'friend') {
    try {
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const pastFrom = new Date(now - 45 * 60_000)
        const pastTo = new Date(now - 10 * 60_000)
        const got = await fetchCalendarItems(access, { timeMin: pastFrom, timeMax: pastTo, maxResults: 4 })
        const events = got.ok ? got.items.filter((e) => !e.allDay && !isHotelStayEvent(e)) : []
        for (const ev of events) {
          const key = `debrief:${ev.start.toISOString().slice(0, 16)}:${slugNudge(ev.title)}`
          if (sentKeys.has(key)) continue
          const isGenZ = isGenZUser(context)
          const who = meetingWho(ev.title)
          const target = who ? `with ${who}` : `on ${ev.title}`
          const text = isGenZ
            ? (who ? `Wrapped with ${who}, we survived. Any next steps before the brain wipes?` : `Wrapped ${ev.title}. Want to jot down takeaways before they vanish?`)
            : `Just wrapped ${target}. Want to capture any next steps or follow-ups while it's fresh?`
          candidates.push({
            order: 1,
            topic: 'meeting_debrief',
            key,
            urgent: false,
            text: stripNudgeDashes(text),
          })
        }
      }
    } catch (err) {
      console.warn('[nudge] post-meeting debrief scan failed', err)
    }
  }

  const loops = await sql`
    SELECT id, title, due_at AS "dueAt", persona FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'open' AND due_at IS NOT NULL
    ORDER BY due_at ASC LIMIT 12
  `
  for (const loop of loops as Array<{ id: string; title: string; dueAt: Date; persona: string }>) {
    const owner = isPersona(loop.persona) ? loop.persona : roster.includes('friend') ? 'friend' : persona
    if (owner !== persona) continue
    const dueDay = localDateStrInTz(new Date(loop.dueAt), tz)
    if (dueDay !== today) continue
    if (new Date(loop.dueAt).getTime() > now + 5 * 60_000) continue
    const key = `loop:${loop.id}:${today}`
    if (sentKeys.has(key)) continue
    candidates.push({
      order: 1,
      topic: 'loop_due',
      key,
      urgent: false,
      text: stripNudgeDashes(loopNudgeText(loop.title, weekday)),
    })
  }

  if (persona === 'cofounder') {
    const decisions = await sql`
      SELECT id, decision, review_at AS "reviewAt" FROM hire_decisions
      WHERE user_id = ${user.id} AND status = 'open' AND review_at IS NOT NULL AND review_at <= now()
        AND (persona = ${persona} OR persona = '')
      ORDER BY review_at ASC LIMIT 8
    `
    for (const d of decisions as Array<{ id: string; decision: string; reviewAt: Date }>) {
      const key = `decision:${d.id}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 2,
        topic: 'decision_review',
        key,
        urgent: false,
        text: stripNudgeDashes(decisionNudgeText(d.decision)),
      })
    }
  }

  // Lifestyle check-ins (meals & workout): only when not in a meeting
  let isBusyNow = false
  try {
    const access = await googleAccessToken(sql, user.id, 'calendar')
    if (access) {
      const nowMinus1 = new Date(now - 60_000)
      const nowPlus1 = new Date(now + 60_000)
      const cur = await fetchCalendarItems(access, { timeMin: nowMinus1, timeMax: nowPlus1, maxResults: 4 })
      if (cur.ok) {
        for (const it of cur.items) {
          if (!it.allDay && it.start.getTime() <= now && (it.end ? it.end.getTime() >= now : it.start.getTime() + 30 * 60_000 >= now)) {
            isBusyNow = true
            break
          }
        }
      }
    }
  } catch (err) {
    console.warn('[nudges] calendar check failed', { error: (err as any)?.message })
  }
  if (!isBusyNow) {
    try {
      const busyMeeting = await sql`
        SELECT id FROM hire_meetings
        WHERE user_id = ${user.id}
          AND starts_at <= now()
          AND COALESCE(ends_at, starts_at + interval '60 minutes') >= now()
          AND phase <> 'done'
        LIMIT 1
      `
      if (busyMeeting.length > 0) {
        isBusyNow = true
      }
    } catch {}
  }

  const isLifestyleOwner =
    persona === 'friend' ||
    (!roster.includes('friend') && (roster[0] === persona || persona === 'coworker'))
  if (isLifestyleOwner && !isBusyNow) {
    const isGenZ = isGenZUser(context)
    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(new Date())
    const localHour = Number(timeParts.find((p) => p.type === 'hour')?.value ?? 0)
    const localMinute = Number(timeParts.find((p) => p.type === 'minute')?.value ?? 0)
    const minsOfDay = localHour * 60 + localMinute
    const todayWin = todayWindowUtc(tz)

    // Breakfast: 9:00 AM - 11:00 AM
    if (minsOfDay >= 540 && minsOfDay <= 660) {
      const key = `meal:breakfast:${today}`
      if (!sentKeys.has(key)) {
        const logged = await sql`
          SELECT count(*)::int AS n FROM hire_nutrition_logs
          WHERE user_id = ${user.id} AND eaten_at >= ${todayWin.start.toISOString()} AND eaten_at < ${todayWin.end.toISOString()}
        `
        if (Number(logged[0]?.n || 0) === 0) {
          const text = isGenZ
            ? "gm bestie did we eat breakfast yet or are we running on iced matcha and vibes? drop the food log"
            : "Good morning! Had breakfast yet or want to log what you're having?"
          candidates.push({
            order: 1,
            topic: 'meal_checkin',
            key,
            urgent: false,
            text: stripNudgeDashes(text),
            cardKind: 'nutrition',
          })
        }
      }
    }

    // Lunch: 12:30 PM - 2:30 PM
    if (minsOfDay >= 750 && minsOfDay <= 870) {
      const key = `meal:lunch:${today}`
      if (!sentKeys.has(key)) {
        const logged = await sql`
          SELECT count(*)::int AS n FROM hire_nutrition_logs
          WHERE user_id = ${user.id} AND eaten_at >= ${new Date(todayWin.start.getTime() + 11 * 3600_000).toISOString()} AND eaten_at < ${todayWin.end.toISOString()}
        `
        if (Number(logged[0]?.n || 0) === 0) {
          const text = isGenZ
            ? "lunchtime bestie. what are we consuming today or is it doordash again? tap to log"
            : "Time for lunch! What are you having today?"
          candidates.push({
            order: 1,
            topic: 'meal_checkin',
            key,
            urgent: false,
            text: stripNudgeDashes(text),
            cardKind: 'nutrition',
          })
        }
      }
    }

    // Workout: 4:30 PM - 7:00 PM
    if (minsOfDay >= 990 && minsOfDay <= 1140) {
      const key = `workout:${today}`
      if (!sentKeys.has(key)) {
        const logged = await sql`
          SELECT count(*)::int AS n FROM hire_workouts
          WHERE user_id = ${user.id} AND logged_at >= ${todayWin.start.toISOString()} AND logged_at < ${todayWin.end.toISOString()}
        `
        if (Number(logged[0]?.n || 0) === 0) {
          const text = isGenZ
            ? "gym time or are we skipping leg day? let's get those gains fr fr"
            : "Ready for your workout today? How are you feeling for a session?"
          candidates.push({
            order: 1,
            topic: 'workout_checkin',
            key,
            urgent: false,
            text: stripNudgeDashes(text),
            cardKind: 'workout_log',
          })
        }
      }
    }

    // Dinner: 7:00 PM - 9:30 PM
    if (minsOfDay >= 1140 && minsOfDay <= 1290) {
      const key = `meal:dinner:${today}`
      if (!sentKeys.has(key)) {
        const logged = await sql`
          SELECT count(*)::int AS n FROM hire_nutrition_logs
          WHERE user_id = ${user.id} AND eaten_at >= ${new Date(todayWin.start.getTime() + 18 * 3600_000).toISOString()} AND eaten_at < ${todayWin.end.toISOString()}
        `
        if (Number(logged[0]?.n || 0) === 0) {
          const text = isGenZ
            ? "dinner check! what's the chef cooking tonight or what did you grub on?"
            : "Good evening! What's on the menu for dinner tonight?"
          candidates.push({
            order: 1,
            topic: 'meal_checkin',
            key,
            urgent: false,
            text: stripNudgeDashes(text),
            cardKind: 'nutrition',
          })
        }
      }
    }
  }

  await collectTriggerNudges(sql, user, persona, sentKeys, candidates)

  candidates.sort((a, b) => a.order - b.order)
  for (const c of candidates) {
    const blocked = outboundNudgeBlock(context, lastInboundAt, tz, c.urgent, c.topic)
    if (blocked) {
      const skipKey = `${user.id}:${c.topic}`
      const now = Date.now()
      if (shouldEmitNudgeSkip(nudgeSkipLogMemo.get(skipKey), blocked, now)) {
        if (nudgeSkipLogMemo.size > 500) nudgeSkipLogMemo.clear()
        nudgeSkipLogMemo.set(skipKey, { reason: blocked, at: now })
        console.log(`[nudge:${persona}] skip ${user.phone} ${c.topic}: ${blocked}`)
      }
      continue
    }
    nudgeSkipLogMemo.delete(`${user.id}:${c.topic}`)
    const claimed = await claimNudge(sql, user.id, persona, c.key)
    if (!claimed) continue
    return { phone: user.phone, topic: c.topic, key: c.key, text: c.text, urgent: c.urgent, cardKind: c.cardKind }
  }
  return null
}

async function dueEventNudges(sql: SQL, persona: Persona): Promise<EventNudge[]> {
  const out: EventNudge[] = []
  // Pushed trigger events first: they are the reason the poller woke up.
  // Claim with SKIP LOCKED so overlapping poll cycles can never double-send.
  const inbox = (await sql`
    SELECT i.id, i.user_id, i.topic, i.key, i.text, i.urgent, u.phone_e164 AS phone, u.timezone,
           c.fields->>'quiet_hours' AS "quietHours"
    FROM hire_event_inbox i
    JOIN hire_users u ON u.id = i.user_id
    LEFT JOIN hire_context c ON c.user_id = i.user_id AND c.persona = i.persona
    WHERE i.persona = ${persona} AND i.status = 'pending' AND u.phone_e164 IS NOT NULL
    ORDER BY i.created_at ASC
    LIMIT 8
    FOR UPDATE OF i SKIP LOCKED
  `) as Array<{ id: string; user_id: string; topic: string; key: string; text: string; urgent: boolean; phone: string; timezone: string | null; quietHours: string | null }>
  for (const row of inbox) {
    // A pushed event used to be claimed and sent at any hour: the webhook
    // comment claimed quiet hours, but nothing implemented them. Rows that
    // arrive at night stay pending here and go out when the window opens;
    // nothing is lost and nothing wakes the user.
    if (inQuietHours(localClock(row.timezone || 'America/Los_Angeles').localTime, row.quietHours)) continue
    await sql`UPDATE hire_event_inbox SET status = 'sent', sent_at = now() WHERE id = ${row.id}`
    out.push({
      phone: row.phone,
      topic: row.topic,
      key: row.key,
      text: row.text,
      urgent: row.urgent,
    })
  }
  const rows = await sql`
    SELECT u.id, u.phone_e164 AS phone, u.timezone, u.name
    FROM hire_roster r
    JOIN hire_users u ON u.id = r.user_id
    WHERE r.persona = ${persona} AND u.phone_e164 IS NOT NULL
    LIMIT 40
  `
  for (const row of rows as Array<{ id: string; phone: string; timezone: string | null; name: string | null }>) {
    try {
      const nudge = await collectEventNudgesForUser(sql, row, persona)
      if (nudge) out.push(nudge)
    } catch (err) {
      console.warn('[nudge] collect failed', err)
    }
  }
  return out
}

const WORKOUT_DAY_NAME: Record<string, string> = {
  Monday: 'Push',
  Tuesday: 'Pull',
  Wednesday: 'Legs',
  Thursday: 'Upper',
  Friday: 'Lower',
}

function workoutTodayLabel(weekday: string, place: 'home' | 'gym'): { name: string; place: string; rest?: boolean } {
  const name = WORKOUT_DAY_NAME[weekday]
  if (!name) return { name: `${weekday} rest`, place: place === 'home' ? 'home bodyweight' : 'gym', rest: true }
  return {
    name: `${weekday} ${name}`,
    place: place === 'home' ? 'home bodyweight' : 'gym',
  }
}

function emailFromFromHeader(from: string): string {
  const angle = from.match(/<([^>]+)>/)
  if (angle?.[1]) return angle[1].trim()
  const bare = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return bare?.[0]?.trim() || ''
}

async function loadWorldCalendar(
  sql: SQL,
  user: { id: string; name?: string | null },
  tz: string,
): Promise<string[]> {
  const now = new Date()
  const eightHours = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const endOfDay = startOfLocalDay(tz, 1)
  const until = endOfDay.getTime() > eightHours.getTime() ? endOfDay : eightHours
  const myName = user.name || null
  const access = await googleAccessToken(sql, user.id, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, { timeMin: now, timeMax: until, maxResults: 16 })
    if (got.ok) return got.items.map((e) => formatDigestEventLabel(e, tz, myName))
  }
  const rows = await googleEventsRaw(sql, user.id, { timeMin: now, timeMax: until, maxResults: 16 })
  return rows.map((e) => {
    const start = e.allDay ? 'All day' : formatClock(new Date(e.start), tz)
    return `${start} · ${e.title}`
  })
}

async function loadWorldMail(sql: SQL, userId: string): Promise<string[]> {
  const rich = await loadGmailRich(sql, userId, importantMailQuery('2d'), JUDGE_MAIL_CAP)
  if (!rich.length) return []
  const kept = await judgeBriefMail(rich, 3)
  return kept.map((m) => `id=${m.id} | ${formatMailLineFromParts(m.from, m.subject)}`)
}

async function gmailReplyMeta(
  sql: SQL,
  userId: string,
  messageId: string,
): Promise<{ to: string; subject: string; threadId: string; inReplyTo: string } | null> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(5000) },
    ).catch(() => null)
    if (res && res.ok) {
      const data = (await res.json()) as {
        threadId?: string
        payload?: { headers?: Array<{ name: string; value: string }> }
      }
      const headers = data.payload?.headers || []
      const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
      const to = emailFromFromHeader(h('From'))
      if (to) {
        const subjectRaw = h('Subject') || 'Re: '
        return {
          to,
          subject: /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`,
          threadId: data.threadId || '',
          inReplyTo: h('Message-ID') || h('Message-Id'),
        }
      }
    }
  }
  /* A mailbox that reads through Composio has no Google token here, and this
   * function used to be Google-only — so every reply draft on such an account
   * failed with "Could not load that mail to reply" while the SAME message
   * opened fine in the reader (which has a Composio fallback). Measured on the
   * founder's account: connectors/status said {"google":false,"composio":true}.
   * The connector can supply the one header a reply needs. */
  const fallback = await composioMailHeaders(userId, messageId)
  const to = fallback?.from ? emailFromFromHeader(fallback.from) : ''
  if (!to) return null
  const subjectRaw = fallback?.subject || 'Re: '
  return {
    to,
    subject: /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`,
    threadId: '',
    inReplyTo: '',
  }
}



async function loadWeekSnapshot(
  sql: SQL,
  userId: string,
  weekStart: string,
  timezone: string,
): Promise<WeekSnap> {
  const weekEnd = shiftDateStr(weekStart, 7)
  /* `::date` would read at the database's session timezone — off by the user's
   * UTC offset, so a Sunday-night log fell into next week. Use real instants. */
  const weekWindow = weekWindowUtc(weekStart, timezone)
  const nutr = await sql`
    SELECT count(*)::int AS meals FROM hire_nutrition_logs
    WHERE user_id = ${userId} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
  `
  const habits = await sql`
    SELECT count(*)::int AS checks FROM hire_habit_logs
    WHERE user_id = ${userId} AND date >= ${weekStart} AND date < ${weekEnd}
  `
  const sleep = await sql`
    SELECT bedtime, wake FROM hire_sleep
    WHERE user_id = ${userId} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEnd}
  `
  const sleepRows = sleep as Array<{ bedtime: string; wake: string }>
  const avgSleepHours = sleepRows.length
    ? Math.round(
        (sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length) * 10,
      ) / 10
    : 0
  const spend = await sql`
    SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
    WHERE user_id = ${userId} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
  `
  const budget = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${userId}`
  const workouts = await sql`
    SELECT count(*)::int AS n FROM hire_workouts
    WHERE user_id = ${userId} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
  `
  const gratitude = await sql`
    SELECT count(*)::int AS n FROM hire_gratitude
    WHERE user_id = ${userId} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
  `
  const duePeople = await sql`
    SELECT count(*)::int AS n FROM hire_network
    WHERE user_id = ${userId}
      AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
  `
  return {
    meals: Number((nutr[0] as { meals?: number })?.meals || 0),
    habitChecks: Number((habits[0] as { checks?: number })?.checks || 0),
    sleepNights: sleepRows.length,
    avgSleepHours,
    workouts: Number((workouts[0] as { n?: number })?.n || 0),
    spend: Number((spend[0] as { total?: number })?.total || 0),
    weeklyBudget: Math.round(Number((budget[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
    followUpsDue: Number((duePeople[0] as { n?: number })?.n || 0),
    gratitude: Number((gratitude[0] as { n?: number })?.n || 0),
  }
}

async function buildWeekBundle(
  sql: SQL,
  user: { id: string; name?: string | null; timezone: string | null },
): Promise<{
  text: string
  wroteReview: boolean
  spendOver: boolean
  ping?: { name: string; email?: string; phone?: string }
}> {
  const weekStart = userMonday(user)
  const snap = await loadWeekSnapshot(sql, user.id, weekStart, user.timezone || 'America/Los_Angeles')
  const wrote = composeWeekReview(snap)
  /* The weekly run is the natural moment to keep the runway honest: capture the
   * latest cash/burn the cofounder context knows about so home and the review
   * have a real number instead of a dash. */
  try {
    const ctx = await loadContext(sql, user.id, 'cofounder')
    const cash = Number(String(ctx.cash || ctx.runway_cash || '').replace(/[^0-9.]/g, ''))
    const burn = Number(String(ctx.burn || ctx.monthly_burn || '').replace(/[^0-9.]/g, ''))
    if (Number.isFinite(cash) && cash > 0 && Number.isFinite(burn) && burn > 0) {
      await sql`
        INSERT INTO hire_runway_snapshots (id, user_id, taken_on, cash, burn, months)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${weekStart}, ${cash}, ${burn}, ${cash / burn})
        ON CONFLICT (user_id, taken_on) DO UPDATE SET cash = excluded.cash, burn = excluded.burn, months = excluded.months
      `
    }
  } catch (err) {
    console.warn('[weekly] runway snapshot failed', err)
  }
  const existing = await sql`
    SELECT id, done_text AS "doneText" FROM hire_weekly_reviews
    WHERE user_id = ${user.id} AND week_start = ${weekStart} LIMIT 1
  `
  const row = existing[0] as { id: string; doneText?: string } | undefined
  let wroteReview = false
  if (!row) {
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_weekly_reviews (id, user_id, week_start, done_text, slipped_text, focus_text)
      VALUES (${id}, ${user.id}, ${weekStart}, ${wrote.doneText}, ${wrote.slippedText}, ${wrote.focusText})
    `
    wroteReview = true
  }
  const due = await sql`
    SELECT name, phone, email FROM hire_network
    WHERE user_id = ${user.id}
      AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC
    LIMIT 1
  `
  const pingRow = due[0] as { name: string; phone: string; email: string } | undefined
  const ping = pingRow
    ? {
        name: pingRow.name,
        email: pingRow.email || undefined,
        phone: pingRow.phone || undefined,
      }
    : undefined
  return {
    text: wrote.text,
    wroteReview,
    spendOver: snap.weeklyBudget > 0 && snap.spend > snap.weeklyBudget,
    ping: ping?.email || ping?.phone ? ping : undefined,
  }
}

/** The timezone the user's day actually runs on: travel_tz when travel mode
 * is set, else home. One function so briefs and guards stay in sync. */
function effectiveTz(userTz: string | null | undefined, context: Record<string, string> | null | undefined): string {
  return (context?.travel_tz || '').trim() || userTz || 'America/Los_Angeles'
}

async function judgmentStatePayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
  tick: string,
) {
  const context = await loadContext(sql, user.id, persona)
  const tz = effectiveTz(user.timezone, context)
  const today = localDateStrInTz(new Date(), tz)
  const weekStart = userMonday(user)
  const weekEnd = shiftDateStr(weekStart, 7)
  /* TIMESTAMPTZ columns compared to a bare `::date` read at midnight in the
   * database's session timezone — the user's day/week is minutes off that. */
  const dayWindow = todayWindowUtc(tz)
  const weekWindow = weekWindowUtc(weekStart, tz)
  const localTime = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace(', ', 'T')
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date())

  const inbound = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const lastInboundAt = (inbound[0] as { lastInboundAt?: Date | null } | undefined)?.lastInboundAt || null

  const nutrGoals = await sql`
    SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal"
    FROM hire_nutrition_goals WHERE user_id = ${user.id} LIMIT 1
  `
  const nutrToday = await sql`
    SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories, coalesce(sum(protein), 0)::real AS protein
    FROM hire_nutrition_logs
    WHERE user_id = ${user.id} AND eaten_at >= ${dayWindow.start.toISOString()} AND eaten_at < ${dayWindow.end.toISOString()}
  `
  const g = (nutrGoals[0] as { calorieGoal?: number; proteinGoal?: number } | undefined) || {}
  const n = (nutrToday[0] as { meals?: number; calories?: number; protein?: number } | undefined) || {}

  const habitRows = await sql`
    SELECT id, name FROM hire_habits WHERE user_id = ${user.id} ORDER BY created_at ASC LIMIT 12
  `
  const habitLogs = await sql`
    SELECT habit_id AS "habitId", date FROM hire_habit_logs
    WHERE user_id = ${user.id} AND date >= ${shiftDateStr(today, -14)}
  `
  const logMap = new Map<string, Set<string>>()
  for (const lr of habitLogs as Array<{ habitId: string; date: string }>) {
    if (!logMap.has(lr.habitId)) logMap.set(lr.habitId, new Set())
    logMap.get(lr.habitId)!.add(String(lr.date).slice(0, 10))
  }
  const habits = (habitRows as Array<{ id: string; name: string }>).map((h) => {
    const dates = logMap.get(h.id) || new Set()
    let streak = 0
    const startEmpty = !dates.has(today)
    for (let i = startEmpty ? 1 : 0; i < 400; i++) {
      const ds = shiftDateStr(today, -i)
      if (dates.has(ds)) streak++
      else break
    }
    return { name: h.name, streak, todayDone: dates.has(today) }
  })

  const moodRows = await sql`
    SELECT emoji, energy, created_at AS "createdAt"
    FROM hire_moods WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 1
  `
  const moodRow = moodRows[0] as { emoji?: string; energy?: number; createdAt?: Date } | undefined
  const mood = moodRow?.emoji
    ? {
        loggedToday: localDateStrInTz(new Date(moodRow.createdAt as Date), tz) === today,
        lastEmoji: moodRow.emoji,
        lastEnergy: moodRow.energy || null,
      }
    : null

  const lastNight = shiftDateStr(today, -1)
  const sleepRows = await sql`
    SELECT sleep_date AS "sleepDate", bedtime, wake, quality
    FROM hire_sleep WHERE user_id = ${user.id}
    ORDER BY sleep_date DESC LIMIT 7
  `
  const srow = (sleepRows as Array<{ sleepDate?: string; bedtime?: string; wake?: string; quality?: number }>).find(
    (r) => {
      const d = ymdOf(r.sleepDate)
      return (d === lastNight || d === today) && r.bedtime && r.wake
    },
  )
  const sleep = srow
    ? { hours: sleepHoursBetween(srow.bedtime!, srow.wake!), quality: srow.quality || 3, date: lastNight }
    : null
  const weekNights = (sleepRows as Array<{ bedtime?: string; wake?: string }>).filter((r) => r.bedtime && r.wake)
  const weekHours = weekNights.map((r) => sleepHoursBetween(r.bedtime!, r.wake!))
  const sleepWeek = weekHours.length
    ? {
        nights: weekHours.length,
        avgHours: Math.round((weekHours.reduce((a, b) => a + b, 0) / weekHours.length) * 10) / 10,
        shortNights: weekHours.filter((h) => h < 6.5).length,
      }
    : { nights: 0, avgHours: 0, shortNights: 0 }

  const workoutTodayRows = await sql`
    SELECT count(*)::int AS n FROM hire_workouts
    WHERE user_id = ${user.id} AND logged_at >= ${dayWindow.start.toISOString()} AND logged_at < ${dayWindow.end.toISOString()}
  `
  const workoutsToday = Number((workoutTodayRows[0] as { n?: number })?.n || 0)
  const prefs = await loadMiniPrefs(sql, user.id)
  const workoutToday = workoutTodayLabel(weekday, prefs.workoutPlace)


  const duePeople = await sql`
    SELECT name, context, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_network WHERE user_id = ${user.id}
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
  `
  const peopleDue = (duePeople as Array<{ name: string; context: string; phone: string; lastTouch: Date | null; cadenceDays: number }>)
    .map((p) => {
      const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
      const bits = [p.phone, p.context].filter(Boolean)
      return {
        name: p.name,
        days,
        note: bits.join('. ') || undefined,
        due: days >= (p.cadenceDays || 14),
        phone: p.phone || undefined,
      }
    })
    .filter((p) => p.due)
    .slice(0, 3)
    .map(({ name, days, note, phone }) => ({ name, days, note, phone }))

  const phoneRows = await sql`
    SELECT name, phone, email FROM hire_network
    WHERE user_id = ${user.id} AND (coalesce(phone, '') <> '' OR coalesce(email, '') <> '')
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC
    LIMIT 12
  `
  const peoplePhones = (phoneRows as Array<{ name: string; phone: string; email: string }>).map((p) => ({
    name: p.name,
    phone: p.phone || undefined,
    email: p.email || undefined,
  }))

  const radar = await sql`
    SELECT name, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_network WHERE user_id = ${user.id} LIMIT 8
  `
  for (const p of radar as Array<{ name: string; lastTouch: Date | null; cadenceDays: number }>) {
    const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
    if (days >= (p.cadenceDays || 14) && !peopleDue.some((x) => x.name === p.name)) {
      peopleDue.push({ name: p.name, days, note: undefined, phone: undefined })
    }
  }

  const spendRow = await sql`
    SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
    WHERE user_id = ${user.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
  `
  const budgetRow = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`
  const loops = await sql`
    SELECT title FROM hire_loops WHERE user_id = ${user.id} AND status = 'open' ORDER BY created_at DESC LIMIT 5
  `

  let calendar: string[] = []
  let mail: string[] = []
  const digestTick =
    tick === 'digest' || tick === 'morning' || tick === 'evening' || tick === 'night' || tick === 'digest_evening'
  try {
    if (digestTick) {
      /* Warms the same cache the brief link reads, so the digest text and the
       * screen it points at are one load rather than two. */
      const payload = (await digestCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'digest', () => digestPayload(sql, user, persona), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value?.payload
      calendar = (payload?.calendar || []).slice(0, 4)
      mail = (payload?.emails || []).slice(0, 3)
    } else {
      const connected = await connectedForUser(sql, user.id)
      const jobs: Array<Promise<void>> = []
      if (connected.includes('calendar')) {
        jobs.push(
          withTimeout(loadWorldCalendar(sql, user, tz), 5000, [] as string[]).then((rows) => {
            calendar = rows
          }),
        )
      }
      if (connected.includes('gmail')) {
        jobs.push(
          withTimeout(loadWorldMail(sql, user.id), 8000, [] as string[]).then((rows) => {
            mail = rows
          }),
        )
      }
      if (jobs.length) await Promise.all(jobs)
    }
  } catch (err) {
    console.warn('[judgment] world model slice failed', err)
  }

  const pausedUntil = String(context.paused_until || '')
  let proactive = String(context.proactive || 'on')
  if (proactive === 'paused' && pausedUntil && new Date(pausedUntil).getTime() < Date.now()) {
    proactive = 'on'
  }

  let weekly: Record<string, number | string> | null = null
  if (tick === 'weekly') {
    const wkNutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
    `
    const wkMoods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const wkHabits = await sql`
      SELECT count(*)::int AS checks FROM hire_habit_logs
      WHERE user_id = ${user.id} AND date >= ${weekStart} AND date < ${weekEnd}
    `
    const wkSleep = await sql`
      SELECT bedtime, wake FROM hire_sleep
      WHERE user_id = ${user.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEnd}
    `
    let wkSleepHours = 0
    const wkSleepRows = wkSleep as Array<{ bedtime: string; wake: string }>
    if (wkSleepRows.length) {
      wkSleepHours =
        wkSleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / wkSleepRows.length
    }
    const wkWorkouts = await sql`
      SELECT count(*)::int AS n FROM hire_workouts
      WHERE user_id = ${user.id} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
    `
    const wkLearning = await sql`
      SELECT count(*)::int AS n FROM hire_learning
      WHERE user_id = ${user.id} AND status = 'done' AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    weekly = {
      meals: Number((wkNutr[0] as { meals?: number })?.meals || 0),
      calories: Math.round(Number((wkNutr[0] as { calories?: number })?.calories) || 0),
      moodLogs: Number((wkMoods[0] as { logs?: number })?.logs || 0),
      avgEnergy: Math.round((Number((wkMoods[0] as { energy?: number })?.energy) || 0) * 10) / 10,
      habitChecks: Number((wkHabits[0] as { checks?: number })?.checks || 0),
      sleepNights: wkSleepRows.length,
      avgSleepHours: Math.round(wkSleepHours * 10) / 10,
      spend: Math.round(Number((spendRow[0] as { total?: number })?.total) || 0),
      weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
      workouts: Number((wkWorkouts[0] as { n?: number })?.n || 0),
      learningDone: Number((wkLearning[0] as { n?: number })?.n || 0),
      gratitude: 0,
    }
    const wkGratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    weekly.gratitude = Number((wkGratitude[0] as { n?: number })?.n || 0)
  }

  return {
    persona,
    name: user.name || null,
    localTime,
    weekday,
    timezone: tz,
    tick,
    proactive,
    quietHours: String(context.quiet_hours || '22:00-08:00'),
    lastInboundMinutesAgo: minutesAgo(lastInboundAt),
    lastProactiveMinutesAgo: minutesAgo(context.last_proactive_at),
    lastProactiveTopic: context.last_proactive_topic || null,
    unansweredProactive: Math.max(0, Number(context.unanswered_proactive) || 0),
    unansweredToday:
      String(context.last_proactive_day || '') === today
        ? Math.max(0, Number(context.unanswered_day_count) || 0)
        : 0,
    nutrition: {
      calories: Math.round(Number(n.calories) || 0),
      protein: Math.round(Number(n.protein) || 0),
      calorieGoal: Math.round(Number(g.calorieGoal) || 2200),
      proteinGoal: Math.round(Number(g.proteinGoal) || 150),
      meals: Number(n.meals) || 0,
    },
    habits,
    mood,
    sleep,
    sleepWeek,
    workoutsToday,
    workoutToday,
    peopleDue: peopleDue.slice(0, 3),
    peoplePhones,
    spend: {
      weekTotal: Math.round(Number((spendRow[0] as { total?: number })?.total) || 0),
      weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
    },
    loops: (loops as Array<{ title: string }>).map((l) => l.title),
    calendar,
    mail,
    ...(weekly ? { weekly } : {}),
  }
}

async function touchInbound(sql: SQL, phone: string, persona: Persona) {
  const user = await getUserByPhone(sql, phone)
  if (!user) return { armed: false, first: false }
  const rows = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const row = rows[0] as { lastInboundAt: Date | null } | undefined
  if (!row) return { armed: false, first: false }
  const first = !row.lastInboundAt
  await sql`
    UPDATE hire_roster SET last_inbound_at = now()
    WHERE user_id = ${user.id} AND persona = ${persona}
  `
  // The person just texted us: the queued cold intro is obsolete (Photon
  // shared lines cannot cold-text anyway) and sending it after this would
  // duplicate the welcome. Mark it sent.
  await sql`
    UPDATE hire_intro_queue SET status = 'sent', sent_at = now(), last_error = NULL
    WHERE phone_e164 = ${phone} AND persona = ${persona} AND status IN ('pending', 'claiming', 'failed')
  `
  const context = await loadContext(sql, user.id, persona)
  await upsertContext(sql, user.id, persona, {
    unanswered_proactive: '0',
    unanswered_day_count: '0',
  })
  await armPokes(sql, user, persona, context)
  // A first (or any) inbound re-arms the morning brief for someone whose DB row
  // or wizard state got lost. Cheap and idempotent: no-op when a digest
  // reminder already exists, so it never duplicates a chosen brief time.
  await armMorningBrief(sql, user, persona)
  return { armed: true, first }
}

export async function miniPayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
  kind: string,
) {
  const tz = user.timezone || 'America/Los_Angeles'
  // Two independent reads that every kind below needs. Serially they were two
  // round trips before any real work started.
  const [context, connectedAll] = await Promise.all([
    loadContext(sql, user.id, persona),
    connectedForUser(sql, user.id),
  ])
  const connected = connectedAll.filter((id) => !PERSONA_DENIED[persona].has(id))
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

  if (kind === 'tonight') {
    const location = await pickActiveLocation(sql, user.id)
    const mapsQuery = String(context.tonight_query || 'dinner restaurant').trim() || 'dinner restaurant'
    const mapsRaw = await fetchMapSearch(mapsQuery, timezoneCountry(tz), location)
    const places: Array<{ label: string; link?: string }> = []
    for (const line of mapsRaw.split('\n')) {
      if (!line.startsWith('- ')) continue
      const link = line.match(/https:\/\/\S+/)?.[0]
      const label = line
        .replace(/^- /, '')
        .replace(/\s+https:\/\/\S+/, '')
        .trim()
      if (label) places.push({ label, link })
    }
    const hour = Number(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }),
    )
    const vibe =
      hour >= 21 ? 'Wind down early if last night was short.' : hour >= 17 ? 'Evening is open.' : 'Plan ahead while the day is light.'
    const sections = [
      {
        heading: places.length ? 'Places' : 'Tonight',
        items: places.length
          ? places.slice(0, 5).map((p) => (p.link ? `${p.label}\n${p.link}` : p.label))
          : [mapsRaw.split('\n').find(Boolean) || 'Tell Alpha in or out and a neighborhood.'],
      },
      { heading: 'The read', items: [vibe] },
    ]
    return { kind, title: 'Tonight', date: dateLabel, sections, text: mapsRaw }
  }

  if (kind === 'pick_night') {
    // Evening brief: what happened today, what's left, mail since morning, tomorrow.
    const nowMs = Date.now()
    const todayStart = startOfLocalDay(tz)
    const tomorrowStart = startOfLocalDay(tz, 1)
    const dayAfterStart = startOfLocalDay(tz, 2)
    const todayYmd = todayStart.toLocaleDateString('en-CA', { timeZone: tz })
    const tomorrowYmd = tomorrowStart.toLocaleDateString('en-CA', { timeZone: tz })

    interface EveningEvent {
      time: string
      title: string
      who: string
      meetKind: string
      allDay: boolean
      startMs: number
      dayYmd: string
    }

    const allEvents: EveningEvent[] = []

    function pushCalItems(items: CalItem[]) {
      for (const e of items) {
        const ymd = e.start.toLocaleDateString('en-CA', { timeZone: tz })
        allEvents.push({
          time: e.allDay ? 'All day' : formatClock(e.start, tz),
          title: e.title,
          who: extractOtherPerson(e.title, user.name || null) || parseCalMeet(e.title).who,
          meetKind: e.kind,
          allDay: e.allDay,
          startMs: e.start.getTime(),
          dayYmd: ymd,
        })
      }
    }

    /* The three things this brief is made of — the calendar, the inbox, and the
     * day's own logs — never read each other. Serially they were three waits
     * stacked end to end; started together the brief costs only the slowest. */
    const calJob = async (): Promise<ConnectorStatus> => {
      if (!connected.includes('calendar')) return 'not_connected'
      let status: ConnectorStatus = 'ok'
      // Try direct Google Calendar first: fetch today + tomorrow together
      const tokenStatus = await googleTokenWithStatus(sql, user.id, 'calendar')
      if (tokenStatus.ok) {
        const got = await fetchCalendarItems(tokenStatus.accessToken, {
          timeMin: todayStart,
          timeMax: dayAfterStart,
          maxResults: 20,
        })
        if (got.ok) {
          pushCalItems(got.items)
          return 'ok'
        } else {
          status = got.reason || 'provider_error'
        }
      } else {
        status = tokenStatus.reason
      }
      // Fallback via composio/runTools if direct fetch returned nothing
      if (!allEvents.length) {
        const calResults = await withTimeout(
          runToolsForMessage(sql, {
            userId: user.id,
            persona,
            message: 'calendar today tomorrow',
            connected,
            timezone: tz,
          }),
          8000,
          [] as string[],
        )
        const calendarBlock = calResults.find((t) => isCalendarToolResult(t))
        for (const line of digestLines(calendarBlock)) {
          const parsed = parseFormattedEventLine(line)
          if (!parsed) continue
          const raw = parsed.iso.includes('T') ? parsed.iso : `${parsed.iso}T12:00:00`
          const d = new Date(raw)
          if (Number.isNaN(d.getTime())) continue
          const ymd = d.toLocaleDateString('en-CA', { timeZone: tz })
          if (ymd !== todayYmd && ymd !== tomorrowYmd) continue
          allEvents.push({
            time: parsed.clock || formatCalTime(parsed.iso, tz),
            title: parsed.title,
            who: extractOtherPerson(parsed.title, user.name || null) || parseCalMeet(parsed.title).who,
            meetKind: parsed.kind || 'Meeting',
            allDay: parsed.clock === 'All day',
            startMs: d.getTime(),
            dayYmd: ymd,
          })
        }
        if (allEvents.length) return 'ok'
        if (calResults.length === 0) return 'timeout'
      }
      return status
    }

    // Mail since morning: recent inbox minus spam, then a model judges.
    // Keep enough to break into sub-category piles like the morning brief.
    const mailJob = async (): Promise<{
      mailStatus: ConnectorStatus
      mailItems: Array<{ id: string; label: string; snippet?: string; kind?: string }>
      mailGroups: Array<{
        kind: string
        label: string
        count: number
        items: Array<{ id: string; label: string; snippet?: string }>
      }>
    }> => {
      if (!connected.includes('gmail')) {
        return { mailStatus: 'not_connected', mailItems: [], mailGroups: [] }
      }
      let mailStatus: ConnectorStatus = 'ok'
      let mailItems: Array<{ id: string; label: string; snippet?: string; kind?: string }> = []
      let mailGroups: Array<{
        kind: string
        label: string
        count: number
        items: Array<{ id: string; label: string; snippet?: string }>
      }> = []
      try {
        const exact = await withTimeout(
          readGmailExact(
            sql,
            user.id,
            `${importantMailQuery('2d')} after:${Math.floor(todayStart.getTime() / 1000)}`,
            JUDGE_MAIL_CAP,
          ),
          6000,
          { items: [] as Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }>, failed: true, status: 'timeout' as const },
        )
        mailStatus = exact.status || 'ok'
        const richMail = exact.items
        const doneIdsE = await triagedMailIds(sql, user.id)
        const kept = (await judgeBriefMail(richMail, JUDGE_MAIL_CAP)).filter((m) => !doneIdsE.has(m.id))
        // A few lead the flat "Mail today"; the rest become the
        // sub-category piles. Morning keeps these separate, and so does this —
        // otherwise every mail renders twice (flat + grouped).
        const leadIds = new Set(kept.slice(0, 3).map((m) => m.id))
        mailItems = kept.slice(0, 3).map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet),
          kind: m.kind,
        }))
        mailGroups = groupMailByKind(kept.filter((m) => !leadIds.has(m.id))).map((g) => ({
          kind: g.kind,
          label: g.label,
          count: g.count,
          items: g.items.map((m) => ({
            id: m.id,
            label: formatMailLineFromParts(m.from, m.subject),
            snippet: cleanMailSnippet(m.snippet || ''),
          })),
        }))
      } catch {
        // best-effort
      }
      return { mailStatus, mailItems, mailGroups }
    }

    // The day, closed: every fact below comes from a log table, never invented.
    // The checklist and score let the evening brief answer "how did today go"
    // instead of only listing what is left on the calendar.
    interface EveningDayFact {
      key: string
      label: string
      detail: string
      state: 'done' | 'miss' | 'partial'
    }
    const dayFacts: EveningDayFact[] = []
    const habitsToday: Array<{ id: string; name: string; emoji: string; done: boolean }> = []
    const carryOver: Array<{ id: string; title: string; dueLabel?: string }> = []
    let dayScore: { points: number; verdict: string } | null = null
    const factsJob = (async () => {
      try {
        const weekStartNight = mondayOfDateStr(todayYmd)
        const yesterdayYmd = shiftDateStr(todayYmd, -1)
        /* Ten one-row reads that know nothing about each other — and they used to
         * run as ten round trips, one after the next, inside a single response.
         * Each keeps its own catch, so an unhappy table now costs one fact
         * instead of every fact after it, which is what one big try/catch did. */
        const rows = async <T>(q: Promise<T[]>): Promise<T[]> => {
          try {
            return (await q) || []
          } catch {
            return []
          }
        }
        const [
          workoutRows,
          nutRows,
          goalRows,
          habitRowsE,
          spendRowsE,
          budgetRows,
          moodRows,
          nightRows,
          loopRowsE,
        ] = await Promise.all([
          rows<{ n?: number }>(sql`
            SELECT count(*)::int AS n FROM hire_workouts
            WHERE user_id = ${user.id} AND (logged_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ calories?: number; protein?: number; meals?: number }>(sql`
            SELECT coalesce(sum(calories), 0)::float AS calories, coalesce(sum(protein), 0)::float AS protein,
                   count(*)::int AS meals
            FROM hire_nutrition_logs
            WHERE user_id = ${user.id} AND (eaten_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ calorieGoal?: number; proteinGoal?: number }>(sql`
            SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal"
            FROM hire_nutrition_goals WHERE user_id = ${user.id}
          `),
          rows<{ id: string; name: string; emoji: string; done: boolean }>(sql`
            SELECT h.id, h.name, h.emoji,
                   EXISTS (SELECT 1 FROM hire_habit_logs l WHERE l.habit_id = h.id AND l.date = ${todayYmd}) AS done
            FROM hire_habits h WHERE h.user_id = ${user.id} ORDER BY h.created_at ASC
          `),
          rows<{ total?: number }>(sql`
            SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
            WHERE user_id = ${user.id} AND (spent_at AT TIME ZONE ${tz})::date >= ${weekStartNight}
          `),
          rows<{ weeklyBudget?: number }>(sql`
            SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}
          `),
          rows<{ n?: number }>(sql`
            SELECT count(*)::int AS n FROM hire_moods
            WHERE user_id = ${user.id} AND (created_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ bedtime?: string; wake?: string }>(sql`
            SELECT bedtime, wake FROM hire_sleep
            WHERE user_id = ${user.id} AND sleep_date IN (${todayYmd}, ${yesterdayYmd})
            ORDER BY sleep_date DESC LIMIT 1
          `),
          rows<{ id: string; title: string; dueAt: Date }>(sql`
            SELECT id, title, due_at AS "dueAt" FROM hire_loops
            WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'open'
              AND due_at IS NOT NULL AND (due_at AT TIME ZONE ${tz})::date <= ${todayYmd}
            ORDER BY due_at ASC LIMIT 5
          `),
        ])

        const workoutsToday = Number(workoutRows[0]?.n) || 0
        dayFacts.push(
          workoutsToday > 0
            ? { key: 'workout', label: 'Lifted', detail: `${workoutsToday} move${workoutsToday === 1 ? '' : 's'} logged`, state: 'done' }
            : { key: 'workout', label: 'No lift', detail: 'Nothing logged today', state: 'miss' },
        )

        const nut = nutRows[0]
        const mealsLogged = Number(nut?.meals) || 0
        {
          // Always present: the user reads this block as their nutrition
          // scoreboard for the day — silence on a 0-meal day reads as missing.
          const cal = Math.round(Number(nut?.calories) || 0)
          const protein = Math.round(Number(nut?.protein) || 0)
          const calGoal = Math.round(goalRows[0]?.calorieGoal || 2200)
          const proteinGoal = Math.round(goalRows[0]?.proteinGoal || 150)
          dayFacts.push({
            key: 'food',
            label: mealsLogged > 0 ? 'Food' : 'Food — nothing logged',
            detail: `${protein}g of ${proteinGoal}g protein · ${Math.max(0, calGoal - cal)} calories left`,
            state: mealsLogged === 0 ? 'miss' : protein >= proteinGoal * 0.6 ? 'done' : 'partial',
          })
        }

        for (const h of habitRowsE) {
          habitsToday.push({ id: h.id, name: h.name, emoji: h.emoji, done: !!h.done })
        }
        const habitsDone = habitsToday.filter((h) => h.done).length
        dayFacts.push({
          key: 'habits',
          label: habitsToday.length ? 'Habits' : 'No habits yet',
          detail: habitsToday.length ? `${habitsDone} of ${habitsToday.length} done` : 'Ask Alpha to add one',
          state: !habitsToday.length ? 'miss' : habitsDone === habitsToday.length ? 'done' : habitsDone > 0 ? 'partial' : 'miss',
        })

        const spendWeekN = Number(spendRowsE[0]?.total) || 0
        if (spendWeekN > 0) {
          const budgetN = Math.round(budgetRows[0]?.weeklyBudget || 400)
          dayFacts.push({
            key: 'spend',
            label: 'Spent this week',
            detail: `$${Math.round(spendWeekN)} of $${budgetN}`,
            state: spendWeekN <= budgetN ? 'done' : 'miss',
          })
        }

        {
          const n = Number(moodRows[0]?.n) || 0
          dayFacts.push(
            n > 0
              ? { key: 'mood', label: 'Mood', detail: 'Logged', state: 'done' }
              : { key: 'mood', label: 'Mood not logged', detail: '', state: 'miss' },
          )
        }

        const lastNightE = nightRows[0]
        const nightHoursE =
          lastNightE?.bedtime && lastNightE?.wake ? sleepHoursBetween(lastNightE.bedtime, lastNightE.wake) : 0

        const hasSignal =
          workoutsToday > 0 || mealsLogged > 0 || habitsToday.length > 0 || nightHoursE > 0 ||
          dayFacts.some((f) => f.state === 'done')
        if (hasSignal) {
          let points = 50
          points += workoutsToday > 0 ? 15 : -10
          if (mealsLogged > 0) {
            const f = dayFacts.find((x) => x.key === 'food')
            points += f?.state === 'done' ? 10 : -5
          }
          if (habitsToday.length) {
            const ratio = habitsDone / habitsToday.length
            points += Math.round(ratio * 20 - 10)
          }
          const sf = dayFacts.find((x) => x.key === 'spend')
          if (sf) points += sf.state === 'done' ? 5 : -10
          points += dayFacts.some((f) => f.key === 'mood' && f.state === 'done') ? 5 : 0
          if (nightHoursE >= 7) points += 10
          else if (nightHoursE > 0 && nightHoursE < 6) points -= 10
          points = Math.max(0, Math.min(100, points))
          const verdict = points >= 75 ? 'strong' : points >= 60 ? 'solid' : points >= 45 ? 'decent' : points >= 30 ? 'rough' : 'wrecked'
          dayScore = { points, verdict }
        }

        for (const l of loopRowsE) {
          carryOver.push({
            id: l.id,
            title: l.title,
            dueLabel: formatCalTime(new Date(l.dueAt).toISOString(), tz),
          })
        }
      } catch {
        // Debrief facts are best effort; the calendar sections still ship.
      }
    })()

    const [calStatus, { mailStatus, mailItems, mailGroups }] = await Promise.all([calJob(), mailJob(), factsJob])

    const todayEvents = allEvents.filter((e) => e.dayYmd === todayYmd)
    const tomorrowEvents = allEvents.filter((e) => e.dayYmd === tomorrowYmd && !e.allDay)

    // Hotel/travel all-day = where you are
    const locationEvents = todayEvents.filter((e) =>
      isHotelStayEvent({ title: e.title, allDay: e.allDay }),
    )
    // Past timed events today (recap)
    const pastEvents = todayEvents
      .filter((e) => !e.allDay && e.startMs < nowMs - 5 * 60_000)
      .sort((a, b) => a.startMs - b.startMs)
    // Remaining timed events today
    const remainingEvents = todayEvents
      .filter((e) => !e.allDay && e.startMs >= nowMs - 5 * 60_000)
      .sort((a, b) => a.startMs - b.startMs)

    const formatEvent = (e: EveningEvent) => `${e.time}  ${e.who || e.title}  ${e.meetKind}`

    const sections: Array<{ heading: string; items: string[]; emailMeta?: Array<{ id: string; snippet?: string; kind?: string }> }> = []

    if (locationEvents.length) {
      const locs = locationEvents.map((e) =>
        e.title
          .replace(/^(?:stay(?:ing)?|checked?\s*in)\s+at\s+/i, '')
          .replace(/^at\s+/i, '')
          .trim(),
      )
      sections.push({ heading: 'Where you are', items: locs })
    }

    if (pastEvents.length) {
      sections.push({ heading: 'Earlier today', items: pastEvents.map(formatEvent) })
    }

    if (remainingEvents.length) {
      sections.push({ heading: 'Left this evening', items: remainingEvents.map(formatEvent) })
    } else if (connected.includes('calendar')) {
      sections.push({ heading: 'Left this evening', items: ['Nothing left on the calendar.'] })
    } else {
      sections.push({ heading: 'Left this evening', items: ['Calendar is not connected. Tap Settings to add it.'] })
    }

    // Tonight's own tasks: reminders scheduled through tomorrow morning and
    // open loops due. The evening brief used to end at the calendar, which is
    // how a day with real work left read as "nothing left".
    const tonightTasks: string[] = []
    try {
      const remRows = await sql`
        SELECT text, scheduled_at AS "scheduledAt" FROM hire_reminders
        WHERE user_id = ${user.id} AND status = 'pending'
          AND scheduled_at >= ${startOfLocalDay(tz)} AND scheduled_at <= ${startOfLocalDay(tz, 2)}
        ORDER BY scheduled_at ASC LIMIT 5
      `
      for (const r of remRows as Array<{ text: string; scheduledAt: Date }>) {
        tonightTasks.push(`${formatCalTime(new Date(r.scheduledAt).toISOString(), tz)} ${r.text.replace(/^\[digest\]/i, '').trim()}`)
      }
      const loopRows = await sql`
        SELECT title, due_at AS "dueAt" FROM hire_loops
        WHERE user_id = ${user.id} AND status = 'open'
          AND due_at IS NOT NULL AND due_at <= ${startOfLocalDay(tz, 2)}
        ORDER BY due_at ASC LIMIT 5
      `
      for (const l of loopRows as Array<{ title: string; dueAt: Date | null }>) {
        tonightTasks.push(l.dueAt ? `${l.title} · due ${formatCalTime(new Date(l.dueAt).toISOString(), tz)}` : l.title)
      }
    } catch {
      /* best-effort */
    }
    if (tonightTasks.length) {
      sections.push({ heading: 'Needs you', items: tonightTasks })
    }

    if (mailItems.length) {
      sections.push({
        heading: 'Mail today',
        items: mailItems.map((m) => m.label),
        emailMeta: mailItems.map((m) => ({ id: m.id, snippet: m.snippet, kind: m.kind })),
      })
    } else if (connected.includes('gmail')) {
      if (mailStatus === 'auth_expired') {
        sections.push({
          heading: 'Mail today',
          items: ['Gmail authorization expired. Reconnect in Settings.'],
        })
      } else if (mailStatus === 'timeout') {
        sections.push({
          heading: 'Mail today',
          items: ['Mail check timed out.'],
        })
      } else if (mailStatus === 'provider_error') {
        sections.push({
          heading: 'Mail today',
          items: ['Could not check Gmail just now.'],
        })
      }
    }

    if (tomorrowEvents.length) {
      sections.push({ heading: 'Tomorrow', items: tomorrowEvents.slice(0, 5).map(formatEvent) })
    } else if (connected.includes('calendar')) {
      if (calStatus === 'auth_expired') {
        sections.push({ heading: 'Tomorrow', items: ['Calendar authorization expired. Reconnect in Settings.'] })
      } else if (calStatus === 'timeout') {
        sections.push({ heading: 'Tomorrow', items: ['Calendar check timed out.'] })
      } else if (calStatus === 'provider_error') {
        sections.push({ heading: 'Tomorrow', items: ['Could not check calendar.'] })
      } else {
        sections.push({ heading: 'Tomorrow', items: ['Nothing on the calendar.'] })
      }
    }

    return {
      kind,
      title: 'Evening brief',
      date: dateLabel,
      sections,
      text: '',
      dayScore,
      dayFacts,
      habitsToday,
      carryOver,
      mailGroups,
      calendarStatus: calStatus,
      mailStatus,
    }
  }

  if (kind === 'standup_paste') {
    const results = await runToolsForMessage(sql, {
      userId: user.id,
      persona,
      message: 'calendar today standup github pull requests linear issues',
      connected,
      timezone: tz,
    })
    const calendarBlock = results.find((t) => isCalendarToolResult(t))
    const calItems = digestLines(calendarBlock)
      .map((l) => {
        const p = parseFormattedEventLine(l)
        if (!p) return l.replace(/^-\s*/, '')
        return p.clock ? `${p.clock} ${p.title}` : p.title
      })
      .slice(0, 4)
    const gh = results.find((t) => /^github/i.test(t) || t.startsWith('- ') && /pull|pr\b|merged/i.test(t))
    const lin = results.find((t) => /linear/i.test(t) || (t.startsWith('- ') && /\b[A-Z]{2,}-\d+/.test(t)))
    const ghLines = digestLines(gh).slice(0, 3).map((l) => l.replace(/^-\s*/, ''))
    const linLines = digestLines(lin).slice(0, 4).map((l) => l.replace(/^-\s*/, ''))
    const yesterday = ghLines[0] || 'Nothing merged that I can see. Do not invent work.'
    const today = calItems[0] || linLines[0] || 'Nothing on calendar. Name the one Linear issue.'
    const blocked = linLines.find((l) => /block/i.test(l)) || 'None named in Linear.'
    const paste = `Yesterday: ${yesterday}\nToday: ${today}\nBlocked: ${blocked}`
    const sections = [
      { heading: 'Paste this', items: [paste] },
      { heading: 'On the calendar', items: calItems.length ? calItems : ['Nothing on calendar.'] },
      { heading: 'GitHub', items: ghLines.length ? ghLines : ['Connect GitHub for merged PRs.'] },
      { heading: 'Linear', items: linLines.length ? linLines : ['Connect Linear for issues.'] },
    ]
    return { kind, title: 'Standup', date: dateLabel, sections, paste, text: paste }
  }

  if (kind === 'kill_keep_park') {
    const pipes = (await sql`
      SELECT id, title, company, stage, notes, updated_at AS "updatedAt"
      FROM hire_pipeline WHERE user_id = ${user.id}
      ORDER BY updated_at DESC LIMIT 20
    `) as Array<{ id: string; title: string; company: string; stage: string; notes: string; updatedAt: Date }>
    const live = pipes.filter((p) => p.stage !== 'won' && p.stage !== 'lost')
    const keepRow = live.find((p) => p.stage === 'offer' || p.stage === 'interview') || live[0]
    const killRow = live.find((p) => p.stage === 'lead' && p.id !== keepRow?.id)
    const parkRow = live.find((p) => p.id !== keepRow?.id && p.id !== killRow?.id)
    const keep = keepRow
      ? `${keepRow.title}${keepRow.company ? ` @ ${keepRow.company}` : ''} (${keepRow.stage})`
      : (context.weekly_focus || '').trim() || 'Nothing on pipeline. Add a deal first.'
    const kill = killRow
      ? `${killRow.title}${killRow.company ? ` @ ${killRow.company}` : ''} — stale ${killRow.stage}`
      : 'No stale lead to kill.'
    const park = parkRow
      ? `${parkRow.title} — park until ${keepRow ? keepRow.title : 'the keep'} moves`
      : 'Nothing to park.'
    const sections = [
      { heading: 'Keep', items: [keep] },
      { heading: 'Kill', items: [kill] },
      { heading: 'Park', items: [park] },
    ]
    const paste = `Keep: ${keep}\nKill: ${kill}\nPark: ${park}`
    return { kind, title: 'Kill · Keep · Park', date: dateLabel, sections, paste, text: paste, pipeline: {
      keepId: keepRow?.id, killId: killRow?.id, parkId: parkRow?.id,
    } }
  }

  return { kind, title: kind, date: dateLabel, sections: [], text: '' }
}

async function livePayload(sql: SQL, phone: string, persona: Persona, query?: string) {
  const user = await getUserByPhone(sql, phone)
  if (!user) {
    return {
      found: false,
      hired: false,
      context: {} as Record<string, string>,
      connected: [] as string[],
      memories: [] as MemoryRow[],
      email: null as string | null,
      name: null as string | null,
      timezone: null as string | null,
      lastInboundAt: null as string | null,
    }
  }
  const roster = await loadRoster(sql, user.id)
  const hired = roster.includes(persona)
  // Independent reads run together, and the two that can stall (Composio
  // connector resolution; Vault-decrypted memory recall) carry their own
  // Split google and Composio lookups: a Composio timeout must not drop
  // google connectors (gmail, calendar, drive). Google has a 3s budget,
  // Composio has 6s, and we merge both result sets.
  const budget = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
  const googleConnectorFast = hired
    ? budget(
        googleConnected(sql, user.id).then((g) => (g ? googleUiConnected(g.scopes) : [])),
        3_000,
        [] as string[],
      )
    : Promise.resolve([] as string[])
  const composioConnectorFast = hired
    ? budget(composioConnected(user.id), 6_000, [] as string[])
    : Promise.resolve([] as string[])
  const [context, googleIds, composioIds, memories, active, vaultRows] = await Promise.all([
    hired ? loadContext(sql, user.id, persona) : Promise.resolve({} as Record<string, string>),
    googleConnectorFast,
    composioConnectorFast,
    hired ? budget(recallMemories(sql, user.id, persona, query, 40), 3_000, [] as MemoryRow[]) : Promise.resolve([] as MemoryRow[]),
    hired ? pickActiveLocation(sql, user.id).catch(() => null) : Promise.resolve(null),
    hired
      ? (sql`
          SELECT portal, origin FROM hire_vault_entries WHERE user_id = ${user.id}
          UNION
          SELECT exact_origin AS portal, label AS origin FROM vault_items_v2 WHERE user_id = ${user.id} AND revoked_at IS NULL
        `.catch(() => [])) as Promise<Array<{ portal: string; origin: string }>>
      : Promise.resolve([] as Array<{ portal: string; origin: string }>),
  ])
  /* One readable entry per vault item. This used to flatMap BOTH the exact
   * origin and the label, so a single saved login arrived as two strings — and
   * three saved logins read back as "https://campusnet.csuohio.edu, login,
   * https://campusnet.csuohio.edu, …" when the founder asked what was in his
   * vault. The host is what a person recognises; the label is the fallback for
   * a row whose origin is not a URL. */
  const vaultOrigins = [
    ...new Set(
      (vaultRows as Array<{ portal: string; origin: string }>)
        .map((r) => {
          const portal = String(r.portal || '').trim()
          try {
            return new URL(portal).hostname.replace(/^www\./, '').toLowerCase()
          } catch {
            return String(r.origin || portal || '').toLowerCase().trim()
          }
        })
        .filter(Boolean),
    ),
  ]

  // Merge: google IDs take precedence (already UI-named); composio slugs are aliased.
  const mergedSet = new Set<string>(googleIds)
  for (const slug of composioIds) {
    const ui =
      COMPOSIO_SLUG_ALIASES[slug] ||
      Object.entries(UI_TO_COMPOSIO).find(([, v]) => v === slug)?.[0]
    mergedSet.add(ui || slug)
  }
  const connectedRaw = [...mergedSet]
  const connected = connectedRaw.filter((id) => !PERSONA_DENIED[persona].has(id))
  let pro = false
  if (hired) {
    /* Free mode: a skipped signup has no subscription row and must still be a
     * full user. Everything that asks "is this person paid" reads this flag, so
     * the product stays whole without pretending a row exists. */
    if (!paymentsOn()) {
      pro = true
    } else if (isDemoUserId(user.id)) {
      // The demo never gets a fake subscription row — nothing pretend may look
      // paid — so pro is granted at the read instead.
      pro = true
    } else {
      const subs = (await sql`
        SELECT 1 FROM hire_subscriptions
        WHERE user_id = ${user.id} AND status IN ('active', 'trialing') LIMIT 1
      `) as unknown[]
      pro = subs.length > 0
    }
  }
  let lastInboundAt: string | null = null
  if (hired) {
    const inbound = await sql`
      SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
      WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
    `
    const at = (inbound[0] as { lastInboundAt: Date | null } | undefined)?.lastInboundAt
    lastInboundAt = at ? new Date(at).toISOString() : null
  }
  return {
    found: true,
    hired,
    context: {
      ...context,
      hasVault: vaultOrigins.length > 0 ? 'true' : 'false',
      vaultOrigins: JSON.stringify(vaultOrigins),
    },
    connected,
    vaultOrigins,
    memories,
    /* The saved home and work labels, when the user set them in the app. A
     * checkout run needs the shipping address ("reorder the coffee beans to my
     * home address"), and the wizard has been storing it all along — the live
     * payload simply never carried it, so the address could not reach a run goal
     * even with a stored login. */
    homeAddress: (await getLocation(sql, user.id, 'home').catch(() => null))?.label || null,
    workAddress: (await getLocation(sql, user.id, 'work').catch(() => null))?.label || null,
    /* Keys the account holder deleted, so the bot can drop them from its
     * container-local store instead of injecting them until recreation. */
    deletedKeys: (await sql`
      SELECT key FROM hire_memory_tombstones
      WHERE user_id = ${user.id} AND persona = ${persona} AND deleted_at > now() - interval '90 days'
    `
      .catch(() => [] as Array<{ key: string }>)
      .then((rows) => (rows as Array<{ key: string }>).map((r) => String(r.key).toLowerCase()))),
    email: user.email,
    phone: user.phone,
    name: user.name,
    timezone: user.timezone,
    userId: user.id,
    lastInboundAt,
    pro,
    location: active
      ? { kind: active.kind, label: locationLabel(active), label_text: active.label }
      : null,
  }
}










/** The cofounder morning brief: everything already in the tables that needs a
 * human eye this week. Empty sections are fine; silence means healthy. */
export type CofounderDigestPayload = {
  stalePipeline: Array<{ id: string; title: string; stage: string; daysSinceTouch: number }>
  duePromises: Array<{ id: string; title: string; dueAt: Date | null }>
  decisionsToRevisit: Array<{ id: string; decision: string; reviewAt: Date | null }>
  newPeople: Array<{ id: string; name: string; lastTouchAt: Date | null }>
  pipelineMoves: Record<string, number>
  noteReady: boolean
}

export async function cofounderDigest(
  sql: SQL,
  userId: string,
  _persona: string = 'cofounder',
): Promise<CofounderDigestPayload> {
  const stale = (await sql`
    SELECT id, title, stage, updated_at AS "updatedAt" FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at < now() - interval '10 days'
      AND stage NOT IN ('won', 'lost')
    ORDER BY updated_at ASC LIMIT 20
  `) as Array<{ id: string; title: string; stage: string; updatedAt: Date | string }>
  const promises = (await sql`
    SELECT id, title, due_at AS "dueAt" FROM hire_loops
    WHERE user_id = ${userId} AND status = 'open' AND due_at IS NOT NULL
      AND due_at <= now() + interval '72 hours'
    ORDER BY due_at ASC LIMIT 20
  `) as Array<{ id: string; title: string; dueAt: Date | string | null }>
  const revisits = (await sql`
    SELECT id, decision, review_at AS "reviewAt" FROM hire_decisions
    WHERE user_id = ${userId} AND status = 'open'
      AND review_at IS NOT NULL AND review_at <= now()
    ORDER BY review_at ASC LIMIT 20
  `) as Array<{ id: string; decision: string; reviewAt: Date | string | null }>
  const people = (await sql`
    SELECT id, name, last_touch_at AS "lastTouchAt" FROM hire_relationships
    WHERE user_id = ${userId}
      AND (last_touch_at IS NULL OR last_touch_at < now() - make_interval(days => cadence_days))
    ORDER BY last_touch_at ASC NULLS FIRST LIMIT 20
  `) as Array<{ id: string; name: string; lastTouchAt: Date | string | null }>
  const moves = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at >= now() - interval '7 days'
    GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const drafts = (await sql`
    SELECT count(*)::int AS n FROM hire_drafts
    WHERE user_id = ${userId} AND kind = 'investor' AND created_at >= date_trunc('month', now())
  `) as Array<{ n: number }>
  const asTime = (v: Date | string | null | undefined) => (v ? new Date(v as Date | string).getTime() : NaN)
  return {
    stalePipeline: stale.map((r) => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      daysSinceTouch: Math.max(0, Math.floor((Date.now() - asTime(r.updatedAt)) / 86_400_000)),
    })),
    duePromises: promises.map((r) => ({ id: r.id, title: r.title, dueAt: r.dueAt ? new Date(r.dueAt) : null })),
    decisionsToRevisit: revisits.map((r) => ({ id: r.id, decision: r.decision, reviewAt: r.reviewAt ? new Date(r.reviewAt) : null })),
    newPeople: people.map((r) => ({ id: r.id, name: r.name, lastTouchAt: r.lastTouchAt ? new Date(r.lastTouchAt) : null })),
    pipelineMoves: Object.fromEntries(moves.map((r) => [r.stage, Number(r.n)])),
    noteReady: Number(drafts[0]?.n || 0) === 0,
  }
}



/** Signed mini-app URL preview for iMessage OG. Real events and mail, not a slogan. */
export async function miniCardOgDescription(
  sql: SQL,
  token: string,
  persona: string,
  kind: string,
): Promise<string | null> {
  if (!isPersona(persona)) return null
  const tok = verifyMiniToken(token)
  if (!tok || tok.persona !== persona) return null
  const user = await getUserByPhone(sql, tok.phone)
  if (!user) return null
  try {
    if (kind === 'digest') {
      /* Through the cache, not around it. This runs to build the preview line for
       * the card Alpha is about to text — the same payload the link opens. Warming
       * it here is why tapping that link lands on a brief instead of building one. */
      const payload = (await digestCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'digest', () => digestPayload(sql, user, persona), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value?.payload
      if (!payload) return null
      return String(payload.preview || '').trim() || null
    }
    if (kind === 'pick_night') {
      const payload = (await eveningCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'pick_night', () => miniPayload(sql, user, persona, 'pick_night'), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value?.payload
      if (!payload) return null
      const sections = (payload as { sections?: Array<{ heading: string; items?: string[] }> }).sections || []
      const lines = sections
        .flatMap((s) => (s.items || []).slice(0, 3))
        .filter((item) => item && !/^no important mail$/i.test(item) && !/^nothing /i.test(item))
        .slice(0, 6)
      if (!lines.length) return 'No important mail'
      return lines.join('\n').slice(0, 320)
    }
    if (kind === 'vault') {
      return 'Encrypted credential access. Credentials are encrypted with your per-user key in OpenBao and restricted to the exact website you approve.'
    }
    /* Everything below previews the thing itself, not the app that holds it:
     * the draft, the promise, the charge. Each branch is one indexed read; a
     * user with no data yet falls through to the static app description. */
    const tz = user.timezone || 'America/Los_Angeles'
    const squish = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)
    if (kind === 'approve_send' || kind === 'approve_investor_note') {
      const draftKind = kind === 'approve_investor_note' ? 'investor' : 'email'
      const rows = (await sql`
        SELECT subject, to_addr AS "toAddr", body FROM hire_drafts
        WHERE user_id = ${user.id} AND status = 'pending' AND kind = ${draftKind}
        ORDER BY created_at DESC LIMIT 1
      `) as Array<{ subject: string; toAddr: string; body: string }>
      const draft = rows[0]
      if (!draft) return null
      const to = draft.toAddr ? ` to ${draft.toAddr}` : ''
      const line = squish(draft.body || '', 80)
      const head = draft.subject ? `“${draft.subject}”${to}` : `Draft${to}`
      return squish(`${head}${line ? ` — ${line}` : ''}`, 240)
    }
    if (kind === 'pick_slot') {
      const rows = (await sql`
        SELECT subject, start_at AS "startAt" FROM hire_drafts
        WHERE user_id = ${user.id} AND status = 'pending' AND kind = 'event' AND start_at <> ''
        ORDER BY created_at DESC LIMIT 1
      `) as Array<{ subject: string; startAt: string }>
      const hold = rows[0]
      if (!hold) return null
      const when = new Date(hold.startAt)
      if (Number.isNaN(when.getTime())) return null
      const label = when.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
      return `${hold.subject}: ${label}. Tap to confirm the hold.`
    }
    if (kind === 'open_loops') {
      const rows = (await sql`
        SELECT title, due_at AS "dueAt" FROM hire_loops
        WHERE user_id = ${user.id} AND status = 'open'
        ORDER BY due_at ASC NULLS LAST, created_at ASC LIMIT 3
      `) as Array<{ title: string; dueAt: Date | string | null }>
      const first = rows[0]
      if (!first) return 'Nothing owed right now.'
      const due = first.dueAt
        ? ` · due ${new Date(first.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}`
        : ''
      const count = rows.length === 1 ? 'One promise open' : `${rows.length} promises open`
      return squish(`${count}: ${first.title}${due}`, 200)
    }
    if (kind === 'networking_crm') {
      const rows = (await sql`
        SELECT name, last_touch AS "lastTouch", cadence_days AS "cadenceDays" FROM hire_network
        WHERE user_id = ${user.id}
        ORDER BY last_touch ASC NULLS FIRST LIMIT 1
      `) as Array<{ name: string; lastTouch: Date | string | null; cadenceDays: number }>
      const person = rows[0]
      if (!person) return null
      if (!person.lastTouch) return `${person.name}: no touch logged yet. Cadence is every ${person.cadenceDays} days.`
      const days = Math.max(0, Math.floor((Date.now() - new Date(person.lastTouch).getTime()) / 86_400_000))
      const lead = days >= person.cadenceDays ? 'Overdue' : 'Next up'
      return `${lead}: ${person.name} · last touch ${days}d ago.`
    }
    if (kind === 'spending_snapshot') {
      const rows = (await sql`
        SELECT description, amount FROM hire_spending
        WHERE user_id = ${user.id} AND spent_at >= now() - interval '7 days'
        ORDER BY spent_at DESC LIMIT 20
      `) as Array<{ description: string; amount: number }>
      if (!rows.length) return 'No charges logged this week.'
      const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      const latest = squish(rows[0]!.description || 'latest charge', 40)
      return `${rows.length} ${rows.length === 1 ? 'charge' : 'charges'} this week · $${Math.round(total)}. Last: ${latest}.`
    }
    if (kind === 'decision_ledger') {
      const rows = (await sql`
        SELECT decision, review_at AS "reviewAt" FROM hire_decisions
        WHERE user_id = ${user.id} AND status = 'open'
        ORDER BY created_at DESC LIMIT 1
      `) as Array<{ decision: string; reviewAt: Date | string | null }>
      const call = rows[0]
      if (!call) return null
      const review = call.reviewAt
        ? ` · revisit ${new Date(call.reviewAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}`
        : ''
      return squish(`${call.decision}${review}`, 200)
    }
    if (kind === 'pipeline_board') {
      const rows = (await sql`
        SELECT stage, count(*)::int AS n FROM hire_pipeline
        WHERE user_id = ${user.id} GROUP BY stage
      `) as Array<{ stage: string; n: number }>
      const byStage = Object.fromEntries(rows.map((row) => [row.stage, Number(row.n)]))
      const active = rows
        .filter((row) => row.stage !== 'won' && row.stage !== 'lost')
        .reduce((sum, row) => sum + Number(row.n), 0)
      if (!active) return 'Pipeline is clear.'
      const parts = [`${active} active`]
      if (byStage.interview) parts.push(`${byStage.interview} interviewing`)
      if (byStage.offer) parts.push(`${byStage.offer} at offer`)
      if (byStage.won) parts.push(`${byStage.won} won`)
      return `${parts.join(' · ')}.`
    }
    if (kind === 'meeting_mode') {
      const rows = (await sql`
        SELECT title, starts_at AS "startsAt" FROM hire_meetings
        WHERE user_id = ${user.id} AND phase <> 'done' AND starts_at >= now() - interval '30 minutes'
        ORDER BY starts_at ASC LIMIT 1
      `) as Array<{ title: string; startsAt: Date | string }>
      const next = rows[0]
      if (!next) return null
      const mins = Math.round((new Date(next.startsAt).getTime() - Date.now()) / 60_000)
      const inLabel = mins <= 0 ? 'now' : mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 60)}h`
      return squish(`${next.title}, ${inLabel}. Agenda and the last thread are ready.`, 200)
    }
    if (kind === 'drop_zone' || kind === 'later') {
      if (kind === 'drop_zone') {
        const rows = (await sql`
          SELECT content FROM hire_dropzone
          WHERE user_id = ${user.id} AND status = 'new'
          ORDER BY created_at DESC LIMIT 1
        `) as Array<{ content: string }>
        const drop = rows[0]
        if (!drop) return null
        return squish(`Waiting: ${drop.content}`, 180)
      }
      const rows = (await sql`
        SELECT status, count(*)::int AS n FROM hire_dropzone WHERE user_id = ${user.id} GROUP BY status
      `) as Array<{ status: string; n: number }>
      const unsorted = Number(rows.find((row) => row.status === 'new')?.n || 0)
      const filed = rows.filter((row) => row.status !== 'new').reduce((sum, row) => sum + Number(row.n), 0)
      if (!unsorted && !filed) return null
      return `${unsorted} waiting to sort · ${filed} filed.`
    }
    if (kind === 'learning_queue') {
      const rows = (await sql`
        SELECT title FROM hire_learning
        WHERE user_id = ${user.id} AND status = 'queued'
        ORDER BY created_at DESC LIMIT 1
      `) as Array<{ title: string }>
      const queued = rows[0]
      if (!queued) return null
      return squish(`Next up: ${queued.title}`, 180)
    }
    if (kind === 'weekly_review') {
      const rows = (await sql`
        SELECT done_text AS "doneText", slipped_text AS "slippedText", focus_text AS "focusText"
        FROM hire_weekly_reviews WHERE user_id = ${user.id}
        ORDER BY week_start DESC LIMIT 1
      `) as Array<{ doneText: string; slippedText: string; focusText: string }>
      const week = rows[0]
      if (!week) return null
      const line = squish(week.focusText || week.doneText || week.slippedText || '', 180)
      return line || null
    }
    if (kind === 'hire_decision') {
      const rows = (await sql`
        SELECT title, stage FROM hire_pipeline
        WHERE user_id = ${user.id} AND kind = 'candidate' AND stage NOT IN ('won', 'lost')
        ORDER BY updated_at DESC LIMIT 1
      `) as Array<{ title: string; stage: string }>
      const candidate = rows[0]
      if (!candidate) return null
      return `${candidate.title} sits at ${candidate.stage}. The case for and against is in here.`
    }
  } catch (err) {
    console.warn('[mini] og preview failed', err)
  }
  return null
}

/** All personal routes share this boundary, including legacy email-only handlers. */
export async function handleHireApi(req: Request, sql: SQL | null): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  const publicPaths = new Set([
    '/api/waitlist', '/api/auth/google', '/api/auth/ticket', '/api/auth/register', '/api/auth/login',
    '/api/oauth/google/callback', '/api/billing/webhook', '/api/billing/checkout',
    '/api/assigned-phone', '/api/contact/alpha.vcf', '/api/connectors/status', '/api/status',
    '/api/invites/redeem', '/api/wishlist', '/api/payments/spend/approve', '/api/config',
  ])
  if (path === '/api/auth/logout') {
    const res = await handleAuthRoutes(req, (sql || {}) as SQL)
    if (res) return res
  }
  const browserRes = await handleBrowserRoutes(req, sql, { internalOk })
  if (browserRes) return browserRes
  const cancelWorkRes = await handleCancelWorkRoutes(req, sql, { internalOk })
  if (cancelWorkRes) return cancelWorkRes
  const planRes = await handlePlanRoutes(req, sql, { internalOk })
  if (planRes) return planRes

  if (!path.startsWith('/api/') || publicPaths.has(path) || req.method === 'OPTIONS') {
    return handleAuthorizedHireApi(req, sql)
  }
  if (path.startsWith('/api/internal/') || path.startsWith('/api/admin/')) {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    return handleAuthorizedHireApi(req, sql)
  }
  let body: Record<string, unknown> = {}
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const parsed = await req.clone().json().catch(() => null)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  }
  const cookie = (req.headers.get('cookie') || '').split(';').map((v) => v.trim()).find((v) => v.startsWith('hirealpha_session='))?.slice('hirealpha_session='.length)
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const explicitSession = (body as { session?: string }).session || url.searchParams.get('s') || bearer
  const session = String(explicitSession || cookie || '')
  const token = String(body.token || url.searchParams.get('t') || '')
  const ses = session ? verifySessionToken(session) : null
  const mini = token ? verifyMiniToken(token) : null
  if ((explicitSession && !ses) || (token && !mini) || (!ses && !mini)) return json({ error: 'Sign in required', code: 'session_invalid' }, 401)
  const origin = req.headers.get('origin')
  if (origin && !['GET', 'HEAD'].includes(req.method) && origin !== new URL(appBase(req)).origin) {
    // The dev proxy (vite on localhost) forwards the browser's Origin header
    // verbatim, so every POST from the local dev server 403'd here even with a
    // valid session. Localhost origins are safe to allow: the session cookie is
    // host-scoped to the real domain, so a localhost page can never carry it.
    const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    if (!localhostOrigin) return json({ error: 'Origin not allowed' }, 403)
  }
  if (!sql) return json({ error: 'Database unavailable' }, 503)
  const miniUser = mini ? await getUserByPhone(sql, mini.phone) : null
  const email = ses?.email || miniUser?.email
  if (!email || (ses && miniUser && ses.email !== miniUser.email)) return json({ error: 'Invalid account identity' }, 403)
  for (const requested of [url.searchParams.get('email'), body.email]) {
    if (requested && String(requested).trim().toLowerCase() !== email) return json({ error: 'Account mismatch' }, 403)
  }
  // These legacy endpoints select the owner by phone rather than account ID.
  if (path === '/api/kill-switch' || path === '/api/actions' || path.startsWith('/api/invites/') || /^\/api\/loops\/[^/]+\/(?:pause|resume)$/.test(path) || (path === '/api/loops' && url.searchParams.has('phone'))) {
    const rawPhone = String(body.phone || url.searchParams.get('phone') || '')
    const phone = normalizePhone(rawPhone)
    if (rawPhone && !phone) return json({ error: 'valid phone required' }, 400)
    const owner = miniUser || await getUserByEmail(sql, email)
    if (!owner || (phone && phone !== normalizePhone(owner.phone || ''))) return json({ error: 'Account mismatch' }, 403)
  }
  url.searchParams.set('email', email)
  const headers = new Headers(req.headers)
  headers.delete('content-length')
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const forwarded = new Request(url, { method: req.method, headers, ...(hasBody ? { body: JSON.stringify({ ...body, email }) } : {}) })
  return requestIdentity.run({ email }, async () => {
    if (path === '/api/auth/session') {
      return json({ email, ...(miniUser?.phone ? { phone: miniUser.phone } : {}) })
    }
    return handleAuthorizedHireApi(forwarded, sql)
  })
}

async function handleAuthorizedHireApi(req: Request, sql: SQL | null): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  // /b/ serves deployed builds, /a/ their legacy files — both are API-owned
  // routes that live outside the /api/ prefix.
  if (!path.startsWith('/api/') && !path.startsWith('/b/') && !path.startsWith('/a/')) return null
  if (path === '/api/waitlist') return null

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    })
  }

  if (!sql) return json({ error: 'Database unavailable' }, 503)

  if (path.startsWith('/api/billing/') || path === '/api/internal/subscriptions' || path === '/api/admin/grant-premium') {
    const res = await handleBillingRoutes(req, sql, { internalOk, livePayload, ensureMemoryConsent })
    if (res) return res
  }

  if (path.startsWith('/api/internal/loops') || path.startsWith('/api/loops') || path === '/api/internal/commitments') {
    const res = await handleLoopRoutes(req, sql, { internalOk })
    if (res) return res
  }

  const habitRes = await handleHabitRoutes(req, sql, { internalOk })
  if (habitRes) return habitRes

  const nudgeRes = await handleNudgeRoutes(req, sql, {
    internalOk,
    dueEventNudges,
    collectEventNudgesForUser,
  })
  if (nudgeRes) return nudgeRes

  const workshopRes = await handleWorkshopRoutes(req, sql, { internalOk })
  if (workshopRes) return workshopRes

  const inviteRes = await handleInviteRoutes(req, sql, { internalOk })
  if (inviteRes) return inviteRes

  const reviewRes = await handleReviewRoutes(req, sql, { internalOk, livePayload, buildWeekBundle })
  if (reviewRes) return reviewRes

  const pipelineRes = await handlePipelineRoutes(req, sql, { internalOk })
  if (pipelineRes) return pipelineRes

  const networkRes = await handleNetworkRoutes(req, sql, {
    internalOk,
    loadTodayMeets: (u, p) =>
      todayMeetsCache
        .read(`${u.id}|${p}`, () => todayCalendarMeets(sql, u, p as Persona))
        .then((r) => r.value ?? EMPTY_TODAY_RESULT),
    connectedForUser,
    touchInbound,
  })
  if (networkRes) return networkRes

  const taskRes = await handleTaskRoutes(req, sql, { internalOk })
  if (taskRes) return taskRes

  const anchorRes = await handleAnchorRoutes(req, sql, { internalOk })
  if (anchorRes) return anchorRes

  const workRes = await handleWorkRoutes(req, sql, {
    internalOk,
    connectedForUser,
    livePayload,
  })
  if (workRes) return workRes

  const mailRes = await handleMailRoutes(req, sql, { internalOk })
  if (mailRes) return mailRes

  const digestRes = await handleDigestRoutes(req, sql, {
    internalOk,
    connectedForUser,
    digestPayload,
    miniPayload,
    cofounderDigest,
    digestCache,
    eveningCache,
    todayMeetsCache,
    briefLoader,
    prewarmHomeWorld,
    armPokes,
    ensureJudgeTick,
    judgmentStatePayload,
  })
  if (digestRes) return digestRes

  const homeRes = await handleHomeRoutes(req, sql, {
    loadHomeWorld,
    homeWorldCache,
    workoutTodayLabel,
  })
  if (homeRes) return homeRes

  const setupRes = await handleSetupRoutes(req, sql)
  if (setupRes) return setupRes

  const learningRes = await handleLearningRoutes(req, sql, { internalOk })
  if (learningRes) return learningRes

  const decisionRes = await handleDecisionRoutes(req, sql, { internalOk })
  if (decisionRes) return decisionRes

  const dropzoneRes = await handleDropzoneRoutes(req, sql)
  if (dropzoneRes) return dropzoneRes

  const meetingRes = await handleMeetingRoutes(req, sql, { internalOk })
  if (meetingRes) return meetingRes

  const reminderRes = await handleReminderRoutes(req, sql, { internalOk })
  if (reminderRes) return reminderRes

  const memoryRes = await handleMemoryRoutes(req, sql, { internalOk, rememberUserTimezone })
  if (memoryRes) return memoryRes

  const mediaRes = await handleMediaRoutes(req, sql, { internalOk })
  if (mediaRes) return mediaRes

  const cofounderRes = await handleCofounderRoutes(req, sql, { internalOk })
  if (cofounderRes) return cofounderRes

  const corpusRes = await handleCorpusRoutes(req, sql, { internalOk })
  if (corpusRes) return corpusRes

  const miniRes = await handleMiniRoutes(req, sql, { internalOk, miniPayload, eveningCache, briefLoader })
  if (miniRes) return miniRes

  const trustRes = await handleTrustApi(req, sql, {
    resolveUser: async (db, r) => {
      const q = new URL(r.url).searchParams
      const { user } = await resolveAuthedUser(db, {
        token: q.get('t') || undefined,
        session: q.get('s') || undefined,
        email: q.get('email') || undefined,
      })
      return user ? { id: user.id } : null
    },
    keyBroker: openBaoBrokerFromEnv() || userKeyBrokerFromEnv(),
    memoryIndex: getMemoryIndex(),
  })
  if (trustRes) return trustRes

  // Credential vault, browser approval gates, and the internal browser task
  // endpoint. Returns null for paths it does not own so the chain below keeps
  // dispatching.
  const vaultRes = await handleVaultApi(req, sql, {
    resolveUser: async (db, r) => {
      const q = new URL(r.url).searchParams
      let bodyToken: string | undefined
      let bodySession: string | undefined
      let bodyEmail: string | undefined
      let bodyPersona: string | undefined
      if (r.method !== 'GET' && r.method !== 'HEAD') {
        try {
          const cloned = await r.clone().json()
          if (cloned && typeof cloned === 'object') {
            bodyToken = typeof cloned.token === 'string' ? cloned.token : undefined
            bodySession = typeof cloned.session === 'string' ? cloned.session : undefined
            bodyEmail = typeof cloned.email === 'string' ? cloned.email : undefined
            bodyPersona = typeof cloned.persona === 'string' ? cloned.persona : undefined
          }
        } catch {}
      }
      const { user } = await resolveAuthedUser(db, {
        token: q.get('t') || bodyToken || undefined,
        session: q.get('s') || bodySession || undefined,
        email: q.get('email') || bodyEmail || undefined,
      })
      if (!user) return null
      const persona = q.get('persona') || bodyPersona || 'friend'
      return { id: user.id, persona: (PERSONAS as readonly string[]).includes(persona) ? persona : 'friend' }
    },
    internalOk,
    launch: runPortalTask,
    keyBroker: openBaoBrokerFromEnv() || userKeyBrokerFromEnv(),
  })
  if (vaultRes) return vaultRes

  // Per-user wallet connect + spend approvals (user's own card; the operator
  // never funds purchases). Same resolveUser shape as the vault mount.
  const paymentsRes = await handleUserPaymentsApi(req, sql, {
    resolveUser: async (db, r) => {
      const q = new URL(r.url).searchParams
      const { user } = await resolveAuthedUser(db, {
        token: q.get('t') || undefined,
        session: q.get('s') || undefined,
        email: q.get('email') || undefined,
      })
      return user ? { id: user.id } : null
    },
    internalOk,
    livePayload,
  })
  if (paymentsRes) return paymentsRes

  const meRes = await handleMeRoutes(req, sql, {
    connectedForUser,
    registerPhotonUser,
    photonAssignedNumber,
    enqueueIntro,
    armMorningBrief,
    loadRoster,
    hireIsLive,
    rememberUserTimezone,
  })
  if (meRes) return meRes

  if (path.startsWith('/api/auth/')) {
    const res = await handleAuthRoutes(req, sql!, {
      onUserRegistered: async (s, user) => {
        if (user.phone) {
          try {
            await ensurePhoneUser(s, user.phone, 'friend', user.name || undefined)
          } catch (err) {
            console.warn('[hire] auto-hire after register failed', err)
          }
        }
      },
    })
    if (res) return res
  }



  const connectorRes = await handleConnectorRoutes(req, sql, {
    armMorningBrief,
    armCalendarDefense,
  })
  if (connectorRes) return connectorRes

  const liveRes = await handleLiveRoutes(req, sql, {
    internalOk,
    livePayload,
    loadRoster,
    connectedForUser,
    rememberUserTimezone,
    runToolsForMessage,
  })
  if (liveRes) return liveRes

  const proposalRes = await handleProposalRoutes(req, sql, {
    internalOk,
    livePayload,
    gmailReplyMeta,
  })
  if (proposalRes) return proposalRes

  if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404)
  return null
}
