import { describe, expect, it } from 'vitest'
import { formatCents, normalizeAccessCode, parseReaisToCents } from '../src/lib/money'

describe('dinheiro em centavos', () => {
  it('lê valores com vírgula e ponto sem usar ponto flutuante solto', () => {
    expect(parseReaisToCents('12,50')).toBe(1250)
    expect(parseReaisToCents('12.50')).toBe(1250)
    expect(parseReaisToCents('1.234,56')).toBe(123456)
    expect(parseReaisToCents('R$ 8,5')).toBe(850)
  })

  it('recusa preço zero, texto e valor acima do limite', () => {
    expect(parseReaisToCents('0')).toBeNull()
    expect(parseReaisToCents('abc')).toBeNull()
    expect(parseReaisToCents('2000,01')).toBeNull()
    expect(parseReaisToCents('0', { allowZero: true })).toBe(0)
  })

  it('formata centavos negativos e milhar', () => {
    expect(formatCents(1250)).toBe('R$ 12,50')
    expect(formatCents(-100)).toBe('-R$ 1,00')
    expect(formatCents(123456)).toBe('R$ 1.234,56')
  })

  it('normaliza o código da rodada', () => {
    expect(normalizeAccessCode('ABCD EF12-3456')).toBe('abcdef123456')
  })
})
