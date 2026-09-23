export const PERSONAS = ['friend', 'coworker', 'cofounder'] as const
export type Persona = (typeof PERSONAS)[number]

export function isPersona(v: string): v is Persona {
  return (PERSONAS as readonly string[]).includes(v)
}
