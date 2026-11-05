import { Copy } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { brl } from '@/lib/format'
import { pixPayload } from '@/lib/pix'
import { Button, useToast } from './ui'

export type PixInfo = { key: string; name: string; city: string; amount_cents?: number | null }

/** QR Code Pix + "copia e cola". O pagamento é conferido pela oficina (não há confirmação automática). */
export function PixBox({ pix, compact }: { pix: PixInfo; compact?: boolean }) {
  const toast = useToast()
  const payload = pixPayload({ key: pix.key, name: pix.name, city: pix.city, amountCents: pix.amount_cents })
  const [qr, setQr] = useState('')
  useEffect(() => { QRCode.toDataURL(payload, { margin: 1, width: 360 }).then(setQr).catch(() => setQr('')) }, [payload])
  return (
    <div className="rounded-2xl border border-slate-200 bg-card p-4 text-center">
      <p className="font-semibold">Pagar com Pix{pix.amount_cents ? ` · ${brl(pix.amount_cents)}` : ''}</p>
      {qr && <img src={qr} alt="QR Code Pix" className={compact ? 'mx-auto my-2 size-40' : 'mx-auto my-3 size-52'} />}
      <p className="text-xs text-slate-500">Chave: {pix.key} · {pix.name}</p>
      <Button variant="secondary" className="mt-3 w-full" onClick={() => navigator.clipboard.writeText(payload).then(() => toast.success('Código Pix copiado')).catch(() => toast.info(payload))}>
        <Copy className="size-4" />Copiar Pix copia e cola
      </Button>
    </div>
  )
}
