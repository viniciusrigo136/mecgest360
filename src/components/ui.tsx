import clsx from 'clsx'
import { AlertTriangle, Inbox, Loader2, Lock, X } from 'lucide-react'
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { errorMessage } from '@/lib/errors'
import type { Tone } from '@/lib/labels'

// ---------- Botões ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}
export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'h-9 px-3 text-sm' : size === 'lg' ? 'h-12 px-5 text-base font-semibold' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-brand text-white shadow-sm shadow-brand/25 hover:bg-[#1D4ED8] active:scale-[0.98]',
        variant === 'secondary' && 'border border-slate-200 bg-secondary text-ink hover:bg-slate-100',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

// ---------- Campos ----------
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function Input({ label, error, hint, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint} className={className}>{(id) => <input id={id} aria-invalid={!!error} className="input" {...rest} />}</Field>
}

export function Select({ label, error, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string }) {
  return <Field label={label} error={error} className={className}>{(id) => <select id={id} aria-invalid={!!error} className="input" {...rest}>{children}</select>}</Field>
}

export function Textarea({ label, error, hint, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint} className={className}>{(id) => <textarea id={id} aria-invalid={!!error} className="input min-h-20" {...rest} />}</Field>
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 rounded border-slate-300" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

// ---------- Status ----------
const toneCls: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-200',
}
export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', toneCls[tone])}>{children}</span>
}
export function StatusBadge({ map, value }: { map: Record<string, [string, Tone]>; value: string | null | undefined }) {
  if (!value) return null
  const [label, tone] = map[value] ?? [value, 'gray']
  return <Badge tone={tone}>{label}</Badge>
}

// ---------- Estados ----------
export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" />{label}</div>
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center text-slate-500">
      <Inbox className="size-8 text-slate-300" aria-hidden />
      <p className="font-medium text-slate-700">{title}</p>
      {children}
    </div>
  )
}
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = errorMessage(error)
  const denied = (error as { code?: string })?.code === '42501'
  return (
    <div role="alert" className={clsx('flex items-start gap-3 rounded-md border p-4 text-sm', denied ? 'border-slate-200 bg-slate-50' : 'border-red-200 bg-red-50 text-red-800')}>
      {denied ? <Lock className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <div className="flex-1">{msg}</div>
      {onRetry && !denied && <Button size="sm" variant="secondary" onClick={onRetry}>Tentar novamente</Button>}
    </div>
  )
}
export function NoAccess() {
  return <div className="p-8"><ErrorBox error={{ code: '42501' }} /></div>
}

// ---------- Layout ----------
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      {(title || subtitle) && <div>
        {title && <h1 className="font-heading text-2xl font-extrabold text-ink">{title}</h1>}
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'red' | 'amber' }) {
  return (
    <div className="card p-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold', tone === 'red' && 'text-red-600', tone === 'amber' && 'text-amber-600')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  )
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50"><tr>{head.map((h, i) => <th key={i} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 bg-card">{children}</tbody>
      </table>
      {empty && <Empty title="Nenhum registro encontrado" />}
    </div>
  )
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-sm text-slate-600">
      <span>{total} registro(s)</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 0} onClick={() => onPage(page - 1)}>Anterior</Button>
        <span>{page + 1} / {pages}</span>
        <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Próxima</Button>
      </div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={clsx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.key ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800')}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      className={clsx('mx-auto mb-0 mt-auto w-full max-w-none rounded-t-3xl bg-card p-0 text-ink shadow-xl backdrop:bg-ink/40 backdrop:backdrop-blur-[2px]',
        'sm:m-auto sm:w-[calc(100%-2rem)] sm:rounded-3xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
      {open && (
        <div className="flex max-h-[92dvh] flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-5">
            <h2 className="font-heading text-xl font-extrabold">{title}</h2>
            <button aria-label="Fechar" onClick={onClose} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 active:bg-slate-200"><X className="size-5" /></button>
          </header>
          <div className="overflow-y-auto px-5 pb-5 pt-2">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

// ---------- Toast ----------
type ToastItem = { id: number; kind: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<(kind: ToastItem['kind'], text: string) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setItems((s) => [...s, { id, kind, text }])
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto">
        {items.map((t) => (
          <div key={t.id} className={clsx('max-w-sm rounded-md px-4 py-2 text-sm text-white shadow-lg',
            t.kind === 'success' && 'bg-emerald-600', t.kind === 'error' && 'bg-red-600', t.kind === 'info' && 'bg-slate-800')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export function useToast() {
  const push = useContext(ToastCtx)
  return {
    success: (t: string) => push('success', t),
    error: (e: unknown) => push('error', errorMessage(e)),
    info: (t: string) => push('info', t),
  }
}

/** Avisa antes de sair com alterações não salvas. */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
}

/** Valor em reais digitado → centavos. */
export function MoneyInput({ label, cents, onCents, error, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { label: string; cents: number | null; onCents: (c: number | null) => void; error?: string }) {
  const [text, setText] = useState(cents === null ? '' : (cents / 100).toFixed(2).replace('.', ','))
  useEffect(() => {
    const cur = parseMoney(text)
    if (cur !== cents) setText(cents === null ? '' : (cents / 100).toFixed(2).replace('.', ','))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents])
  return <Input label={label} inputMode="decimal" value={text} error={error} placeholder="0,00" {...rest}
    onChange={(e) => { setText(e.target.value); onCents(parseMoney(e.target.value)) }} />
}
function parseMoney(s: string): number | null {
  const t = s.replace(/[R$\s.]/g, '').replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
