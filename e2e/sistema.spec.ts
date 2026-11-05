// Ponta a ponta: o sistema usado como na oficina, no celular e no computador.
import { expect, test, type Page } from '@playwright/test'

const PASS = 'Teste-e2e-12345'
const OWNER = 'dono.e2e@mecgest.test'
const MECH = 'mecanico.e2e@mecgest.test'

// erros de console/JS em qualquer tela reprovam o teste
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(functions|storage)/.test(m.text())) errors.push(`console: ${m.text()}`) })
  return errors
}

async function login(page: Page, email: string) {
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(PASS)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'))
  const resumo = page.getByRole('dialog', { name: 'Resumo do dia' })
  if (await resumo.isVisible({ timeout: 4000 }).catch(() => false)) await resumo.getByRole('button', { name: 'Entendi' }).click()
}

const plateFor = (p: string) => (p === 'celular' ? 'CEL' : 'DSK') + Math.floor(1 + Math.random() * 8) + 'A' + String(Math.floor(10 + Math.random() * 89))

test('receber carro → serviço → pronto com retorno → entregar com Pix → gastos e PDF', async ({ page }, info) => {
  const errors = watchErrors(page)
  const plate = plateFor(info.project.name)
  await login(page, OWNER)

  await page.goto('/receber')
  await page.getByRole('button', { name: /Escolher cliente e carro/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Qual cliente?' })
  await sheet.getByRole('button', { name: 'Novo cliente' }).click()
  const form = page.getByRole('dialog', { name: 'Novo cliente' })
  await form.getByLabel('Nome *').fill(`Cliente ${info.project.name}`)
  await form.getByLabel('WhatsApp').fill('49999990000')
  await form.getByLabel('Placa *').fill(plate)
  await form.getByLabel('Carro *').fill('Onix')
  await form.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('O que precisa ser feito? *').fill('Barulho na suspensão dianteira')
  await page.getByLabel('Km do painel').fill('48500')
  await page.getByRole('button', { name: 'Receber carro', exact: true }).click()
  await page.waitForURL(/\/os\/[0-9a-f-]{36}/)
  await expect(page.getByText(plate.slice(0, 3)).first()).toBeVisible()

  await page.getByRole('button', { name: 'Adicionar serviço' }).click()
  const add = page.getByRole('dialog', { name: 'Adicionar serviço ou peça' })
  await add.getByLabel('O que é?').fill('Troca de amortecedores')
  await add.getByLabel('Valor (R$)').fill('850,00')
  await add.getByRole('button', { name: 'Adicionar', exact: true }).click()
  await expect(page.getByText('Troca de amortecedores').first()).toBeVisible()

  await page.getByRole('button', { name: 'Começar serviço' }).click()
  await page.getByRole('button', { name: 'Pronto para entrega' }).click()
  const fin = page.getByRole('dialog', { name: 'Pronto para entrega' })
  await fin.getByRole('button', { name: '1 ano' }).first().click()
  await fin.getByRole('button', { name: '20 mil km' }).first().click()
  await fin.getByRole('button', { name: /Pronto e criar 1 lembrete/ }).click()
  await expect(page.getByText(/1 ano ou 20 mil km/)).toBeVisible()

  // gastos e quanto sobrou
  await page.getByLabel('Descrição do gasto').fill('Amortecedores (fornecedor)')
  await page.getByLabel('Valor do gasto').fill('420,00')
  await page.getByRole('button', { name: 'Anotar' }).click()
  await expect(page.getByText('R$ 430,00')).toBeVisible()

  await page.getByRole('button', { name: 'Entregar o carro' }).click()
  const dlv = page.getByRole('dialog', { name: 'Entregar o carro' })
  await dlv.getByRole('button', { name: /Pagou agora/ }).click()
  await dlv.getByRole('button', { name: 'Pix', exact: true }).click()
  await expect(dlv.getByRole('img', { name: 'QR Code Pix' })).toBeVisible()
  await dlv.getByRole('button', { name: 'Confirmar entrega' }).click()
  await expect(page.getByText('Carro entregue')).toBeVisible()

  // PDF do serviço
  const dl = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PDF' }).click()
  expect((await dl).suggestedFilename()).toMatch(/^OS-\d+\.pdf$/)
  expect(errors).toEqual([])
})

test('orçamento → mandar → cliente aprova pelo portal com código e vê o Pix', async ({ page, context }, info) => {
  const errors = watchErrors(page)
  await login(page, OWNER)
  await page.goto('/orcamentos/novo')
  await page.getByRole('button', { name: /Escolher cliente e carro/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Qual cliente?' })
  await sheet.getByRole('button', { name: /Novo cliente/ }).click()
  const form = page.getByRole('dialog', { name: 'Novo cliente' })
  await form.getByLabel('Nome *').fill(`Orçamento ${info.project.name}`)
  await form.getByLabel('Placa *').fill(plateFor(info.project.name))
  await form.getByLabel('Carro *').fill('HB20')
  await form.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('Descrição').first().fill('Alinhamento e balanceamento')
  await page.getByLabel('Unitário').first().fill('150,00')
  await page.getByRole('button', { name: 'Mandar para o cliente' }).click()
  const link = page.getByRole('dialog', { name: /Link de aprovação/ })
  await link.getByRole('button', { name: 'Gerar link' }).click()
  const url = await link.getByLabel('Link').inputValue()
  const code = (await link.locator('strong.tracking-widest').innerText()).trim()
  expect(url).toContain('/portal#t=')

  const portal = await context.newPage()
  const pErrors = watchErrors(portal)
  await portal.goto(url)
  await expect(portal.getByText('Alinhamento e balanceamento')).toBeVisible()
  await expect(portal.getByRole('img', { name: 'QR Code Pix' })).toBeVisible()
  await portal.getByLabel('Seu nome').fill('Cliente Teste')
  await portal.getByLabel(/Código de verificação/).fill(code)
  await portal.getByLabel(/Li os itens e valores/).check()
  await portal.getByRole('button', { name: 'Aprovar orçamento' }).click()
  await expect(portal.getByText(/Decisão registrada/).first()).toBeVisible()
  expect([...errors, ...pErrors]).toEqual([])
})

test('agenda simples: marcar horário e "chegou" abre o serviço', async ({ page }) => {
  const errors = watchErrors(page)
  await login(page, OWNER)
  await page.goto('/agenda')
  await page.getByRole('button', { name: 'Marcar horário' }).click()
  const dlg = page.getByRole('dialog', { name: 'Marcar horário' })
  await dlg.getByRole('button', { name: /Escolher cliente e carro/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Qual cliente?' })
  await sheet.locator('ul li').first().getByRole('button').first().click()
  await expect(sheet).toBeHidden()
  await dlg.getByLabel('O que vai fazer?').fill('Revisão')
  await dlg.getByRole('button', { name: 'Marcar', exact: true }).click()
  await expect(page.getByText('Revisão').first()).toBeVisible()
  await page.getByRole('button', { name: 'Chegou' }).first().click()
  await page.waitForURL(/\/os\/[0-9a-f-]{36}/)
  expect(errors).toEqual([])
})

test('todas as telas do menu abrem sem erro', async ({ page }) => {
  const errors = watchErrors(page)
  await login(page, OWNER)
  for (const path of ['/', '/os', '/orcamentos', '/agenda', '/clientes', '/veiculos', '/preventiva', '/contatos', '/financeiro', '/estoque',
    '/indicadores', '/funcionarios', '/configuracoes']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('alert').filter({ hasText: /erro|permissão|Could not|relationship/i }), `tela ${path}`).toHaveCount(0)
  }
  // detalhes de cliente e veículo
  await page.goto('/clientes')
  await page.getByRole('link').filter({ hasText: /Cliente/ }).first().click()
  await page.waitForLoadState('networkidle')
  await page.goto('/veiculos')
  await page.locator('tbody tr').first().click()
  await page.waitForLoadState('networkidle')
  await expect(page.getByText('Quilometragem')).toBeVisible()
  expect(errors).toEqual([])
})

test('funcionário: dono cria acesso e o mecânico não vê valores nem financeiro', async ({ page, browser }) => {
  const errors = watchErrors(page)
  await login(page, OWNER)
  await page.goto('/funcionarios')
  await page.getByRole('button', { name: 'Adicionar' }).click()
  const dlg = page.getByRole('dialog', { name: 'Adicionar funcionário' })
  await dlg.getByLabel('Nome').fill('Atendente Teste')
  await dlg.getByLabel(/E-mail/).fill(`atendente.${Date.now()}@mecgest.test`)
  await dlg.getByRole('button', { name: /Atendente/ }).click()
  await dlg.getByRole('button', { name: 'Criar acesso' }).click()
  await expect(page.getByRole('dialog', { name: 'Convite pronto' })).toBeVisible()
  expect(errors).toEqual([])

  const ctx = await browser.newContext()
  const mech = await ctx.newPage()
  const mErrors = watchErrors(mech)
  await login(mech, MECH)
  await mech.goto('/os?f=todas')
  await mech.locator('a[href^="/os/"]').first().click()
  await mech.waitForURL(/\/os\/[0-9a-f-]{36}/)
  await mech.waitForLoadState('networkidle')
  await expect(mech.locator('main').getByText(/R\$/)).toHaveCount(0)
  await mech.goto('/financeiro')
  await expect(mech.getByText('Você não tem permissão para esta ação.')).toBeVisible()
  expect(mErrors).toEqual([])
  await ctx.close()
})
