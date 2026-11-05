// Mede carregamento como num celular em 4G fraco (versão de produção, Supabase local).
// Uso: npx vite build --mode e2e && npx vite preview --mode e2e --port 5299 & npx tsx e2e/perf.ts
import { chromium, devices } from '@playwright/test'

const BASE = 'http://localhost:5299'
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['Pixel 7'] })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

let bytes = 0
page.on('response', async (r) => { const len = Number(r.headers()['content-length'] ?? 0); bytes += len })

const t0 = Date.now()
await page.goto(`${BASE}/entrar`)
await page.getByRole('button', { name: 'Entrar' }).waitFor()
const loginMs = Date.now() - t0
const loginKb = Math.round(bytes / 1024)

await page.getByLabel('E-mail').fill('dono.e2e@mecgest.test')
await page.getByLabel('Senha').fill('Teste-e2e-12345')
const t1 = Date.now()
await page.getByRole('button', { name: 'Entrar' }).click()
await page.waitForURL((u) => !u.pathname.startsWith('/entrar'))
await page.getByText(/Bom dia|Boa tarde|Boa noite/).first().waitFor()
const homeMs = Date.now() - t1

// navegação entre telas já com cache
const t2 = Date.now()
await page.goto(`${BASE}/os`)
await page.getByRole('heading', { name: 'Serviços' }).waitFor()
const osMs = Date.now() - t2

console.log(JSON.stringify({ login_tela_ms: loginMs, login_kb_transferidos: loginKb, inicio_apos_login_ms: homeMs, servicos_ms: osMs }))
await browser.close()
