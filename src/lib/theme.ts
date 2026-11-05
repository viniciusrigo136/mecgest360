// Tema claro é o padrão; escuro é opção do usuário (lembrada neste aparelho).
const KEY = 'mecgest.theme'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0F172A' : '#F8FAFC')
  try { localStorage.setItem(KEY, t) } catch { /* armazenamento indisponível */ }
}
