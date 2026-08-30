import { useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { getActiveHireIds, getSession } from './roster'
import { FEATURE_KINDS, KIND_TITLES, MENU_FEATURES, type MenuFeature } from './MiniAppPage'
import { MiniAppIcon } from './MiniAppIcons'
import {
  DecisionLedgerApp,
  DropZoneApp,
  HabitStreakApp,
  MeetingModeApp,
  MoodTrackerApp,
  NutritionApp,
  OpenLoopsApp,
  RelationshipRadarApp,
  type FeatureAuth,
} from './FeatureMiniApps'
import {
  GratitudeJournalApp,
  LearningQueueApp,
  HomeApp,
  NetworkingCrmApp,
  PipelineBoardApp,
  SleepTrackerApp,
  SpendingSnapshotApp,
  WeeklyReviewApp,
  WorkoutLogApp,
} from './LifeMiniApps'
import { BodyHubApp, LaterHubApp } from './FriendHubApps'
import {
  ApproveSendApp,
  HireDecisionApp,
  InvestorNoteApp,
  LinearTriageApp,
  NextMoveApp,
  PickSlotApp,
  StandupPasteApp,
} from './WorkMiniApps'

const FEATURE_APPS: Record<string, ComponentType<{ auth: FeatureAuth }>> = {
  next_move: NextMoveApp,
  open_loops: OpenLoopsApp,
  meeting_mode: MeetingModeApp,
  decision_ledger: DecisionLedgerApp,
  relationship_radar: RelationshipRadarApp,
  drop_zone: DropZoneApp,
  nutrition: NutritionApp,
  habit_streak: HabitStreakApp,
  mood_tracker: MoodTrackerApp,
  workout_log: WorkoutLogApp,
  learning_queue: LearningQueueApp,
  weekly_review: WeeklyReviewApp,
  weekly_focus: WeeklyReviewApp,
  networking_crm: NetworkingCrmApp,
  sleep_tracker: SleepTrackerApp,
  pipeline_board: PipelineBoardApp,
  gratitude_journal: GratitudeJournalApp,
  spending_snapshot: SpendingSnapshotApp,
  home: HomeApp,
  body: BodyHubApp,
  later: LaterHubApp,
  approve_send: ApproveSendApp,
  pick_slot: PickSlotApp,
  linear_triage: LinearTriageApp,
  standup_paste: StandupPasteApp,
  hire_decision: HireDecisionApp,
  approve_investor_note: InvestorNoteApp,
}

function FeatureApp({ kind, auth }: { kind: string; auth: FeatureAuth }) {
  const App = FEATURE_APPS[kind]
  return App ? <App auth={auth} /> : null
}

function FeatureCard({ f, auth, persona }: { f: MenuFeature; auth: FeatureAuth; persona: string }) {
  const [open, setOpen] = useState(false)
  const isFeature = FEATURE_KINDS.has(f.kind)
  return (
    <li className={`feat-card${open ? ' feat-card--open' : ''}`}>
      <button
        type="button"
        className="feat-card__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="feat-card__emoji" aria-hidden>
          {open ? '−' : <MiniAppIcon kind={f.kind} />}
        </span>
        <span className="feat-card__text">
          <span className="feat-card__title">{f.title}</span>
          <span className="feat-card__blurb">{f.blurb}</span>
        </span>
      </button>
      {open && (
        <div className="feat-card__body">
          {isFeature ? (
            <FeatureApp kind={f.kind} auth={auth} />
          ) : (
            <p className="feat-card__hint">
              {f.sample ? `Try in text: "${f.sample}"` : KIND_TITLES[f.kind]?.blurb ?? f.blurb}
            </p>
          )}
          <Link className="feat-card__full" to={`/app/mini/${persona}/${f.kind}`}>
            Open full page →
          </Link>
        </div>
      )}
    </li>
  )
}

export function FeaturesPage() {
  const session = getSession()
  const email = session?.email
  const activeIds = getActiveHireIds()
  const [persona, setPersona] = useState<AgentId | ''>(activeIds[0] || '')
  const [showOthers, setShowOthers] = useState(false)
  const agent = persona ? getAgent(persona) : null
  const features = persona ? MENU_FEATURES[persona] ?? [] : []
  const auth: FeatureAuth = { persona: (persona as AgentId) || 'friend', email: email || undefined }

  return (
    <div className="plat-page">
      <header className="plat-page__head">
        <h1>Features</h1>
        <p>Pick a person, then tap a card to expand the mini app.</p>
      </header>

      {activeIds.length === 0 ? (
        <p>
          Hire someone first. <Link to="/app/shop">Go to Hire</Link>
        </p>
      ) : (
        <>
          <div className="feat-persons">
            {activeIds.map((id) => (
              <button
                key={id}
                type="button"
                className={`feat-person${persona === id ? ' feat-person--on' : ''}`}
                style={persona === id ? { ['--feat-accent' as string]: getAgent(id).color } : undefined}
                onClick={() => setPersona(id)}
              >
                <span className="feat-person__mark" style={{ background: getAgent(id).color }}>
                  {getAgent(id).initial}
                </span>
                <span className="feat-person__name">{agent?.id === id ? agent.name : getAgent(id).name}</span>
              </button>
            ))}
          </div>

          {agent && (
            <p className="feat-agent">
              {agent.imsgName} — {agent.role}
            </p>
          )}

          <ul className="feat-cards">
            {features.map((f) => (
              <FeatureCard key={f.kind} f={f} auth={auth} persona={persona} />
            ))}
          </ul>

          {persona === 'friend' && (
            <div className="feat-others">
              <button
                type="button"
                className="feat-others__btn"
                onClick={() => setShowOthers((v) => !v)}
              >
                {showOthers ? 'Hide' : 'Others'}
              </button>
              {showOthers &&
                (['coworker', 'cofounder'] as AgentId[]).map((id) => (
                  <section key={id} className="feat-others__group">
                    <p className="feat-others__hire">{getAgent(id).imsgName} · in the workshop</p>
                    <ul className="feat-cards">
                      {(MENU_FEATURES[id] ?? []).map((f) => (
                        <FeatureCard key={`${id}-${f.kind}`} f={f} auth={auth} persona={id} />
                      ))}
                    </ul>
                  </section>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
