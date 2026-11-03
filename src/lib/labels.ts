// Rótulos e cores de status: sempre texto + cor (nunca só cor).
export type Tone = 'gray' | 'blue' | 'amber' | 'green' | 'red' | 'violet' | 'cyan'

export const orderStatus: Record<string, [string, Tone]> = {
  open: ['Aberta', 'gray'],
  diagnosis: ['Diagnóstico', 'cyan'],
  awaiting_approval: ['Aguardando aprovação', 'amber'],
  approved: ['Aprovada / programada', 'blue'],
  in_progress: ['Em execução', 'violet'],
  quality_check: ['Controle de qualidade', 'cyan'],
  ready: ['Pronta', 'green'],
  delivered: ['Entregue', 'gray'],
  cancelled: ['Cancelada', 'red'],
}

export const itemStatus: Record<string, [string, Tone]> = {
  pending_approval: ['Aguardando aprovação', 'amber'],
  approved: ['Aprovado', 'blue'],
  declined: ['Recusado', 'red'],
  in_progress: ['Em execução', 'violet'],
  done: ['Executado', 'green'],
  not_done: ['Não executado', 'red'],
  cancelled: ['Cancelado', 'gray'],
}

export const quoteStatus: Record<string, [string, Tone]> = {
  draft: ['Rascunho', 'gray'],
  sent: ['Enviado', 'blue'],
  approved: ['Aprovado', 'green'],
  partially_approved: ['Aprovado parcialmente', 'cyan'],
  declined: ['Recusado', 'red'],
  expired: ['Expirado', 'amber'],
  superseded: ['Substituído', 'gray'],
}

export const appointmentStatus: Record<string, [string, Tone]> = {
  requested: ['Solicitado', 'amber'],
  confirmed: ['Confirmado', 'blue'],
  arrived: ['Cliente chegou', 'violet'],
  converted: ['Convertido em OS', 'green'],
  completed: ['Concluído', 'gray'],
  cancelled: ['Cancelado', 'red'],
  no_show: ['Não compareceu', 'red'],
}

export const techStatus: Record<string, [string, Tone]> = {
  ok: ['Em dia', 'green'],
  due_soon: ['Próximo do prazo', 'amber'],
  overdue_date: ['Vencido por data', 'red'],
  overdue_km: ['Vencido por km (confirmado)', 'red'],
  estimated: ['Retorno estimado — confirmar km', 'violet'],
  awaiting_km: ['Aguardando km', 'cyan'],
  completed: ['Concluído', 'gray'],
  suspended: ['Suspenso', 'gray'],
  cancelled: ['Cancelado', 'gray'],
}

export const contactStatus: Record<string, [string, Tone]> = {
  not_contacted: ['Não contatado', 'gray'],
  pending: ['Contato pendente', 'amber'],
  contacted: ['Contatado', 'blue'],
  responded: ['Respondeu', 'cyan'],
  scheduled: ['Agendou', 'green'],
  postponed: ['Adiou', 'violet'],
  refused: ['Recusou', 'red'],
  no_consent: ['Sem consentimento', 'red'],
}

export const messageStatus: Record<string, [string, Tone]> = {
  pending: ['Pendente', 'gray'],
  processing: ['Processando', 'blue'],
  accepted: ['Aceito pelo provedor', 'blue'],
  delivered: ['Entregue', 'green'],
  read: ['Lido', 'green'],
  failed: ['Falhou', 'red'],
  cancelled: ['Cancelado', 'gray'],
  uncertain: ['Envio incerto — revisar', 'amber'],
}

export const roleLabel: Record<string, string> = {
  owner: 'Proprietário', manager: 'Gerente', reception: 'Recepção/atendimento', mechanic: 'Mecânico',
  finance: 'Financeiro', stock: 'Estoquista', viewer: 'Consulta',
}

export const paymentMethodLabel: Record<string, string> = {
  dinheiro: 'Dinheiro', pix: 'Pix (registro manual)', cartao_debito: 'Cartão de débito', cartao_credito: 'Cartão de crédito',
  transferencia: 'Transferência', boleto: 'Boleto', outro: 'Outro',
}

export const kindLabel: Record<string, string> = { service: 'Serviço', part: 'Peça', third_party: 'Terceiros' }

export const fuelLabels = ['Reserva', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', 'Cheio']

export const COMPONENTS: { key: string; label: string }[] = [
  { key: 'oleo_motor', label: 'Óleo do motor' },
  { key: 'filtro_oleo', label: 'Filtro de óleo' },
  { key: 'filtro_ar', label: 'Filtro de ar' },
  { key: 'filtro_cabine', label: 'Filtro de cabine' },
  { key: 'filtro_combustivel', label: 'Filtro de combustível' },
  { key: 'correia', label: 'Correia dentada / acessórios' },
  { key: 'freios', label: 'Freios (pastilhas/discos)' },
  { key: 'fluido_freio', label: 'Fluido de freio' },
  { key: 'arrefecimento', label: 'Líquido de arrefecimento' },
  { key: 'velas', label: 'Velas de ignição' },
  { key: 'alinhamento', label: 'Alinhamento e balanceamento' },
  { key: 'pneus', label: 'Pneus' },
  { key: 'suspensao', label: 'Suspensão' },
  { key: 'bateria', label: 'Bateria' },
  { key: 'ar_condicionado', label: 'Ar-condicionado' },
  { key: 'cambio', label: 'Óleo do câmbio' },
  { key: 'revisao', label: 'Revisão geral' },
]
