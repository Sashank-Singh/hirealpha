/**
 * Static catalog for the mini-app pages: what each persona can open, what the
 * old kinds were renamed to, and how the App Store grid groups them. Data only —
 * no components — so any file can import it without pulling in React.
 */

export interface MenuFeature {
  kind: string
  title: string
  emoji: string
  blurb: string
  sample?: string
}

/** Old kinds still open; they land on the surviving app. 'mirror' is the old name for 'home'. */
export const APP_ALIASES: Record<string, string> = {
  relationship_radar: 'networking_crm',
  check_in: 'home',
  weekly_focus: 'weekly_review',
  spiral_options: 'home',
  mirror: 'home',
}
export const FRIEND_APP_ALIASES = APP_ALIASES

export const MENU_FEATURES: Record<string, MenuFeature[]> = {
  friend: [
    { kind: 'home', title: 'Home', emoji: '🏠', blurb: 'Today, next eight hours, and receipts.', sample: 'home screen' },
    { kind: 'body', title: 'Body', emoji: '💪', blurb: 'Nutrition, workout, sleep, habits, mood.', sample: 'log my breakfast' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'Who to follow up and who you are seeing.', sample: 'i met sarah' },
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Who is next, what to do, what can wait.', sample: 'morning brief' },
    { kind: 'pick_night', title: 'Evening brief', emoji: '🌆', blurb: 'Day wrap, mail since morning, tomorrow.' },
    { kind: 'tonight', title: 'Tonight', emoji: '🌙', blurb: 'Places to eat or hang. Maps powered.', sample: 'dinner plans tonight' },
    { kind: 'later', title: 'Later', emoji: '📥', blurb: 'Drop zone, learning, promises, gratitude.', sample: 'save for later' },
    { kind: 'builds', title: 'Your builds', emoji: '🛠️', blurb: 'Everything Alpha built for you, saved in one place.' },
  ],
  coworker: [
    { kind: 'meeting_mode', title: 'Meeting mode', emoji: '🗂️', blurb: 'Prepped before, wrapped after.', sample: 'prep me for the review' },
    { kind: 'approve_send', title: 'Approve & send', emoji: '✉️', blurb: 'Review drafts before they go out.', sample: 'approve the email' },
    { kind: 'pick_slot', title: 'Pick a slot', emoji: '🗓️', blurb: 'Compare times and pick what works.', sample: 'pick a slot for the review' },
    { kind: 'linear_triage', title: 'Linear triage', emoji: '🎯', blurb: 'Issues and backlog, triaged.', sample: 'triage the backlog' },
    { kind: 'standup_paste', title: 'Standup', emoji: '📋', blurb: 'Raw notes in, tight standup out.', sample: 'standup' },
    { kind: 'open_loops', title: 'Promises', emoji: '🔗', blurb: 'What you told a person you would do, until you mark it done.', sample: 'i promised maya the deck' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'Who to follow up and when.', sample: 'i met sarah' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.', sample: 'save for later' },
  ],
  cofounder: [
    { kind: 'pipeline_board', title: 'Pipeline', emoji: '💼', blurb: 'Jobs, fundraising, leads. Move them through stages.' },
    { kind: 'decision_ledger', title: 'Decisions', emoji: '📜', blurb: 'Log the call, revisit the reasoning later.', sample: 'log a decision' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'People you met, when to follow up.' },
    { kind: 'open_loops', title: 'Promises', emoji: '🔗', blurb: 'What you told a person you would do, until you mark it done.', sample: 'i promised maya the deck' },
    { kind: 'approve_investor_note', title: 'Investor note', emoji: '💼', blurb: 'Review the note before it goes out.', sample: 'review the investor note' },
    { kind: 'hire_decision', title: 'Hire decision', emoji: '🤝', blurb: 'The call on the candidate.', sample: 'should we hire them' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.', sample: 'save for later' },
  ],
}

export const APP_STORE_GROUPS: Record<string, { label: string; kinds: string[] }[]> = {
  friend: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Body', kinds: ['body'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Brief', kinds: ['digest', 'pick_night', 'tonight'] },
    { label: 'Later', kinds: ['later'] },
  ],
  coworker: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Work', kinds: ['meeting_mode', 'approve_send', 'pick_slot', 'linear_triage', 'standup_paste', 'open_loops'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Later', kinds: ['drop_zone'] },
  ],
  cofounder: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Work', kinds: ['pipeline_board', 'decision_ledger', 'hire_decision', 'approve_investor_note', 'open_loops'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Later', kinds: ['drop_zone'] },
  ],
}

export const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  menu: { title: 'Apps', blurb: 'Tap one to open it.' },
  apps: { title: 'Apps', blurb: 'Tap one to open it.' },
  digest: { title: 'Morning brief', blurb: 'Who is next, what to do, what can wait.' },
  next_move: { title: 'Next', blurb: 'The one thing to do now.' },
  approve_send: { title: 'Approve & send', blurb: 'Review the draft and approve it to send.' },
  pick_slot: { title: 'Pick a slot', blurb: 'Compare meeting times and pick the one that works.' },
  pick_night: { title: 'Evening brief', blurb: 'What happened, what is left, and what is on tomorrow.' },
  tonight: { title: 'Tonight', blurb: 'Places to eat or hang near you.' },
  body: { title: 'Body', blurb: 'Nutrition, workout, sleep, habits, and mood.' },
  later: { title: 'Later', blurb: 'Drop zone, learning queue, promises, and gratitude.' },
  check_in: { title: 'Check-in', blurb: 'A quick pulse on how you are doing.' },
  standup_paste: { title: 'Standup', blurb: 'Your standup notes, tightened up.' },
  linear_triage: { title: 'Linear triage', blurb: 'Issues and backlog, triaged.' },
  kill_keep_park: { title: 'Kill · Keep · Park', blurb: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', blurb: 'The call on the candidate.' },
  weekly_focus: { title: 'Weekly focus', blurb: 'What to focus on this week.' },
  weekly_review: { title: 'Weekly review', blurb: "What got done, what slipped, and next week's focus." },
  approve_investor_note: { title: 'Investor note', blurb: 'Review the note before it goes out.' },
  spiral_options: { title: 'Get unstuck', blurb: 'Step back, see the options, get moving again.' },
  open_loops: { title: 'Promises', blurb: 'What you told a person you would do, until you mark it done.' },
  meeting_mode: { title: 'Meeting mode', blurb: 'Prepped before, wrapped after.' },
  decision_ledger: { title: 'Decisions', blurb: 'Big calls on record, reasoning intact.' },
  relationship_radar: { title: 'Stay in touch', blurb: 'Who to reach out to, and when.' },
  drop_zone: { title: 'Save for later', blurb: 'Dump anything and Alpha sorts it later.' },
  nutrition: { title: 'Nutrition', blurb: 'Snap a meal, see the macros, hit your goals.' },
  habit_streak: { title: 'Habits', blurb: 'Build streaks. Track daily habits.' },
  mood_tracker: { title: 'Mood', blurb: 'Log how you feel. Spot patterns over time.' },
  workout_log: { title: 'Workout', blurb: 'Home or gym. Mon through Fri.' },
  learning_queue: { title: 'Learning queue', blurb: 'Save what to read or watch next.' },
  networking_crm: { title: 'Networking', blurb: 'People you met and when to follow up.' },
  sleep_tracker: { title: 'Sleep', blurb: 'Bedtime, wake, and sleep debt.' },
  pipeline_board: { title: 'Pipeline', blurb: 'Jobs, fundraising, leads. Sorted by stage.' },
  gratitude_journal: { title: 'Gratitude', blurb: 'One sentence a day.' },
  spending_snapshot: { title: 'Spending', blurb: 'Log spend against a weekly budget.' },
  home: { title: 'Home', blurb: 'Today, next eight hours, and receipts.' },
}
