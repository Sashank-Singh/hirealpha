import { extractJsonObject, extractNumericFields, stripReasoning } from '../modelJson'

export function isClock(v: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(v.trim()) && (() => {
    const [h, m] = v.trim().split(':').map(Number)
    return (h || 0) <= 23 && (m || 0) <= 59
  })()
}

export function toHHMM(raw: string, mer: string | undefined): string | null {
  const [hPart, mPart] = raw.split(':')
  let h = Number(hPart)
  const m = Number(mPart || '0')
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const merL = (mer || '').toLowerCase()
  if (merL === 'pm' && h < 12) h += 12
  if (merL === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function sleepHoursBetween(bedtime: string, wake: string): number {
  const [bh, bm] = bedtime.split(':').map(Number)
  const [wh, wm] = wake.split(':').map(Number)
  if ([bh, bm, wh, wm].some((n) => Number.isNaN(n))) return 0
  let mins = (wh || 0) * 60 + (wm || 0) - ((bh || 0) * 60 + (bm || 0))
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

export function parseWorkoutText(text: string): { exercise: string; sets: number; reps: number; weight: number } | null {
  const t = text.replace(/[’']/g, "'").trim()
  const patterns: Array<RegExp> = [
    /(?:log|track|logged)?\s*(?:my\s+)?(?:workout|lift|gym)?\s*(.+?)\s+(\d+)\s*[x×]\s*(\d+)(?:\s*[x×@]\s*|\s+@\s*|\s+at\s+|\s+)(\d+(?:\.\d+)?)(?:\s*(?:lbs?|pounds?))?\s*$/i,
    /(\d+)\s*[x×]\s*(\d+)\s+(?:on\s+|of\s+)?(.+?)\s+(?:@|at)\s+(\d+(?:\.\d+)?)/i,
    /(.+?)\s+(\d+)\s*sets?\s*(?:of\s*)?(\d+)\s*(?:reps?)?\s*(?:@|at|x)\s*(\d+(?:\.\d+)?)/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (!m) continue
    let exercise: string
    let sets: number
    let reps: number
    let weight: number
    if (re === patterns[1]) {
      sets = Number(m[1])
      reps = Number(m[2])
      exercise = String(m[3] || '')
      weight = Number(m[4])
    } else {
      exercise = String(m[1] || '')
      sets = Number(m[2])
      reps = Number(m[3])
      weight = Number(m[4])
    }
    exercise = exercise
      .replace(/^(log|track|logged)\s+(my\s+)?(workout|lift|gym)?\s*/i, '')
      .replace(/\b(workout|lift|gym)\b/gi, '')
      .trim()
    if (exercise.length < 2 || !sets || !reps) continue
    return {
      exercise: exercise.slice(0, 80),
      sets: Math.max(1, Math.min(20, Math.round(sets))),
      reps: Math.max(1, Math.min(100, Math.round(reps))),
      weight: Math.max(0, weight || 0),
    }
  }
  const free = t.replace(/^(?:log|track|logged)\s+(?:my\s+)?/i, '').trim()
  if (
    free.length >= 4 &&
    /\b(?:min|mins|minutes|hr|hrs|hour|lifting|lift|gym|run|ran|cycle|swim|yoga|cardio|chest|back|legs|shoulders|arms|triceps|biceps|glutes|core|deadlift|squat|bench|pullup|pull-up|rowing|elliptical)\b/i.test(
      free,
    )
  ) {
    return { exercise: free.slice(0, 80), sets: 0, reps: 0, weight: 0 }
  }
  return null
}

export function parseSleepText(text: string): { bedtime: string; wake: string } | null {
  const m = text.match(
    /(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/i,
  )
  if (!m) return null
  let bedtime = toHHMM(m[1]!, m[2])
  let wake = toHHMM(m[3]!, m[4])
  if (!bedtime || !wake) return null
  if (!m[2] && !m[4]) {
    const bh = Number(m[1]!.split(':')[0])
    const wh = Number(m[3]!.split(':')[0])
    if (bh <= 12 && bh >= 8) bedtime = toHHMM(m[1]!, 'pm') || bedtime
    if (wh <= 11) wake = toHHMM(m[3]!, 'am') || wake
  }
  return { bedtime, wake }
}

export function sleepFromHours(
  text: string,
  usualBedtime: string,
): { bedtime: string; wake: string } | null {
  const m = text.match(
    /(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b|\b(?:slept|got|about|roughly|around|only)\s+(\d{1,2}(?:\.\d)?)\b|(?:^|\s)(\d{1,2}(?:\.\d)?)\s*$/i,
  )
  const raw = m?.[1] || m?.[2] || m?.[3]
  if (!raw) return null
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 16) return null
  const bedtime = isClock(usualBedtime) ? usualBedtime : '23:00'
  const [bh, bm] = bedtime.split(':').map(Number)
  const totalMin = Math.round(hours * 60)
  let wakeMin = bh * 60 + bm + totalMin
  if (wakeMin >= 24 * 60) wakeMin -= 24 * 60
  const p = (n: number) => String(n).padStart(2, '0')
  return { bedtime, wake: `${p(Math.floor(wakeMin / 60))}:${p(wakeMin % 60)}` }
}

export function parseGratitudeText(text: string): string | null {
  const m = text.match(/(?:i(?:'m| am)\s+)?grateful(?:\s+for)?\s*[:-]?\s*(.+)$/i)
  const sentence = String(m?.[1] || '').trim().replace(/[.!?]+$/, '')
  if (sentence.length < 2) return null
  return sentence.slice(0, 280)
}

export const MOOD_EMOJI_MAP: Array<[RegExp, string, number]> = [
  [/😄|:\)+$|:D|great|awesome|amazing|good!/, '😄', 5],
  [/🙂|:\)|good|fine|okay|ok$|alright/, '🙂', 4],
  [/😐|meh|neutral|blah/, '😐', 3],
  [/😔|:\(|sad|down|tired|exhausted|rough|bad|shitty|meh\s.*day/, '😔', 2],
  [/😤|angry|frustrated|annoyed|pissed|stressed/, '😤', 2],
]

export function parseMoodReply(text: string): { emoji: string; energy: number; note: string | null } | null {
  const clean = String(text || '').trim()
  if (!clean) return null
  for (const [re, emoji, energy] of MOOD_EMOJI_MAP) {
    if (re.test(clean)) return { emoji, energy, note: clean.length > 4 ? clean.slice(0, 200) : null }
  }
  return null
}

export const SPEND_CATEGORIES = ['food', 'transport', 'subscriptions', 'housing', 'health', 'shopping', 'fun', 'other'] as const

export function parseSpendText(text: string): { amount: number; category: string; description: string } | null {
  const m = text.match(/\$\s*(\d+(?:\.\d{1,2})?)|(?:spent|spend|paid|cost)\s+\$?\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:bucks|dollars)/i)
  const amount = Number(m?.[1] || m?.[2] || m?.[3])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const lower = text.toLowerCase()
  let category = 'other'
  if (/\b(food|lunch|dinner|breakfast|coffee|uber\s*eats|doordash|restaurant|snack|grocer)/.test(lower)) category = 'food'
  else if (/\b(uber|lyft|gas|transit|train|bus|parking|taxi|flight|airline)/.test(lower)) category = 'transport'
  else if (/\b(netflix|spotify|subscription|prime|icloud|patreon|hulu|chatgpt)/.test(lower)) category = 'subscriptions'
  else if (/\b(rent|mortgage|housing|utilities|electric|water|gas\s*bill|wifi|internet)/.test(lower)) category = 'housing'
  else if (/\b(health|doctor|dentist|copay|meds|medicine|pharmacy|prescription|therapy|clinic|hospital|dental|vitamin)/.test(lower)) category = 'health'
  else if (/\b(shopping|clothes|shoes|amazon|haircut|salon|cosmetics|electronics|retail|bought|mall|target)/.test(lower)) category = 'shopping'
  else if (/\b(fun|movie|game|bar|drinks|concert|party|club)/.test(lower)) category = 'fun'
  const description = text.replace(/^(log|track|logged)\s+(my\s+)?(spend|spending|expense)?\s*/i, '').trim().slice(0, 160)
  return { amount, category, description }
}

export const PIPELINE_STAGES = ['lead', 'active', 'interview', 'offer', 'won', 'lost'] as const

export function parsePipelineText(text: string): { title: string; stage: string; notes?: string; existing?: boolean } | null {
  const t = String(text || '')
    .replace(/[’']/g, "'")
    .trim()
  const STAGE_RAW: Array<[RegExp, string]> = [
    [/lead/, 'lead'], [/active/, 'active'], [/interview/, 'interview'], [/offer/, 'offer'], [/won/, 'won'], [/lost/, 'lost'],
  ]
  const stage = STAGE_RAW.find(([re]) => re.test(t))?.[1]
  if (!stage) return null

  const move = t.match(/\b(?:move|push|advance|add|put)\s+(.+?)\s+(?:to|into|as|at)\s+(?:the\s+)?(?:stage\s+)?(?:lead|active|interview|offer|won|lost)\b/i)
  let title = move?.[1]?.trim().replace(/["“”]/g, '').replace(/\s*[->]+\s*.*$/, '')
  if (!title) {
    const arrow = t.match(/^(.+?)\s*[->→]\s*(?:lead|active|interview|offer|won|lost)\b/i)
    title = arrow?.[1]?.trim()
  }
  if (!title) return null
  const notes = t.match(/,\s*(.+)$/i)?.[1]?.trim() || undefined
  const existing = /\b(?:move|push|advance|far|onto)\b/i.test(t)
  return { title, stage, notes, existing }
}

export function parseDecisionText(text: string): { decision: string; reason?: string; owner?: string; review?: string } | null {
  const t = String(text || '')
    .replace(/[’']/g, "'")
    .trim()
    .replace(/^(?:log|record|keep|make)\s+(?:this|that|a|the)?\s*decision\s*[:.,-]?\s*/i, '')
    .replace(/^we\s+(?:decided|made the call|went with)\s*[:.,-]?\s*/i, '')
  if (!t) return null
  let decision = t
  let reason: string | undefined
  let owner: string | undefined
  let review: string | undefined

  const own = t.match(/\b(?:owner|owned by)\s+([\w]+)/i) || t.match(/\b([\w]+)\s+(?:owns|to do|will own)\b/i)
  if (own) owner = own[1]!

  const rev = t.match(/\breview\s+(.+)$/i)
  if (rev) review = rev[1]!.trim()

  const m = decision.match(/^(.*?)(?:\s*[.,;：]\s+|\s+because\s+|\s+since\s+)(.*)$/i)
  if (m && m[2]!.trim()) {
    decision = m[1]!.trim()
    reason = m[2]!.trim()
  }

  decision = decision.replace(/\b(?:owner\s+[\w]+|[\w]+\s+owns\s+it|[\w]+\s+will own)\b/gi, '').trim()
  if (!decision) return null
  return { decision, reason, owner, review }
}

export function clampNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : Math.max(0, Math.round(fallback))
}

export const CALORIE_FOOD_RE = /\b(food|meal|diet|snack|lunch|dinner|breakfast|soda|juice|shake|milk|burger|pizza|pasta|rice|bread|salad|soup|smoothie|steak|fries|chip|cheese|sandwich|taco|burrito|wrap|plate|bowl|dish|chicken|beef|pork|lamb|meat|protein|tofu|beans|lentil|paneer|yogurt|egg|salmon|tuna|shrimp|turkey|fish|noodle|curry|stew|oats|cereal|fruit|vegetable|veggie)\b/i

export function nutritionModelConfig() {
  const apiKey =
    process.env.NUTRITION_API_KEY ||
    process.env.GMI_API_KEY ||
    process.env.HIREALPHA_API_KEY
  if (!apiKey) return null
  const baseUrl = (
    process.env.NUTRITION_BASE_URL ||
    process.env.GMI_BASE_URL ||
    'https://api.gmi-serving.com/v1'
  ).replace(/\/$/, '')
  const textModel = process.env.NUTRITION_MODEL || process.env.GMI_MODEL || 'zai-org/GLM-5.3-Flash'
  const visionModel = process.env.NUTRITION_VISION_MODEL || 'zai-org/GLM-5.3-Flash'
  // Provider IDs are case-sensitive even when they name the same model.
  const providerModel = (model: string) => {
    if (model.toLowerCase() !== 'zai-org/glm-5.3-flash') return model
    const host = new URL(baseUrl).hostname
    if (host === 'api.novita.ai') return 'zai-org/glm-5.3-flash'
    if (host === 'openrouter.ai') return 'z-ai/glm-5.3-flash'
    return model
  }
  return { apiKey, baseUrl, textModel: providerModel(textModel), visionModel: providerModel(visionModel) }
}

export function imageMimeFromBase64(base64: string): string {
  const head = base64.slice(0, 32)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  try {
    const b = Buffer.from(base64.slice(0, 24), 'base64')
    if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'image/heic'
  } catch {
    /* fall through */
  }
  return 'image/unknown'
}

export function isDecodableImage(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif'
}

export function salvageMacros(text: string): { calories: number; protein: number; carbs: number; fat: number } | null {
  const nums = extractNumericFields(text, ['calories', 'protein', 'carbs', 'fat'])
  if (!['calories', 'protein', 'carbs', 'fat'].every((key) => Number.isFinite(nums[key]) && nums[key]! >= 0)) return null
  return { calories: nums.calories!, protein: nums.protein ?? 0, carbs: nums.carbs ?? 0, fat: nums.fat ?? 0 }
}

export async function estimateNutrition(
  description: string,
  imageBase64: string,
): Promise<{
  ok: boolean
  needsKey?: boolean
  calories?: number
  protein?: number
  carbs?: number
  fat?: number
  guess?: string
  error?: string
}> {
  const cfg = nutritionModelConfig()
  if (!cfg) return { ok: false, needsKey: true }
  if (!description.trim() && !imageBase64) return { ok: false, error: 'Describe or photograph the meal first.' }

  const mime = imageBase64 ? imageMimeFromBase64(imageBase64) : ''
  const decodable = !imageBase64 || isDecodableImage(mime)
  if (imageBase64 && !decodable && (!description.trim() || /^(meal from photo|estimate the macros.*)$/i.test(description.trim()))) {
    return { ok: false, error: 'Photo format (e.g. HEIC) needs a caption — tell me what it was.' }
  }

  const system =
    'You are an expert nutrition and macronutrient estimator. ' +
    'Estimate total macronutrients for ALL foods and portions described or pictured. Use one serving only when no portion is provided. ' +
    'Reply with JSON ONLY in this format: {"guess":"<short dish name>","calories":N,"protein":N,"carbs":N,"fat":N}. ' +
    'protein/carbs/fat are in grams, calories is in kcal. ' +
    'Guidelines: ' +
    '1. guess: Clean, specific, appetizing name (e.g. "Chicken and Rice Bowl", "2 Scrambled Eggs with Toast"). Never output placeholders like "meal" or "meal from photo". ' +
    '2. All five fields MUST be present: guess is a string; calories, protein, carbs, and fat are non-negative numbers. ' +
    '3. Total calories must be approximately consistent with macros: (protein * 4) + (carbs * 4) + (fat * 9). ' +
    '4. NEVER report 0 protein for dishes with meat, poultry, fish, eggs, dairy, beans, or tofu. ' +
    '5. NEVER report 0 fat unless the item is genuinely fat-free (e.g. black coffee, plain apple, diet soda). ' +
    'Print the JSON object and nothing else — no prose, no markdown fences.'

  const cleanDesc = description.trim()
  const isGenericDesc = !cleanDesc || /^(meal from photo|estimate the macros.*)$/i.test(cleanDesc)
  const promptText = isGenericDesc
    ? 'Estimate the single-serving macros of this meal.'
    : cleanDesc

  const userContent: unknown[] = imageBase64 && decodable
    ? [
        { type: 'text', text: isGenericDesc ? 'Analyze the attached photo of food and estimate its single-serving macros.' : `Analyze this food photo. Description: ${cleanDesc}` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
      ]
    : [{ type: 'text', text: promptText }]

  const visionCandidates = Array.from(new Set([cfg.visionModel])).filter((m): m is string => Boolean(m))
  const textCandidates = Array.from(new Set([cfg.textModel])).filter((m): m is string => Boolean(m))

  // Bound the entire estimate below the caller's 25-second timeout.
  const signal = AbortSignal.timeout(20_000)
  const attempt = async (m: string, parts: unknown[]) => {
    let lowReasoning = /glm-5\.3-flash/i.test(m)
    for (let tryCount = 0; tryCount < 2; tryCount++) {
      try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
            'User-Agent': 'HireAlpha/0.1 (nutrition)',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: m,
            temperature: 0,
            ...(lowReasoning ? new URL(cfg.baseUrl).hostname === 'openrouter.ai'
              ? { reasoning: { effort: 'low' } }
              : { reasoning_effort: 'low' } : {}),
            max_tokens: tryCount === 0 ? 4096 : 8192,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: parts },
            ],
          }),
        })
        if (!res.ok) {
          if (res.status === 400 && lowReasoning && tryCount === 0) {
            lowReasoning = false
            continue
          }
          if ((res.status === 429 || res.status >= 500) && tryCount === 0) {
            await new Promise((r) => setTimeout(r, 600))
            continue
          }
          console.warn(`[nutrition] Model ${m} returned HTTP ${res.status}`)
          return null
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
        }
        // Never count the model's unfinished scratchpad as a final estimate.
        const content = stripReasoning(data.choices?.[0]?.message?.content || '')
        const parsed = extractJsonObject(content, ['calories', 'protein', 'carbs', 'fat'])
        const rawMacros = parsed && ['calories', 'protein', 'carbs', 'fat'].every((key) =>
          (typeof parsed[key] === 'number' || (typeof parsed[key] === 'string' && String(parsed[key]).trim() !== '')) &&
          Number.isFinite(Number(parsed[key])) && Number(parsed[key]) >= 0)
          ? {
              calories: clampNum(parsed.calories),
              protein: clampNum(parsed.protein),
              carbs: clampNum(parsed.carbs),
              fat: clampNum(parsed.fat),
            }
          : salvageMacros(content)
        if (!rawMacros) {
          // Empty/truncated reasoning completions are retryable too.
          if (tryCount === 0 && !signal.aborted) continue
          return null
        }
        return { macros: rawMacros, guess: String(parsed?.guess || '').trim() }
      } catch (err) {
        if (tryCount === 0 && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 600))
          continue
        }
        console.warn(`[nutrition] Model ${m} fetch error:`, err)
        return null
      }
    }
    return null
  }

  let hit: { macros: { calories: number; protein: number; carbs: number; fat: number }; guess: string } | null = null

  if (imageBase64 && decodable) {
    for (const vm of visionCandidates) {
      hit = await attempt(vm, userContent)
      if (hit && (hit.macros.calories > 0 || hit.macros.protein > 0 || hit.macros.carbs > 0 || hit.macros.fat > 0)) break
    }
  }

  if (!hit && (!imageBase64 || !isGenericDesc)) {
    const textParts = [{ type: 'text', text: promptText }]
    for (const tm of textCandidates) {
      hit = await attempt(tm, textParts)
      if (hit) break
    }
  }

  if (!hit) {
    return { ok: false, error: 'The nutrition estimator could not return a complete estimate. Please try again.' }
  }

  let { calories, protein, carbs, fat } = hit.macros
  const computedCalories = protein * 4 + carbs * 4 + fat * 9

  if (calories <= 0 && computedCalories > 0) {
    calories = Math.round(computedCalories)
  }

  if (calories > 40 && protein === 0 && carbs === 0 && fat === 0 && CALORIE_FOOD_RE.test(cleanDesc || hit.guess)) {
    protein = Math.round((calories * 0.25) / 4)
    carbs = Math.round((calories * 0.50) / 4)
    fat = Math.round((calories * 0.25) / 9)
  }

  if (calories > 0 && computedCalories > 0) {
    const diff = Math.abs(calories - computedCalories) / calories
    if (diff > 0.4) {
      calories = Math.round(computedCalories)
    }
  }

  let cleanGuess = hit.guess || ''
  const isPlaceholder =
    !cleanGuess ||
    /^(meal|food|meal from photo|photo|dish|snack|estimate the macros.*)$/i.test(cleanGuess.trim())
  if (isPlaceholder) {
    cleanGuess = !isGenericDesc ? cleanDesc.slice(0, 60) : 'Meal'
  }

  return {
    ok: true,
    guess: cleanGuess,
    calories: clampNum(calories),
    protein: clampNum(protein),
    carbs: clampNum(carbs),
    fat: clampNum(fat),
  }
}
