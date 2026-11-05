import clsx from 'clsx'
import { fmtPlate } from '@/lib/format'

/** Placa no estilo Mercosul (faixa azul em cima), como no ChapGest. */
export function Plate({ value, size = 'sm', className }: { value: string | null | undefined; size?: 'sm' | 'lg'; className?: string }) {
  if (!value) return null
  return (
    <span className={clsx('inline-flex flex-col overflow-hidden rounded-[6px] border-2 border-ink bg-white text-[#0F172A] leading-none',
      size === 'lg' ? 'min-w-36' : 'min-w-[5.5rem]', className)}>
      <span className={clsx('bg-[#1f3fa0]', size === 'lg' ? 'h-2' : 'h-1.5')} aria-hidden />
      <span className={clsx('plate px-2 text-center', size === 'lg' ? 'py-1 text-3xl' : 'py-0.5 text-base')}>{fmtPlate(value)}</span>
    </span>
  )
}
