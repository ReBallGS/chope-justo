export type RoundStatus = 'open' | 'review' | 'provisionally_closed' | 'closed'
export type EntryStatus = 'confirmed' | 'pending' | 'disputed' | 'void' | 'courtesy'
export type Origin = 'self' | 'waiter' | 'authorized_peer'
export type ReportCategory =
  | 'unregistered_consumption'
  | 'wrong_person'
  | 'duplicate'
  | 'not_consumed'
  | 'wrong_quantity'

export type Profile = {
  id: string
  display_name: string
}

export type MyRound = {
  id: string
  name: string
  status: RoundStatus
  starts_at: string
  access_code: string
  unit_price_cents: number
}

export type PendingCorrection = {
  id: string
  correction_type: string
  new_quantity: number | null
  new_consumer_id: string | null
  new_unit_price_cents: number | null
  justification: string
  created_by: string
  created_by_name: string
  created_at: string
  required_acceptors: string[]
}

export type DisputeHistoryItem = {
  id: string
  explanation: string | null
  opened_by: string
  opened_by_name: string
  created_at: string
  decision: string | null
  justification: string | null
  decided_by_name: string | null
  resolved_at: string | null
  accepted_at: string | null
}

export type EntryView = {
  id: string
  consumer_id: string
  consumer_name: string
  recorded_by: string
  recorded_by_name: string
  origin: Origin
  original_quantity: number
  original_unit_price_cents: number
  quantity: number
  unit_price_cents: number
  billable_consumer_id: string
  billable_consumer_name: string
  amount_cents: number
  status: EntryStatus
  created_at: string
  pending_correction: PendingCorrection | null
  open_dispute: {
    id: string
    explanation: string | null
    opened_by: string
    opened_by_name: string
    created_at: string
  } | null
  dispute_history: DisputeHistoryItem[]
}

export type ParticipantView = {
  user_id: string
  display_name: string
  role: 'organizer' | 'participant'
  can_record_for_others: boolean
  confirmed_cents: number
  pending_cents: number
  disputed_cents: number
  adjustment_cents: number
  total_cents: number
  confirmed_quantity: number
}

export type AdjustmentView = {
  id: string
  adjustment_type: string
  amount_cents: number
  applies_to: string
  applies_to_name: string
  justification: string
  created_by: string
  created_by_name: string
  created_at: string
  status: 'pending' | 'accepted' | 'withdrawn'
}

export type ReportView = {
  id: string
  category: ReportCategory
  description: string | null
  entry_id: string | null
  created_at: string
  reporter_name: string | null
  status: 'open' | 'dismissed' | 'action_taken'
  resolution_note: string | null
  resolved_at: string | null
  redacted: boolean
}

export type ClosingView = {
  id: string
  closing_type: 'provisional' | 'final'
  confirmed_cents: number
  pending_cents: number
  disputed_cents: number
  grand_cents: number
  venue_bill_cents: number | null
  difference_cents: number | null
  explanation: string | null
  created_at: string
  created_by_name: string
  acknowledgements: Array<{
    user_id: string
    display_name: string
    decision: 'accept' | 'reject'
    created_at: string
  }>
}

export type AuditView = {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  actor_id: string
  actor_name: string
  payload: Record<string, unknown>
  created_at: string
}

export type RoundBundle = {
  math_version: number
  confirmed_cents: number
  pending_cents: number
  disputed_cents: number
  adjustment_cents: number
  grand_cents: number
  confirmed_quantity: number
  blockers: string[]
  entries: EntryView[]
  participants: ParticipantView[]
  adjustments: AdjustmentView[]
  open_report_count: number
  resolved_report_count: number
  round: {
    id: string
    name: string
    unit_price_cents: number
    volume_ml: number | null
    starts_at: string
    access_code: string
    status: RoundStatus
    review_hours: number
    review_started_at: string | null
    created_at: string
  }
  me: {
    user_id: string
    role: 'organizer' | 'participant'
    can_record_for_others: boolean
    display_name: string
  }
  reports: ReportView[]
  report_counts: { open: number; resolved: number }
  closings: ClosingView[]
  audit: AuditView[]
}

export type RoundPreview = {
  name: string
  starts_at: string
  unit_price_cents: number
  volume_ml: number | null
  status: RoundStatus
} | null
