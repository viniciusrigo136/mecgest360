// Utilitários para testar o banco como usuários reais (RLS + RPC).
import pg from 'pg'
import { TEST_DB_URL } from './harness.ts'

export const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 6 })

export type Q = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>

/** Executa como superusuário (setup de dados), numa transação confirmada. */
export async function admin<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return run(null, 'postgres', fn)
}

/** Executa como um usuário autenticado (ou anon quando userId = null). */
export async function as<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  return run(userId, userId ? 'authenticated' : 'anon', fn)
}

async function run<T>(userId: string | null, role: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    if (role !== 'postgres') {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(userId ? { sub: userId, role } : { role })])
      await c.query(`set local role ${role}`)
    }
    const q: Q = async (sql, params) => (await c.query(sql, params as any[])).rows
    const r = await fn(q)
    await c.query('commit')
    return r
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/** Chama uma RPC e devolve a primeira coluna da primeira linha. */
export async function rpc<T = any>(userId: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args)
  const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
  const rows = await as(userId, (q) => q(sql, keys.map((k) => toPg(args[k]))))
  if (!rows.length) return undefined as T
  const row = rows[0]
  const cols = Object.keys(row)
  return (cols.length === 1 ? row[cols[0]] : row) as T
}

export async function rpcRows<T = any>(userId: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const keys = Object.keys(args)
  const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
  return as(userId, (q) => q(sql, keys.map((k) => toPg(args[k]))))
}

function toPg(v: unknown) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) return JSON.stringify(v)
  if (Array.isArray(v) && v.some((x) => typeof x === 'object' && x !== null)) return JSON.stringify(v)
  return v
}

let seq = 0
export async function createUser(name: string): Promise<string> {
  seq++
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now()}.${seq}@teste.local`
  const [u] = await admin((q) => q<{ id: string }>(
    `insert into auth.users(email, raw_user_meta_data) values ($1, $2) returning id`, [email, { full_name: name }]))
  return u.id
}

export async function emailOf(userId: string) {
  const [u] = await admin((q) => q<{ email: string }>('select email from auth.users where id = $1', [userId]))
  return u.email
}

export async function provision(name: string, ownerId: string): Promise<string> {
  const [r] = await admin((q) => q<{ id: string }>('select public.provision_workshop($1, $2, true) as id', [name, ownerId]))
  return r.id
}

/** Cria membro via fluxo real de convite (create_invite → accept_invite). */
export async function addMember(ws: string, ownerId: string, name: string, role: string,
                                opts: { scope?: string; overrides?: Record<string, boolean> } = {}) {
  const uid = await createUser(name)
  const inv = await rpc<{ token: string }>(ownerId, 'create_invite', {
    p_workshop: ws, p_email: await emailOf(uid), p_full_name: name, p_role: role,
    p_order_scope: opts.scope ?? 'all', p_overrides: opts.overrides ?? {},
  })
  await rpc(uid, 'accept_invite', { p_token: inv.token })
  const [m] = await admin((q) => q<{ id: string }>('select id from memberships where workshop_id = $1 and user_id = $2', [ws, uid]))
  return { userId: uid, membershipId: m.id }
}

export async function expectError(p: Promise<unknown>, match?: RegExp | string) {
  try {
    await p
  } catch (e) {
    const msg = (e as Error).message
    if (match && !(typeof match === 'string' ? msg.includes(match) : match.test(msg))) {
      throw new Error(`Erro inesperado: "${msg}" (esperado ${match})`)
    }
    return msg
  }
  throw new Error(`Era esperado erro${match ? ` (${match})` : ''}, mas a operação foi concluída`)
}

/** Cliente + veículo pelo cadastro rápido. */
export async function quickClient(userId: string, ws: string, name: string, plate: string, km?: number) {
  return rpc<{ client_id: string; vehicle_id: string }>(userId, 'quick_register', {
    p_workshop: ws, p_client: { name, phone: '(11) 98888-7777' },
    p_vehicle: { plate, brand: 'Fiat', model: 'Argo', year_model: '2021' }, p_km: km ?? null,
  })
}
