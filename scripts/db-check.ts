// Aplica todas as migrações num Postgres embutido e informa o resultado.
import { startDb, stopDb } from '../tests/db/harness.ts'

try {
  await startDb()
  console.log('OK: todas as migrações aplicadas sem erro.')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await stopDb()
}
