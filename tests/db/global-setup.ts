import { startDb, stopDb } from './harness.ts'

export async function setup() {
  await startDb()
}

export async function teardown() {
  await stopDb()
}
