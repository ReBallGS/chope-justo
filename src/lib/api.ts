import { supabase } from './supabase'
import type {
  MyRound,
  ReportCategory,
  RoundBundle,
  RoundPreview,
} from './types'

export function cleanError(message: string): string {
  return message
    .replace(/^.*ERROR:\s*/i, '')
    .replace(/^P0001:\s*/, '')
    .replace(/\s*CONTEXT:[\s\S]*$/, '')
    .replace(/\s*PL\/pgSQL[\s\S]*$/, '')
    .trim()
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('O Supabase ainda não está configurado.')
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(cleanError(error.message))
  return data as T
}

export const api = {
  updateDisplayName: (displayName: string) =>
    rpc<{ display_name: string }>('update_display_name', { p_display_name: displayName }),
  myRounds: () => rpc<MyRound[]>('my_rounds'),
  createRound: (input: {
    name: string
    unitPriceCents: number
    volumeMl: number | null
    startsAt: string
    reviewHours: number
    creatorCanRecord: boolean
  }) =>
    rpc<{ id: string; access_code: string; name: string }>('create_round', {
      p_name: input.name,
      p_unit_price_cents: input.unitPriceCents,
      p_volume_ml: input.volumeMl,
      p_starts_at: input.startsAt,
      p_review_hours: input.reviewHours,
      p_creator_can_record_for_others: input.creatorCanRecord,
    }),
  previewRound: (code: string) => rpc<RoundPreview>('preview_round', { p_access_code: code }),
  joinRound: (code: string) =>
    rpc<{ id: string; joined: boolean; already_member: boolean }>('join_round', {
      p_access_code: code,
    }),
  bundle: (roundId: string) => rpc<RoundBundle>('get_round_bundle', { p_round_id: roundId }),
  record: (input: {
    roundId: string
    consumerId: string
    quantity: number
    idempotencyKey: string
    origin: string
  }) =>
    rpc<{ entry_id: string; idempotent: boolean; status?: string }>('record_consumption', {
      p_round_id: input.roundId,
      p_consumer_id: input.consumerId,
      p_quantity: input.quantity,
      p_idempotency_key: input.idempotencyKey,
      p_origin: input.origin,
    }),
  confirm: (entryId: string) => rpc('confirm_entry', { p_entry_id: entryId }),
  openDispute: (entryId: string, explanation: string) =>
    rpc('open_dispute', { p_entry_id: entryId, p_explanation: explanation }),
  withdrawDispute: (disputeId: string) => rpc('withdraw_dispute', { p_dispute_id: disputeId }),
  decideDispute: (disputeId: string, decision: string, justification: string) =>
    rpc('record_dispute_decision', {
      p_dispute_id: disputeId,
      p_decision: decision,
      p_justification: justification,
    }),
  acceptDispute: (disputeId: string) =>
    rpc('accept_dispute_outcome', { p_dispute_id: disputeId }),
  proposeCorrection: (input: {
    entryId: string
    type: string
    quantity: number | null
    consumerId: string | null
    priceCents: number | null
    justification: string
  }) =>
    rpc('propose_correction', {
      p_entry_id: input.entryId,
      p_type: input.type,
      p_new_quantity: input.quantity,
      p_new_consumer_id: input.consumerId,
      p_new_unit_price_cents: input.priceCents,
      p_justification: input.justification,
    }),
  acceptCorrection: (id: string) => rpc('accept_correction', { p_correction_id: id }),
  withdrawCorrection: (id: string) => rpc('withdraw_correction', { p_correction_id: id }),
  report: (input: {
    roundId: string
    entryId: string | null
    category: ReportCategory
    description: string
  }) =>
    rpc('report_divergence', {
      p_round_id: input.roundId,
      p_entry_id: input.entryId,
      p_category: input.category,
      p_description: input.description,
    }),
  resolveReport: (id: string, outcome: string, note: string) =>
    rpc('resolve_report', { p_report_id: id, p_outcome: outcome, p_note: note }),
  proposeAdjustment: (input: {
    roundId: string
    type: string
    amountCents: number
    appliesTo: string
    justification: string
  }) =>
    rpc('propose_adjustment', {
      p_round_id: input.roundId,
      p_type: input.type,
      p_amount_cents: input.amountCents,
      p_applies_to: input.appliesTo,
      p_justification: input.justification,
    }),
  acceptAdjustment: (id: string) => rpc('accept_adjustment', { p_adjustment_id: id }),
  withdrawAdjustment: (id: string) => rpc('withdraw_adjustment', { p_adjustment_id: id }),
  setRole: (roundId: string, userId: string, role: string) =>
    rpc('set_participant_role', { p_round_id: roundId, p_user_id: userId, p_role: role }),
  setRecorder: (roundId: string, userId: string, can: boolean) =>
    rpc('set_recorder_permission', {
      p_round_id: roundId,
      p_user_id: userId,
      p_can_record: can,
    }),
  changePrice: (roundId: string, cents: number, justification: string) =>
    rpc('change_unit_price', {
      p_round_id: roundId,
      p_unit_price_cents: cents,
      p_justification: justification,
    }),
  startReview: (roundId: string) => rpc('start_review', { p_round_id: roundId }),
  resumeRound: (roundId: string) => rpc('resume_round', { p_round_id: roundId }),
  proposeClosing: (input: {
    roundId: string
    type: 'provisional' | 'final'
    venueCents: number | null
    explanation: string
  }) =>
    rpc<{ closing_id: string; difference_cents: number | null; allocated: boolean }>(
      'propose_closing',
      {
        p_round_id: input.roundId,
        p_closing_type: input.type,
        p_venue_bill_cents: input.venueCents,
        p_explanation: input.explanation,
      },
    ),
  acknowledge: (closingId: string, decision: 'accept' | 'reject') =>
    rpc('acknowledge_closing', { p_closing_id: closingId, p_decision: decision }),
}
