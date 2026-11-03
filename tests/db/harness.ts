// Banco PostgreSQL embutido para testes de migrações e políticas (sem Docker).
// Usa os binários do pacote @embedded-postgres e sobe via pg_ctl, que no
// Windows rebaixa privilégios (o postgres.exe recusa rodar como administrador).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const ROOT = join(import.meta.dirname, '..', '..')
const PORT = Number(process.env.TEST_PG_PORT ?? 54399)
const DATA_DIR = join(ROOT, '.tmp', 'pgdata')
const BIN = join(ROOT, 'node_modules', '@embedded-postgres', `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, 'native', 'bin')
const exe = (n: string) => join(BIN, process.platform === 'win32' ? `${n}.exe` : n)

export const ADMIN_URL = `postgres://postgres:postgres@localhost:${PORT}/postgres`
export const TEST_DB_URL = `postgres://postgres:postgres@localhost:${PORT}/mecgest_test`

// stdio 'ignore': o servidor herda os descritores e, com pipes, o execFileSync nunca retornaria
function pgctl(args: string[]) {
  execFileSync(exe('pg_ctl'), args, { stdio: 'ignore', timeout: 60_000 })
}

export async function startDb() {
  if (!existsSync(BIN)) throw new Error(`Binários do Postgres não encontrados em ${BIN}`)
  try { pgctl(['stop', '-D', DATA_DIR, '-m', 'immediate']) } catch { /* não estava rodando */ }
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const pw = join(ROOT, '.tmp', 'pgpass.txt')
  writeFileSync(pw, 'postgres')
  execFileSync(exe('initdb'), ['-D', DATA_DIR, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile', pw, '-E', 'UTF8',
    '--locale=C', '--no-sync'], { stdio: 'pipe' })
  pgctl(['start', '-D', DATA_DIR, '-w', '-l', join(ROOT, '.tmp', 'pg.log'), '-o', `-p ${PORT} -c fsync=off -c timezone=UTC`])

  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query('create database mecgest_test')
  await admin.end()

  const client = new pg.Client({ connectionString: TEST_DB_URL })
  await client.connect()
  try {
    await client.query(readFileSync(join(ROOT, 'tests', 'db', 'supabase_stubs.sql'), 'utf8'))
    const dir = join(ROOT, 'supabase', 'migrations')
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'))
      } catch (e) {
        const err = e as Error & { position?: string; where?: string }
        const sql = readFileSync(join(dir, file), 'utf8')
        const pos = Number(err.position ?? 0)
        const line = pos ? sql.slice(0, pos).split('\n').length : '-'
        throw new Error(`Migração ${file} falhou na linha ${line}: ${err.message}\n${err.where ?? ''}`)
      }
    }
  } finally {
    await client.end()
  }
}

export async function stopDb() {
  try { pgctl(['stop', '-D', DATA_DIR, '-m', 'fast']) } catch { /* já parado */ }
}
