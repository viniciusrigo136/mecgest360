// Provisiona uma oficina e convida o proprietário inicial por e-mail.
// Uso (no seu terminal, nunca no navegador):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... APP_URL=https://seu-app \
//   npx tsx scripts/provision.ts --nome "Minha Oficina" --email dono@exemplo.com --nome-dono "Fulano"
// O proprietário recebe um link para definir a própria senha. Não existe senha padrão.
import { createClient } from '@supabase/supabase-js'

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const app = process.env.APP_URL ?? 'http://localhost:5173'
const name = arg('nome'), email = arg('email'), ownerName = arg('nome-dono') ?? ''
if (!url || !key || !name || !email) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente e passe --nome e --email.')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { persistSession: false } })

let userId: string | undefined
const invited = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${app}/redefinir-senha`, data: { full_name: ownerName } })
if (invited.error) {
  if (!/already|registered|exists/i.test(invited.error.message)) throw invited.error
  // usuário já existe: localiza pelo e-mail
  for (let page = 1; !userId && page < 50; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    userId = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id
    if (data.users.length < 200) break
  }
  console.log('Usuário já existia; ele poderá entrar com a senha atual ou pelo "Esqueci minha senha".')
} else {
  userId = invited.data.user.id
  console.log(`Convite enviado para ${email}. O link leva à tela de definição de senha.`)
}
if (!userId) throw new Error('Não foi possível identificar o usuário')

const { data: ws, error } = await admin.rpc('provision_workshop', { p_name: name, p_owner_user: userId, p_is_demo: false })
if (error) throw error
console.log(`Oficina "${name}" criada (id ${ws}). Proprietário: ${email}.`)
