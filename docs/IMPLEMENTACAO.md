# Implementação — decisões, checklist e checkpoint

## Decisões

- **Stack**: React 19 + TS + Vite 8 + Tailwind 4 + TanStack Query 5 + React Router 8 + Supabase (Postgres 17, Auth, Storage, Edge Functions, pg_cron). Repositório começou vazio; segue a proposta da especificação.
- **Segurança no banco, não na tela.** Toda tabela de oficina tem RLS. A autorização consulta a associação **ativa** a cada chamada (`private.has_perm`), nunca permissões guardadas no JWT — bloqueio tem efeito imediato.
- **Escrita sensível só por RPC** (`security definer`, `search_path` fixo). INSERT/UPDATE/DELETE diretos em OS, itens, orçamentos, estoque, financeiro, equipe e fila foram revogados do papel `authenticated`. Cadastros simples (clientes, veículos, peças, fornecedores, catálogo) usam escrita direta protegida por RLS.
- **Visibilidade de campo** por separação de tabelas: custos em `order_item_costs`/`product_costs` (exigem `costs.view`); preços em `order_items` exigem `prices.view`. O mecânico lê a OS por `order_detail()`, que monta o JSON conforme as permissões.
- **Isolamento** com chaves compostas `(workshop_id, id)` em todos os vínculos: o banco recusa ligar registros de oficinas diferentes.
- **Dinheiro em centavos (`bigint`)**; quantidade `numeric(12,3)`/`numeric(14,3)` com casas decimais por produto. Arredondamento por item: `round_half_up(qtd × unitário) − desconto`.
- **Concorrência**: coluna `version` incrementada por gatilho; RPCs recebem `p_expected_version` e devolvem erro `40001`. Agenda usa *exclusion constraints* (box e funcionário). Estoque trava a linha de saldo. Idempotência por chaves únicas (`quote_item_id`, `idempotency_key`, `(cycle_id, step)`, decisão única por versão).
- **Datas**: instantes em UTC; datas de vencimento como `date` local; conversões usam o fuso da oficina. Fim de mês segue a regra do PostgreSQL (31/01 + 1 mês = 28/02 ou 29/02).
- **Portal**: token aleatório de 256 bits no fragmento da URL (`/portal#t=…`, não vai para logs nem Referer), só o hash SHA‑256 no banco, validade, revogação. Aprovação usa link separado + código de 6 dígitos (hash) com 5 tentativas.
- **Testes sem Docker**: Docker não sobe nesta máquina; criamos um harness com o PostgreSQL embutido (`@embedded-postgres`) + simulação mínima de `auth`/`storage`. Também roda no CI.
- **Nome**: oficina inicial "mecgest360" (configurável em Configurações). Nome do produto: MecGest 360.

## Bugs encontrados pelos testes e corrigidos

1. Bloqueio por força bruta no portal não persistia: a exceção desfazia o contador de tentativas. `portal_decide` agora grava a tentativa e devolve `{ok:false}`.
2. Cancelar OS/item não devolvia o saldo **reservado** do estoque. Criada `private.release_reservations`.

## Checklist de requisitos

Legenda: ✅ implementado e testado · 🟢 implementado (sem teste automatizado de ponta a ponta) · 🟡 parcial · ⛔ bloqueado por dependência externa · ⬜ pendente

### Fase 1 — Fundação
- ✅ Oficinas, perfis, associações, convites (token único, hash, expiração, revogação ao reenviar)
- ✅ 7 perfis com matriz padrão + ajustes individuais (conceder/negar) + prévia textual do acesso
- ✅ Escopo de OS (atribuídas/todas) separado de visibilidade de campos
- ✅ Bloqueio com efeito imediato; último proprietário protegido; sem auto-alteração; sem escalada
- ✅ Auditoria por gatilho (sem tokens/senhas) + auditoria de exportações e fusões
- ✅ Clientes PF/PJ, duplicidade por telefone/documento sem bloquear, fusão revisada
- ✅ Veículos: placa antiga/Mercosul, exceção justificada, código provisório sem placa
- ✅ Propriedade com período; transferência preserva histórico técnico sem expor dono anterior
- ✅ Km como histórico: regressão exige justificativa; leituras imutáveis; invalidação com motivo
- 🟢 Telas: login, recuperação de senha, aceite de convite, equipe, clientes, veículos, configurações
- ⛔ MFA para administradores: suportado pelo Supabase Auth (TOTP), falta a tela de cadastro do fator

### Fase 2 — Operação
- ✅ Agenda com conflito de box/funcionário no banco, horário de funcionamento, pausas, bloqueios, encaixe com permissão
- ✅ Reagendamento preserva histórico; cancelamento com motivo; não comparecimento gera tarefa
- ✅ Conversão de agendamento em OS idempotente (cliques simultâneos)
- ✅ Máquina de estados da OS validada no backend; pendência de peças como bloqueio paralelo
- ✅ Checklist de entrada/qualidade configurável com ciência do cliente
- ✅ Apontamento com temporizador único por funcionário; edição exige justificativa
- ✅ Aditivo após aprovação fica pendente; autorização presencial registrada como exceção
- ✅ "Pronta" exige revisão de itens, checklist, decisão preventiva, peças resolvidas e timers fechados
- ✅ Entrega com situação de pagamento; saldo a receber só com permissão e registro
- ✅ Reabertura com permissão e justificativa sem duplicar peças/receitas/lembretes
- ✅ Orçamentos versionados e imutáveis após envio; nova versão invalida a anterior e revoga links
- ✅ Aprovação parcial com conjuntos/dependências; recusados viram recomendações
- ✅ Decisão idempotente; vencido/substituído não aprova
- ✅ Portal: acompanhamento, aprovação com código, km, pedido de contato/horário, parar lembretes
- 🟢 Fotos com câmera, bucket privado e URLs temporárias; política de storage testada
- 🟢 Impressão/PDF de OS e orçamento via impressão do navegador (sem custos)
- 🟢 Retorno em garantia como nova OS vinculada
- 🟡 PDF gerado no servidor (hoje: imprimir/salvar como PDF no navegador)

### Fase 3 — Preventiva e retorno
- ✅ Planos por veículo/componente sem intervalos universais; fonte obrigatória
- ✅ Regra "o que vier primeiro", só data, só km; fim de mês testado
- ✅ Estimativa de km/dia com descarte de incoerências; "estimado" nunca é "vencido"
- ✅ Situação técnica separada da comercial; painel com filtros e ações
- ✅ Nova execução encerra ciclo, cancela lembretes e abre o próximo com data/km reais
- ✅ Agendamento/pagamento não concluem; alinhamento não reinicia óleo (vínculo por componente)
- ✅ Feito em outra oficina sem fabricar OS/receita
- ✅ Consentimento por finalidade com histórico; retirada cancela fila; promoções exigem opt-in
- ✅ Fila com idempotência, trava (`skip locked`), checagem final antes do envio, janela de horário, limite e intervalo
- ✅ Webhooks idempotentes e sem regressão; envio incerto vai para revisão; comando PARAR
- 🟢 Modo manual WhatsApp (wa.me) registrando só "conversa aberta"
- 🟢 Agrupamento de ciclos do mesmo cliente numa mensagem
- ⛔ Envio automático real: adaptador pronto (Cloud API), **pendente de credenciais Meta e templates aprovados**

### Fase 4 — Gestão
- ✅ Estoque físico/reservado/disponível; saldo só por movimento; consumo e devolução uma única vez
- ✅ Concorrência na última unidade; negativo só com permissão e justificativa
- ✅ Custo médio ponderado e custo aplicado salvo na OS
- ✅ Compras com recebimento parcial, idempotente, gerando conta a pagar
- ✅ Contas a receber/pagar, parcelas, pagamento parcial, idempotência, estorno sem apagar
- ✅ Caixa com abertura, movimentos, fechamento e diferença com observação obrigatória
- 🟢 Inventário com contagem e ajuste auditado
- 🟢 Comissões por competência/recebimento com aprovação e estorno
- 🟢 Relatórios com definições explícitas; exportação CSV segura e registrada
- 🟢 Recibo não fiscal
- ⬜ Conciliação: há marcação manual (`reconcile_payment`) sem tela dedicada

### Fase 5 — Confiabilidade e entrega
- ✅ 40 testes de integração (RLS/RPC) + 11 unitários; CI no GitHub Actions
- 🟢 Responsividade e acessibilidade básicas (rótulos, foco visível, status com texto, teclado)
- ⬜ Testes E2E de navegador (Playwright instalado; cenários ainda não escritos)
- ⬜ Divisão de código (bundle único de ~830 kB, 234 kB gzip)
- ⛔ Backup/restauração: depende do plano do Supabase; procedimento em OPERACAO.md, não validado
- ⬜ Rate limit por IP nas RPCs públicas (tokens de 256 bits tornam adivinhação inviável; limite por IP exige proxy/Edge)

## Checkpoint

Estado em 03/11/2026: banco completo (6 migrações), 6 Edge Functions, frontend com todos os módulos, scripts de provisionamento e demo, testes verdes. Próximos passos sugeridos, em ordem:
1. Ligar o projeto Supabase na nuvem (`supabase link`, `db push`, `functions deploy`) e criar o proprietário com `scripts/provision.ts`.
2. Escrever os E2E Playwright dos fluxos 4, 5 e 15 contra o ambiente de demonstração.
3. Tela de MFA (TOTP) para proprietário/gerente.
4. Code-splitting por rota (`React.lazy`).
5. Credenciais da API oficial do WhatsApp → ativar modo automático.
