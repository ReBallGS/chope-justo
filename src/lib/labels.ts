import type { EntryStatus, Origin, ReportCategory, RoundStatus } from './types'

export const statusLabel: Record<EntryStatus, string> = {
  confirmed: 'Confirmado',
  pending: 'Aguardando confirmação',
  disputed: 'Em divergência',
  void: 'Anulado',
  courtesy: 'Cortesia',
}

export const roundStatusLabel: Record<RoundStatus, string> = {
  open: 'Aberta',
  review: 'Em revisão',
  provisionally_closed: 'Fechamento provisório',
  closed: 'Encerrada',
}

export const originLabel: Record<Origin, string> = {
  self: 'A própria pessoa',
  waiter: 'Quem estava anotando',
  authorized_peer: 'Outro participante autorizado',
}

export const reportCategories: Array<{ id: ReportCategory; label: string }> = [
  { id: 'unregistered_consumption', label: 'Vi um chope que não foi registrado' },
  { id: 'wrong_person', label: 'Este chope foi registrado para a pessoa errada' },
  { id: 'duplicate', label: 'Este consumo já tinha sido lançado' },
  { id: 'not_consumed', label: 'Eu não consumi esta bebida' },
  { id: 'wrong_quantity', label: 'A quantidade registrada está incorreta' },
]

export const categoryLabel: Record<ReportCategory, string> = Object.fromEntries(
  reportCategories.map((item) => [item.id, item.label]),
) as Record<ReportCategory, string>

export const correctionLabel: Record<string, string> = {
  void: 'Anular',
  courtesy: 'Marcar como cortesia',
  quantity_adjust: 'Corrigir quantidade',
  price_adjust: 'Corrigir preço deste chope',
  consumer_change: 'Trocar a pessoa',
}

export const adjustmentLabel: Record<string, string> = {
  discount: 'Desconto',
  courtesy: 'Cortesia',
  rounding: 'Arredondamento',
  price_difference: 'Diferença de preço',
  cancellation: 'Cancelamento',
}

export const decisionLabel: Record<string, string> = {
  upheld_original: 'Manter o lançamento',
  void_entry: 'Anular o lançamento',
  withdrawn: 'Contestação retirada',
  adjusted: 'Lançamento corrigido',
}

export const auditLabel: Record<string, string> = {
  round_created: 'Rodada criada',
  member_joined: 'Pessoa entrou na rodada',
  consumption_recorded: 'Chope registrado',
  consumption_confirmed: 'Consumo confirmado',
  dispute_opened: 'Contestação aberta',
  dispute_withdrawn: 'Contestação retirada',
  dispute_decision_recorded: 'Decisão registrada',
  dispute_accepted: 'Desfecho aceito',
  dispute_settled: 'Contestação encerrada',
  correction_proposed: 'Correção proposta',
  correction_accepted: 'Correção aceita',
  correction_withdrawn: 'Correção retirada',
  divergence_reported: 'Divergência reportada',
  report_resolved: 'Denúncia verificada',
  adjustment_proposed: 'Ajuste proposto',
  adjustment_accepted: 'Ajuste aceito',
  adjustment_withdrawn: 'Ajuste retirado',
  role_changed: 'Papel alterado',
  recorder_permission_changed: 'Permissão de anotação alterada',
  price_changed: 'Preço dos próximos chopes alterado',
  review_started: 'Revisão iniciada',
  round_resumed: 'Rodada reaberta para lançamentos',
  closing_proposed: 'Fechamento proposto',
  closing_acknowledged: 'Fechamento respondido',
}

export function auditText(action: string): string {
  return auditLabel[action] ?? action
}
