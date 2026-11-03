// Converte erros do banco/API em mensagens úteis em português.
type PgLike = { code?: string; message?: string; details?: string; hint?: string }

export function errorMessage(e: unknown): string {
  const err = (e ?? {}) as PgLike
  const msg = err.message ?? String(e)
  switch (err.code) {
    case '42501':
      return msg.startsWith('Sem permissão') || msg.includes('Você') || msg.includes('Somente')
        ? msg.replace(/^Sem permissão: .*/, 'Você não tem permissão para esta ação.')
        : 'Você não tem permissão para esta ação.'
    case '40001':
      return 'Este registro foi alterado por outra pessoa. Recarregue para ver a versão atual antes de salvar.'
    case '23505':
      return 'Já existe um registro com esses dados (duplicado).'
    case '23503':
      return 'Registro relacionado inválido ou de outra oficina.'
    case '23514':
      return msg.includes('vehicles') ? 'Placa inválida. Use o formato ABC1D23 ou ABC1234, ou informe a exceção.' : 'Dados inválidos.'
    case 'PGRST301':
    case '28000':
      return msg
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sem conexão com o servidor. As alterações não foram salvas; tente novamente quando a conexão voltar.'
  if (/JWT|session/i.test(msg)) return 'Sua sessão expirou. Entre novamente.'
  return msg
}

export function isConflict(e: unknown) {
  return (e as PgLike)?.code === '40001'
}
