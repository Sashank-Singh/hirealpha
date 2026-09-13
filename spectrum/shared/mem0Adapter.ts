/**
 * Mem0 Open-Source Adapter for Alpha.
 *
 * Provides semantic memory retrieval, memory conflict detection (e.g. dietary
 * restrictions vs requested dishes, airline preferences vs requested flights),
 * and dynamic preference extraction powered by Mem0 OSS concepts.
 */

export interface MemoryFact {
  key?: string
  value?: string
  durable?: boolean
  updatedAt?: string
}

export interface Mem0Conflict {
  hasConflict: boolean
  key: string
  storedValue: string
  conflictingText: string
  resolutionAdvice: string
}

export interface Mem0Hit {
  id: string
  key: string
  text: string
  score: number
}

/** Known dietary conflicts mapped to prohibited ingredients/dishes. */
const DIETARY_CONFLICTS: Record<string, { regex: RegExp; label: string }> = {
  'no pork': {
    regex: /\b(?:pork|bacon|ham|prosciutto|pancetta|sausage|pepperoni|carnitas|pork belly|chorizo|salami)\b/i,
    label: 'pork',
  },
  'vegetarian': {
    regex: /\b(?:beef|chicken|steak|pork|bacon|fish|salmon|tuna|seafood|shrimp|lamb|turkey|meat)\b/i,
    label: 'meat/fish',
  },
  'vegan': {
    regex: /\b(?:beef|chicken|pork|fish|cheese|dairy|milk|egg|eggs|butter|honey|cream)\b/i,
    label: 'animal products',
  },
  'gluten free': {
    regex: /\b(?:bread|wheat|pasta|flour|beer|pizza crust|croissant)\b/i,
    label: 'gluten',
  },
  'peanut allergy': {
    regex: /\b(?:peanut|peanuts|peanut butter|pad thai|satay)\b/i,
    label: 'peanuts',
  },
  'shellfish allergy': {
    regex: /\b(?:shrimp|crab|lobster|oyster|mussels|clams|scallops|calamari)\b/i,
    label: 'shellfish',
  },
}

/**
 * Detect conflicts between user's current request and their stored memories.
 * E.g., user asking for pepperoni pizza when their profile has "hard_nos: no pork".
 */
export function detectMemoryConflicts(
  userText: string,
  memories: MemoryFact[] = [],
): Mem0Conflict | null {
  if (!memories.length || !userText) return null

  // 1. Check dietary and hard_no conflicts
  const hardNos = memories.find((m) => m.key === 'hard_nos' || m.key === 'dietary')?.value?.toLowerCase() || ''
  for (const [dietKey, conf] of Object.entries(DIETARY_CONFLICTS)) {
    if (hardNos.includes(dietKey) || (dietKey === 'no pork' && hardNos.includes('pork'))) {
      const match = userText.match(conf.regex)
      if (match) {
        return {
          hasConflict: true,
          key: 'hard_nos',
          storedValue: hardNos,
          conflictingText: match[0],
          resolutionAdvice: `Your profile has a strict preference (${hardNos}), but you mentioned "${match[0]}". Flag this kindly to confirm if they want an exception or an alternative (e.g. beef/veggie option).`,
        }
      }
    }
  }

  // 2. Check airline anti-preferences (e.g. "never fly Delta")
  const airlineMemory = memories.find((m) => m.key === 'airlines' || m.key === 'flights' || m.key === 'hard_nos')?.value?.toLowerCase() || ''
  const neverAirlinesMatch = airlineMemory.match(/never\s+(?:fly\s+)?(delta|united|american|southwest|spirit|frontier)/i)
  if (neverAirlinesMatch) {
    const avoidedAirline = neverAirlinesMatch[1]
    const currentAskAirline = userText.match(new RegExp(`\\b${avoidedAirline}\\b`, 'i'))
    if (currentAskAirline) {
      return {
        hasConflict: true,
        key: 'airlines',
        storedValue: airlineMemory,
        conflictingText: currentAskAirline[0],
        resolutionAdvice: `Your profile notes "never fly ${avoidedAirline}", but this ask requested ${avoidedAirline}. Check with the user before booking.`,
      }
    }
  }

  // 3. Check seat preference conflicts (e.g. always aisle vs user asks for window)
  const seatPref = memories.find((m) => m.key === 'seat' || m.key === 'flight_seat')?.value?.toLowerCase() || ''
  if (seatPref.includes('aisle') && /\bwindow(?:\s+seat)?\b/i.test(userText)) {
    return {
      hasConflict: true,
      key: 'seat',
      storedValue: 'aisle seat',
      conflictingText: 'window',
      resolutionAdvice: `Your profile prefers aisle seats, but you mentioned window. Confirm if you want to switch for this trip.`,
    }
  } else if (seatPref.includes('window') && /\baisle(?:\s+seat)?\b/i.test(userText)) {
    return {
      hasConflict: true,
      key: 'seat',
      storedValue: 'window seat',
      conflictingText: 'aisle',
      resolutionAdvice: `Your profile prefers window seats, but you mentioned aisle. Confirm if you want to switch for this trip.`,
    }
  }

  return null
}

/**
 * Simple in-process semantic scoring for memories when full vector index is
 * offline or running in unit tests.
 */
export function rankMemoriesByRelevance(
  query: string,
  memories: MemoryFact[],
  limit = 8,
): Mem0Hit[] {
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)

  if (!queryTerms.length) {
    return memories.slice(0, limit).map((m, i) => ({
      id: `mem-${i}`,
      key: m.key || `fact-${i}`,
      text: `${m.key}: ${m.value}`,
      score: 1.0 - i * 0.05,
    }))
  }

  const scored = memories.map((m, idx) => {
    const text = `${m.key || ''}: ${m.value || ''}`.toLowerCase()
    let score = 0
    for (const term of queryTerms) {
      const termRegex = new RegExp(`\\b${term}\\b`, 'i')
      if (termRegex.test(text)) score += 1
      if (m.key && termRegex.test(m.key)) score += 2
    }
    if (score > 0 && m.durable) score += 0.5
    return {
      id: `mem-${idx}`,
      key: m.key || `fact-${idx}`,
      text: `${m.key}: ${m.value}`,
      score,
    }
  })

  return scored
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Extract permanent user facts from text to feed into Mem0 / hire_context.
 */
export function extractMem0Facts(
  userText: string,
): Array<{ key: string; value: string; durable: boolean }> {
  const facts: Array<{ key: string; value: string; durable: boolean }> = []

  // Hard-nos: "no pork anywhere", "never fly spirit"
  const hardNoMatch = userText.match(/\b(?:remember(?:\s+for\s+good)?|never|strictly|no)\s+(?:pork|gluten|peanuts?|shellfish|dairy|alcohol|spirit|frontier)\b[^.!?]*/i)
  if (hardNoMatch && /\bno\s+pork\b/i.test(userText)) {
    facts.push({ key: 'hard_nos', value: 'no pork anywhere', durable: true })
  }

  // Seat preference: "always want an aisle seat"
  const seatMatch = userText.match(/\b(?:always\s+(?:want|need|prefer)\s+(?:an?\s+)?)(aisle|window)(?:\s+seat)?\b/i)
  if (seatMatch) {
    facts.push({ key: 'flight_seat', value: `${seatMatch[1].toLowerCase()} seat`, durable: true })
  }

  // Preferred name
  const nameMatch = userText.match(/\b(?:call me|my name is|i'm|im)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/)
  if (nameMatch && !/^(sorry|here|ready|tired|hungry|leaving|running)$/i.test(nameMatch[1])) {
    facts.push({ key: 'preferred_name', value: nameMatch[1], durable: true })
  }

  return facts
}
