/**
 * The persona capability matrix has exactly one home: src/agents/skills.ts.
 * This file used to be a hand-copied fork; it drifted (gratitude_journal went
 * missing on the friend, which miniApps.test.ts catches) and every bot import
 * now re-exports the canonical source so drift is impossible.
 */
export { SKILLS, skillsPromptBlock } from '../../src/agents/skills'
