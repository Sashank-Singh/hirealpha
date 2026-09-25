export const PERSONAS = ['friend', 'coworker', 'cofounder'] as const
export type Persona = (typeof PERSONAS)[number]

export function isPersona(v: string): v is Persona {
  return (PERSONAS as readonly string[]).includes(v)
}

export const PERSONA_DENIED: Record<Persona, ReadonlySet<string>> = {
  friend: new Set<string>(),
  coworker: new Set(['spotify', 'uber']),
  cofounder: new Set(['uber', 'spotify']),
}
