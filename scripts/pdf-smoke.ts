import { writeFileSync } from 'node:fs'
import { buildPdf } from '../src/lib/pdf.ts'
const blob = await buildPdf({
  kind: 'ORÇAMENTO', number: 'ORC-00017', date: '2026-11-05', validity: '2026-11-12', pix: true,
  workshop: { name: 'JC Mecânica (teste)', phone: '49999416011', address: { city: 'Chapecó', state: 'SC' }, pix_key: 'oficina@pix.com', pix_name: 'JC Mecanica', pix_city: 'Chapeco' },
  client: { name: 'Cliente Exemplo', phone: '5549999990000' }, vehicle: { plate: 'ABC1D23', label: 'Chevrolet Onix 2021', km: 48500 },
  items: [{ description: 'Troca de amortecedores dianteiros', quantity: 1, unit_cents: 45000, total_cents: 45000 }, { description: 'Amortecedor dianteiro', quantity: 2, unit_cents: 32000, discount_cents: 4000, total_cents: 60000 }],
  total_cents: 105000, discount_cents: 4000, notes: ['Prazo estimado: 1 dia(s).', 'Pagamento: Pix ou cartão em até 3x.'],
})
const buf = Buffer.from(await blob.arrayBuffer())
writeFileSync(process.argv[2], buf)
console.log('pdf bytes', buf.length, buf.subarray(0, 5).toString())
