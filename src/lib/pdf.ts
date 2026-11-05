// Documento A4 (orçamento, ordem de serviço, recibo) gerado no aparelho, com a
// logo da oficina e QR Code Pix. Nunca inclui custos, margens ou notas internas.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import QRCode from 'qrcode'
import { brl, fmtDate, fmtPhone, fmtPlate, fmtQty } from './format'
import { pixPayload } from './pix'
import { supabase } from './supabase'
import type { DocWorkshop } from './workshop'

export type DocData = {
  kind: 'ORÇAMENTO' | 'ORDEM DE SERVIÇO' | 'RECIBO'
  number: string
  date: string | Date
  workshop: DocWorkshop
  client: { name: string; phone?: string | null }
  vehicle?: { plate?: string | null; label?: string; km?: number | null }
  items: { description: string; quantity: number; unit_cents: number; discount_cents?: number; total_cents: number }[]
  total_cents: number
  discount_cents?: number
  notes?: (string | null | undefined)[]
  validity?: string | null
  pix?: boolean
  footer?: string
}

const BLUE: [number, number, number] = [37, 99, 235]
const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [71, 85, 105]

async function logoData(path?: string | null): Promise<string | null> {
  if (!path) return null
  try {
    const { data } = await supabase.storage.from('workshop-assets').createSignedUrl(path, 60)
    if (!data?.signedUrl) return null
    const blob = await (await fetch(data.signedUrl)).blob()
    return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => res(null); r.readAsDataURL(blob) })
  } catch { return null }
}

export async function buildPdf(d: DocData): Promise<Blob> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 14
  let y = M

  // Cabeçalho: logo + dados da oficina | tipo e número do documento
  const logo = await logoData(d.workshop.logo_path)
  let x = M
  if (logo) { try { doc.addImage(logo, M, y, 22, 22, undefined, 'FAST'); x = M + 26 } catch { /* imagem inválida: segue sem logo */ } }
  doc.setTextColor(...INK).setFont('helvetica', 'bold').setFontSize(15).text(d.workshop.name, x, y + 6)
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...MUTED)
  const a = d.workshop.address ?? {}
  const lines = [
    [d.workshop.legal_name, d.workshop.document && `CNPJ/CPF ${d.workshop.document}`].filter(Boolean).join(' · '),
    [a.street, a.city, a.state].filter(Boolean).join(', '),
    [d.workshop.whatsapp || d.workshop.phone ? fmtPhone(d.workshop.whatsapp || d.workshop.phone) : '', d.workshop.email].filter(Boolean).join(' · '),
  ].filter(Boolean)
  lines.forEach((l, i) => doc.text(String(l), x, y + 11 + i * 4))
  doc.setFillColor(...BLUE).roundedRect(W - M - 58, y, 58, 18, 2, 2, 'F')
  doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(11).text(d.kind, W - M - 29, y + 7, { align: 'center' })
  doc.setFontSize(10).text(`Nº ${d.number}`, W - M - 29, y + 13, { align: 'center' })
  doc.setTextColor(...MUTED).setFont('helvetica', 'normal').setFontSize(8.5).text(`Emitido em ${fmtDate(d.date)}`, W - M, y + 23, { align: 'right' })
  y += 30
  doc.setDrawColor(226, 232, 240).line(M, y, W - M, y)
  y += 6

  // Cliente e veículo
  doc.setTextColor(...MUTED).setFontSize(8).text('CLIENTE', M, y).text('VEÍCULO', W / 2 + 2, y)
  doc.setTextColor(...INK).setFont('helvetica', 'bold').setFontSize(11).text(d.client.name.toUpperCase(), M, y + 5)
  doc.setFont('helvetica', 'normal').setFontSize(9).text(d.client.phone ? fmtPhone(d.client.phone) : '', M, y + 10)
  if (d.vehicle) {
    doc.setFont('helvetica', 'bold').setFontSize(11).text(fmtPlate(d.vehicle.plate) || '—', W / 2 + 2, y + 5)
    doc.setFont('helvetica', 'normal').setFontSize(9).text([d.vehicle.label, d.vehicle.km ? `${d.vehicle.km.toLocaleString('pt-BR')} km` : ''].filter(Boolean).join(' · '), W / 2 + 2, y + 10)
  }
  y += 17

  // Itens
  autoTable(doc, {
    startY: y, margin: { left: M, right: M },
    head: [['Descrição', { content: 'Qtd', styles: { halign: 'center' } }, { content: 'Unitário', styles: { halign: 'right' } }, { content: 'Total', styles: { halign: 'right' } }]],
    body: d.items.map((i) => [i.description + (i.discount_cents ? `\n(desconto ${brl(i.discount_cents)})` : ''), fmtQty(i.quantity), brl(i.unit_cents), brl(i.total_cents)]),
    styles: { font: 'helvetica', fontSize: 9.5, cellPadding: 2.5, textColor: INK, lineColor: [226, 232, 240], lineWidth: 0 },
    headStyles: { fillColor: [241, 245, 249], textColor: MUTED, fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: { 1: { halign: 'center', cellWidth: 16 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 30, fontStyle: 'bold' } },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })
  y = (doc as any).lastAutoTable.finalY + 4
  if (d.discount_cents) { doc.setFontSize(9).setTextColor(...MUTED).text(`Descontos: ${brl(d.discount_cents)}`, W - M, y + 3, { align: 'right' }); y += 5 }
  doc.setFillColor(...BLUE).roundedRect(W - M - 70, y, 70, 12, 2, 2, 'F')
  doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(12).text(`TOTAL  ${brl(d.total_cents)}`, W - M - 35, y + 8, { align: 'center' })
  y += 18

  // Observações / validade
  doc.setTextColor(...INK).setFont('helvetica', 'normal').setFontSize(9)
  const notes = [...(d.notes ?? []), d.validity ? `Orçamento válido até ${fmtDate(d.validity)}.` : null].filter(Boolean) as string[]
  for (const n of notes) {
    const wrapped = doc.splitTextToSize(n, W - 2 * M - (d.pix ? 50 : 0))
    if (y + wrapped.length * 4.5 > 270) { doc.addPage(); y = M }
    doc.text(wrapped, M, y); y += wrapped.length * 4.5 + 2
  }

  // Pix
  const w = d.workshop
  if (d.pix && w.pix_key) {
    const payload = pixPayload({ key: w.pix_key, name: w.pix_name || w.name, city: w.pix_city || a.city || 'BRASIL', amountCents: d.total_cents })
    const qr = await QRCode.toDataURL(payload, { margin: 1, width: 300 })
    const py = Math.max(y - notes.length * 6, (doc as any).lastAutoTable.finalY + 22)
    const top = py + 44 > 285 ? (doc.addPage(), M) : py
    doc.setDrawColor(226, 232, 240).roundedRect(W - M - 46, top, 46, 52, 2, 2, 'S')
    doc.addImage(qr, 'PNG', W - M - 41, top + 3, 36, 36)
    doc.setFontSize(8).setTextColor(...INK).text('Pague com Pix', W - M - 23, top + 44, { align: 'center' })
    doc.setFontSize(6.5).setTextColor(...MUTED).text(doc.splitTextToSize(`Chave: ${w.pix_key}`, 42), W - M - 23, top + 48, { align: 'center' })
    y = Math.max(y, top + 56)
  }

  // Rodapé
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFontSize(7.5).setTextColor(148, 163, 184)
    doc.text(d.footer ?? (d.kind === 'RECIBO' ? 'Recibo sem valor fiscal.' : 'Documento sem valor fiscal.'), M, 290)
    doc.text(`Página ${p} de ${pages}`, W - M, 290, { align: 'right' })
  }
  return doc.output('blob')
}

/** Compartilha (celular: WhatsApp etc.) ou baixa o PDF. */
export async function sharePdf(blob: Blob, filename: string, text?: string) {
  const file = new File([blob], filename, { type: 'application/pdf' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename, text }); return 'shared' } catch { /* cancelado: baixa */ }
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return 'downloaded'
}
