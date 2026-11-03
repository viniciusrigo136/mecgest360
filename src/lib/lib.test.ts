import { describe, expect, it } from 'vitest'
import { csvCell, toCSV } from './csv'
import { errorMessage } from './errors'
import { brl, fmtDate, fmtPhone, fmtPlate, isValidPlate, localToISO, normPhone, parseBRL } from './format'
import { maskPlate, renderTemplate, waLink } from './whatsapp'

describe('dinheiro', () => {
  it('converte texto em centavos inteiros sem erro de ponto flutuante', () => {
    expect(parseBRL('1.234,56')).toBe(123456)
    expect(parseBRL('R$ 0,1')).toBe(10)
    expect(parseBRL('19.99')).toBe(1999)
    expect(parseBRL('0,07')).toBe(7)
    expect(parseBRL('abc')).toBeNull()
    expect(parseBRL('1,234')).toBeNull()
  })
  it('formata em reais', () => {
    expect(brl(123456).replace(/\s/g, ' ')).toBe('R$ 1.234,56')
    expect(brl(null)).toBe('—')
  })
})

describe('datas', () => {
  it('data sem hora é local (não muda de dia por fuso)', () => {
    expect(fmtDate('2025-03-01')).toBe('01/03/2025')
  })
  it('instante é exibido no fuso da oficina', () => {
    expect(fmtDate('2025-03-01T02:00:00Z', 'America/Sao_Paulo')).toBe('28/02/2025')
    expect(fmtDate('2025-03-01T02:00:00Z', 'America/Noronha')).toBe('01/03/2025')   // UTC−2: já é dia 1º
  })
  it('hora local da oficina vira UTC corretamente', () => {
    expect(localToISO('2025-11-10', '10:00', 'America/Sao_Paulo')).toBe('2025-11-10T13:00:00.000Z')
    expect(localToISO('2025-11-10', '10:00', 'America/Manaus')).toBe('2025-11-10T14:00:00.000Z')
  })
})

describe('placa e telefone', () => {
  it('aceita padrão antigo e Mercosul', () => {
    expect(isValidPlate('abc-1234')).toBe(true)
    expect(isValidPlate('ABC1D23')).toBe(true)
    expect(isValidPlate('AB12')).toBe(false)
    expect(fmtPlate('abc1234')).toBe('ABC-1234')
    expect(maskPlate('ABC1D23')).toBe('ABC-**23')
  })
  it('normaliza telefone como o banco', () => {
    expect(normPhone('(11) 98888-7777')).toBe('5511988887777')
    expect(normPhone('+55 11 98888-7777')).toBe('5511988887777')
    expect(normPhone('123')).toBeNull()
    expect(fmtPhone('5511988887777')).toBe('(11) 98888-7777')
  })
})

describe('CSV seguro', () => {
  it('neutraliza fórmulas e escapa separadores', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+5511')).toBe("'+5511")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(toCSV([{ a: 1 }], [{ key: 'a', label: 'A' }])).toBe('﻿A\r\n1')
  })
})

describe('WhatsApp manual', () => {
  it('gera link wa.me com texto codificado', () => {
    expect(waLink('11 98888-7777', 'Olá, tudo bem?')).toBe('https://wa.me/5511988887777?text=Ol%C3%A1%2C%20tudo%20bem%3F')
    expect(waLink('', 'x')).toBeNull()
  })
  it('template aponta variáveis ausentes', () => {
    const r = renderTemplate('Olá, {nome}! {km}', { nome: 'Ana' })
    expect(r.text).toBe('Olá, Ana! {km}')
    expect(r.missing).toEqual(['km'])
  })
})

describe('mensagens de erro', () => {
  it('traduz códigos do banco', () => {
    expect(errorMessage({ code: '40001', message: 'x' })).toMatch(/alterado por outra pessoa/)
    expect(errorMessage({ code: '42501', message: 'Sem permissão: costs.view' })).toBe('Você não tem permissão para esta ação.')
    expect(errorMessage(new Error('Failed to fetch'))).toMatch(/Sem conexão/)
  })
})
