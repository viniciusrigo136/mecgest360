# PROMPT PARA CLAUDE — SISTEMA COMPLETO DE GESTÃO DE OFICINA AUTOMOTIVA

> Copie este documento para o Claude Code ou anexe-o ao projeto. Todo o texto abaixo é a especificação de desenvolvimento. O nome é provisório e pode ser alterado nas configurações.

## 1. Seu papel e resultado esperado

Atue como desenvolvedor full-stack sênior, arquiteto de software e designer de produto. Desenvolva um sistema web real para uma oficina mecânica de carros, com banco de dados, autenticação, permissões, regras de negócio e interface responsiva. Entregue implementação funcional, não apenas planejamento, telas demonstrativas ou uma landing page.

O produto deve organizar a operação da oficina e estimular o retorno dos clientes para manutenção preventiva. O eixo central é: cliente → veículo → agendamento → ordem de serviço → orçamento aprovado → execução → pagamento/entrega → histórico → próxima manutenção → retorno.

Começaremos com uma oficina, mas a arquitetura deve isolar os dados por oficina para permitir atender outras no futuro. Não implementar venda de assinaturas nem marketplace neste momento. Não transformar este projeto em uma plataforma excessivamente complexa antes de concluir os fluxos principais.

Nome provisório: **Oficina 360**. Não implica disponibilidade comercial da marca. Interface integralmente em português do Brasil, valores em reais e datas brasileiras. Fuso padrão America/Sao_Paulo, configurável por oficina.

## 2. Como trabalhar

1. Inspecione o repositório e suas instruções antes de alterar arquivos. Reaproveite a stack e os componentes existentes quando adequados. Não sobrescreva trabalho anterior.
2. Se estiver vazio, use como proposta inicial React + TypeScript + Vite, Tailwind, componentes acessíveis, React Hook Form, Zod, TanStack Query e Supabase para PostgreSQL, Auth, Storage e funções de backend. Verifique compatibilidade e documentação oficial atual antes de instalar. Não migrar um projeto existente só por preferência.
3. Centralize operações sensíveis no backend ou em funções transacionais protegidas. Nunca dependa apenas da interface para autorização, preços, estoque ou pagamentos.
4. Registre decisões e o plano em docs/IMPLEMENTACAO.md. Desenvolva por fases, mas mantenha todo este escopo no backlog. Não encerre o trabalho após criar o plano.
5. Faça escolhas técnicas razoáveis sem interromper a cada detalhe. Pergunte somente quando faltar uma decisão que bloqueie a implementação ou exigir contratação/credenciais externas.
6. Use integrações reais quando configuradas. Na ausência de credenciais, implemente o adaptador, configuração e testes locais, identificando a integração como pendente. Nunca mostre envio, pagamento ou backup fictício como concluído.
7. Use dados fictícios somente em ambiente de demonstração/teste, com identificação clara e separados da produção.
8. Não prometa sistema sem falhas. Demonstre funcionamento por testes e reporte limitações concretas.
9. Ao concluir cada fase, registre o implementado, o validado e o que falta. Se houver limite de contexto, atualize um checkpoint que permita continuar sem refazer o trabalho.

## 3. Usuários, equipe e permissões

Cada pessoa terá conta individual. O proprietário poderá cadastrar/convidar funcionários, definir perfil e permissões, limitar acesso a ordens atribuídas e bloquear usuários. Não compartilhar uma senha entre a equipe.

### Perfis iniciais

| Perfil | Acesso padrão |
| --- | --- |
| Proprietário | Gestão completa da própria oficina, equipe, permissões, integrações, relatórios e configurações. |
| Gerente | Operação, clientes, agenda, OS, orçamentos, estoque e relatórios operacionais. Financeiro e gestão de equipe somente se concedidos. |
| Recepção/atendimento | Clientes, veículos, agenda, entrada/saída, orçamento comercial e contatos; sem custos, margens, caixa geral ou permissões. |
| Mecânico | Somente OS atribuídas, dados técnicos necessários, checklist, fotos, diagnóstico, tarefas e apontamento de tempo. Sem custos, preços comerciais por padrão, financeiro, exportações ou base completa de clientes. |
| Financeiro | Contas a pagar/receber, pagamentos, caixa e relatórios financeiros; identificação mínima das OS e clientes necessária à cobrança. Sem alterar diagnósticos ou conceder acesso. |
| Estoquista | Peças, fornecedores, compras, reservas, movimentações e identificação das OS; sem caixa, base completa de clientes ou gestão de equipe. |
| Consulta | Somente leitura dos módulos explicitamente permitidos. Sem exportar por padrão. |

O cliente acessa um portal restrito ao seu atendimento; não é membro da equipe.

### Permissões granulares

Implementar ações por recurso: visualizar, criar, editar, arquivar, cancelar, aprovar, exportar, imprimir e administrar, quando aplicáveis. Permissões adicionais: visualizar custos, visualizar margens, conceder desconto acima do limite, receber pagamento, estornar pagamento, ajustar estoque, reabrir OS, visualizar todas as OS, alterar atribuições, gerenciar equipe, gerenciar integrações e enviar mensagens.

Separar escopo de registros (próprios/atribuídos/todos da oficina) de visibilidade de campos. Exibir uma OS não deve permitir ao mecânico consultar custos por outra rota. Negar acesso por padrão. O frontend adapta menus; o backend e as políticas do banco garantem o bloqueio. Aplicar a mesma proteção em relatórios, buscas, PDFs, anexos, exportações e eventos em tempo real.

### Gestão de funcionários

- Convite com nome, e-mail, função, perfil e escopo; token temporário, revogável e de uso único.
- Estados: convite pendente, ativo e bloqueado. Reenvio revoga convite anterior.
- Redefinição de senha pelo mecanismo seguro de autenticação; o administrador não vê senhas.
- Bloqueio remove acesso efetivo no backend, mesmo com sessão antiga aberta; preservar autoria histórica.
- Verificar associação ativa à oficina em toda operação. Não confiar exclusivamente em permissões antigas gravadas no token.
- Impedir remoção/bloqueio do último proprietário e escalada de privilégios pelo próprio funcionário.
- Alterações de perfil e permissões ficam na auditoria. Somente proprietário concede privilégios de proprietário.
- Tela de prévia textual do acesso resultante antes de salvar um perfil.
- Funcionários podem ter agenda, especialidades, disponibilidade, horas trabalhadas e comissão opcional. Comissão não equivale a folha de pagamento.

## 4. Navegação e experiência visual

Menu: Visão geral, Agenda, Ordens de serviço, Clientes, Veículos, Orçamentos, Manutenção preventiva, Contatos e retornos, Estoque, Compras e fornecedores, Financeiro, Relatórios, Equipe e Configurações. Mostrar somente módulos permitidos.

Visual profissional de ferramenta de trabalho: fundo claro, navegação azul-marinho/grafite, destaque azul, tipografia legível, tabelas organizadas e cartões compactos. Status devem ter texto e cor. Evitar excesso de gradientes, animações e cartões gigantes. Nome, logo e cor principal configuráveis.

Priorizar rapidez no balcão e uso pelo mecânico no celular: busca por placa/nome/telefone/OS, ações claras, formulários por etapas, câmera para fotos, filtros persistentes e botões confortáveis. Usar paginação e busca no servidor. Suportar teclado, foco visível, rótulos, contraste e mensagens de erro úteis.

Telas precisam de estados de carregamento, vazio, erro, sem permissão e sucesso real. Prevenir duplo envio e avisar sobre alterações não salvas. Não guardar dados sensíveis em cache público. Se houver PWA, não simular operação offline: sem conexão, informar que alterações dependem de reconexão, salvo se houver sincronização implementada e testada.

## 5. Configuração inicial e painel

Cadastro inicial da oficina: nome, nome empresarial opcional, documento opcional, endereço, telefone/WhatsApp, e-mail, logo, horário de funcionamento, feriados/bloqueios, boxes de trabalho, responsáveis, meios de pagamento, numeração de OS/orçamentos, termos comerciais e preferências de lembretes.

Proprietário inicial criado por fluxo seguro, nunca por senha fixa pública. Novas oficinas são provisionadas de forma controlada; sem cadastro público irrestrito de empresas nesta versão.

Painel adaptado ao perfil:
- Agendamentos de hoje e próximos dias.
- Veículos na oficina e etapas atuais.
- Orçamentos aguardando aprovação.
- Serviços atrasados e entregas previstas.
- Pendências de peças e estoque baixo.
- Retornos preventivos previstos/vencidos e contatos pendentes.
- Contas vencidas, recebimentos e indicadores financeiros somente para usuários autorizados.
- Atalhos de novo atendimento, nova OS, novo agendamento e localizar veículo.
- Métricas sempre com período e definição; não misturar faturamento previsto com dinheiro recebido.

## 6. Clientes e veículos

### Clientes

Pessoa física/jurídica; nome obrigatório, telefone quando disponível, WhatsApp normalizado, e-mail opcional, CPF/CNPJ opcional, endereço opcional, observações internas, preferências de contato, origem e responsável. Não exigir documento para uma operação que não precisa dele.

Mostrar veículos, atendimentos, orçamentos, pendências, histórico de contatos e situação financeira conforme permissão. Detectar possíveis duplicidades por telefone/documento, sem impedir famílias de compartilhar telefone. Fusões de cadastro exigem revisão e auditoria.

### Veículos

Placa normalizada, marca, modelo, ano fabricação/modelo, versão, motor, combustível, câmbio, cor, chassi opcional, observações e fotos. Permitir cadastro provisório sem placa, com identificador interno. Validação amigável para placas brasileiras; exceções justificadas para veículos de outro país ou sem registro.

Cliente pode ter vários veículos. Registrar proprietário e contato responsável quando diferentes. Mudança de dono preserva histórico técnico, mas não expõe dados pessoais/financeiros do dono anterior ao novo cliente.

Quilometragem é histórico de leituras com data, origem, autor e confirmação. Avisar sobre leitura inferior à anterior; correção/troca de painel deve ter justificativa e trilha, sem apagar o registro anterior.

## 7. Agenda e recepção

Visualização diária, semanal e lista; agendamento por veículo, serviço, duração estimada, funcionário e box. Permitir cadastro rápido de cliente/veículo e agendamentos sem funcionário inicialmente.

Estados: solicitado, confirmado, cliente chegou, convertido em atendimento, concluído, cancelado e não compareceu. Cancelamento mantém motivo. Reagendamento preserva histórico.

Bloquear conflito de recurso e sobreposição, considerando duração, horários, pausas e bloqueios. Exceção só por permissão e justificativa. Validar concorrência no backend, não apenas ao abrir a tela.

Confirmar presença, criar tarefa de contato, enviar lembrete quando configurado e converter agendamento em OS sem duplicação. Não comparecimento pode gerar tarefa de retorno. Portal pode solicitar horários; reserva só é confirmada quando validada contra disponibilidade.

## 8. Ordem de serviço e execução

OS com número único por oficina, cliente, veículo, responsável, mecânicos, origem, entrada, previsão de entrega, quilometragem, combustível aproximado, queixa, diagnóstico, observações internas e observações visíveis ao cliente.

Checklist de entrada configurável: lataria, vidros, pneus, luzes, objetos deixados, avarias, acessórios e fotos. Registrar condições, responsável e aceite de recebimento quando utilizado. O aceite é registro de ciência; não apresentar como certificação jurídica automática.

Fluxo operacional sugerido: aberta → triagem/diagnóstico → aguardando aprovação → aprovada/programada → em execução → controle de qualidade → pronta → entregue. Cancelada é estado terminal com motivo. Pendência de peças é bloqueio identificado, sem perder a etapa operacional.

Status financeiro e de orçamento são independentes. OS entregue pode ter saldo a receber somente mediante permissão e registro. Serviço concluído não significa pago.

Cada OS terá:
- Serviços, peças, quantidades, preços, descontos e total comercial.
- Custos e margem protegidos por permissão.
- Tarefas atribuídas e status por item.
- Diagnóstico, fotos, anexos e linha do tempo.
- Notas internas separadas das informações compartilhadas.
- Apontamento de início/pausa/fim com justificativas de edição e prevenção de temporizadores simultâneos indevidos.
- Requisição, reserva e consumo de peças.
- Serviços de terceiros com fornecedor, custo e prazo.
- Checklist de qualidade, teste e responsável pela liberação.
- Condições de garantia cadastradas pela oficina, sem inventar prazos legais universais.
- Próximas manutenções sugeridas e pendências não executadas.

Validar transições no backend. Mecânico não altera preço ou aprovação do cliente. Novos itens após aprovação exigem aditivo e novo aceite antes de executar, salvo exceção de autorização presencial registrada por perfil autorizado.

Na conclusão, exigir revisão dos itens executados, consumo de peças, checklist e decisão sobre retorno preventivo (cadastrar ou marcar não aplicável). Na entrega, registrar data, responsável, orientações e situação de pagamento.

Reabertura requer permissão e justificativa; preservar histórico e não duplicar peças, receita, cobranças ou lembretes. Retorno em garantia é nova OS vinculada à original, identificando itens e responsabilidade.

## 9. Catálogo, orçamentos e aprovação

Catálogo de serviços com nome, descrição, duração estimada, valor base, categoria e sugestão opcional de manutenção. Catálogo de peças separado. Preços do catálogo são copiados para o orçamento; alterações futuras do catálogo não mudam documentos já aprovados.

Orçamento independente ou vinculado à OS, com validade, serviços, peças, quantidades, desconto, prazo estimado, condições e formas de pagamento. PDF e impressão com identidade da oficina. Custos e margens não aparecem no documento do cliente.

Estados: rascunho, enviado, aprovado, parcialmente aprovado, recusado, expirado e substituído. Versões imutáveis após envio/aprovação, mantendo quem fez cada alteração. Alterar preços/itens cria nova versão e invalida decisões da versão substituída para novas execuções.

Cliente acessa link restrito, vê itens e valores e aprova/recusa com confirmação explícita. Registrar versão, itens, total, nome informado, data e evidência mínima de auditoria. Não alegar assinatura digital certificada. Aprovação parcial respeita dependências entre serviços e não permite remover peça indispensável de um conjunto sem revisão da oficina.

Aprovação presencial/por telefone pode ser registrada por usuário autorizado com canal, responsável e observação, identificada como registro feito pela oficina.

Idempotência: dois cliques ou duas abas não geram duas OS ou aprovações contraditórias. Orçamento vencido/substituído não pode ser aprovado. Valores e descontos sempre recalculados no servidor com aritmética decimal ou centavos inteiros; definir arredondamento por item.

## 10. Portal do cliente

Portal responsivo por link seguro, sem exigir instalação. Mostrar somente atendimento autorizado: resumo do veículo, etapa atual, orçamento vigente, itens aprovados, fotos liberadas, previsão de entrega, documentos e próximos cuidados. Nunca publicar observações internas, dados de funcionários, outros clientes, custos ou margens.

Links com tokens aleatórios de alta entropia, hash armazenado, validade, revogação, escopo e limite de tentativas. Não usar número sequencial de OS, placa ou CPF como segredo. Separar token de acompanhamento de autorização de aprovação; para aprovação financeira, usar verificação adicional por código em canal configurado ou sessão autenticada do cliente. Sem canal de verificação, oferecer aprovação registrada pela oficina, sem fingir validação de identidade.

Evitar tokens em logs, analytics e cabeçalho de referência; páginas privadas sem indexação/cache compartilhado. Downloads privados com autorização e URLs temporárias.

Cliente pode informar quilometragem, pedir reagendamento e solicitar contato. Leituras informadas pelo cliente ficam identificadas e podem exigir validação. Pedido de horário não equivale a confirmação automática.

## 11. Manutenção preventiva — função central

Construir planos por veículo e por tipo de serviço. Não definir intervalos universais de troca de óleo, correia, freios, fluidos ou pneus. Intervalos são informados/validados pelo profissional conforme veículo, fabricante e uso. Templates são editáveis e nunca aplicados silenciosamente.

Campos: veículo, categoria/componente, serviço de origem, data e km reais da execução, intervalo em meses/dias e/ou km, data alvo, km alvo, regra de vencimento, antecedência, fonte da recomendação, observações, responsável e política de contato.

Regra padrão configurável: vence pelo primeiro limite atingido, tempo OU km. Permitir planos somente por data ou somente por km. Datas no fim do mês devem ter cálculo definido e testado. Não inferir que todo serviço exige troca: pode ser inspeção/avaliação.

### Quilometragem

- Leitura real recente permite avaliar limite atingido.
- Se houver pelo menos duas leituras válidas em datas diferentes, pode estimar km/dia, rejeitando intervalos incoerentes e identificando a estimativa.
- Não declarar manutenção vencida por km apenas com projeção. Exibir “retorno estimado” ou “confirmar quilometragem”.
- Ausência de leitura não significa que o cliente não rodou. Pedir atualização quando apropriado.
- Mostrar data e origem da última leitura, confiança da projeção e opção de desativar estimativas.

### Estado do plano e estado do contato

Separar situação técnica (em dia, próximo do prazo, vencido por data, vencido por km confirmado, estimado, aguardando km, concluído, suspenso, cancelado) da situação comercial (não contatado, contato pendente, contatado, respondeu, agendou, adiou, recusou, sem consentimento).

Painel com filtros por prazo, serviço, veículo, responsável e situação. Ações: contatar, registrar resposta, agendar, adiar contato, concluir com evidência, suspender e informar serviço feito em outra oficina.

Ao executar novamente o mesmo serviço, encerrar o ciclo anterior, cancelar contatos pendentes daquele ciclo e criar próximo ciclo com data/km reais. Não concluir manutenção apenas porque foi agendada, paga ou incluída em orçamento. Executar alinhamento não reinicia troca de óleo: vincular explicitamente o tipo/componente atendido. Histórico imutável de ciclos.

Se cliente disser que fez manutenção fora, registrar origem, data/km disponíveis e confirmação necessária. Não fabricar OS nem receita para esse evento.

### Pendências recomendadas

Itens recusados/adiados geram recomendações separadas, com motivo, prioridade definida pelo mecânico e data de acompanhamento. Não classificar risco mecânico automaticamente por IA. Item crítico deve ser comunicado por pessoa responsável, sem depender exclusivamente de lembrete automático.

## 12. Comunicação, WhatsApp e retorno dos clientes

Implementar dois modos:

**Manual, utilizável desde o início:** botão abre WhatsApp com telefone normalizado e texto preenchido. Registrar apenas “conversa aberta” ou “mensagem preparada”. O usuário pode confirmar envio manual; não marcar entregue/lido automaticamente.

**Automático, ativado após configuração:** adaptador para API oficial do WhatsApp Business, envio por backend, templates e webhooks conforme documentação/políticas atuais verificadas na implementação. Não automatizar WhatsApp Web nem exigir n8n para o fluxo principal. Credenciais somente no servidor. Se provedor exigir cadastro, aprovação de template ou cobrança, documentar o necessário e manter o modo manual disponível.

Mensagens possíveis: confirmação/lembrete de agendamento, orçamento disponível, mudança relevante de status, veículo pronto, solicitação de km, retorno preventivo e pós-atendimento. Campanhas promocionais ficam desativadas inicialmente e exigem preferência própria, distinta de avisos de serviço.

Templates com prévia e variáveis validadas: nome, oficina, veículo, placa mascarada quando possível, serviço, data, km, link e telefone. Exemplo preventivo:

“Olá, {nome}! Aqui é da {oficina}. Pela data do último atendimento, está chegando o período previsto para conferir a manutenção do seu {veiculo}. Qual a quilometragem atual? Assim verificamos se já é hora de agendar.”

Não afirmar vencimento por km sem leitura confirmada. Permitir personalização sem expor informações internas.

### Motor de envios

- Fila persistente e worker/scheduler executado no servidor, independentemente de alguém abrir o site.
- Idempotência por oficina, cliente, evento/ciclo, canal e etapa; trava contra execução concorrente.
- Política configurável de horários, dias úteis, antecedência e máximo de contatos. Sugestão inicial editável: janela 09h–18h em dias úteis, até dois contatos automáticos por ciclo, separados por pelo menos sete dias.
- Agrupar lembretes compatíveis do mesmo cliente para evitar várias mensagens em sequência.
- Checar novamente consentimento, situação do serviço, agendamento, horário e cancelamento imediatamente antes de enviar.
- Pausar sequência quando cliente agendar, responder pedindo pausa, recusar ou serviço for concluído. Agendamento cancelado gera revisão, não disparo imediato indiscriminado.
- Estados: pendente, processando, aceito pelo provedor, entregue, lido, falhou, cancelado e envio incerto. Entregue/lido somente via confirmação real do provedor.
- Retentativas com espera progressiva, limite, registro do erro e fila para revisão manual. Timeout após possível envio deve ser reconciliado antes de reenviar.
- Validar assinatura dos webhooks, tolerar duplicidade e eventos fora de ordem. Não regredir entregue para pendente.
- Registrar preferência/consentimento por finalidade com origem e data; retirada bloqueia fila pendente e próximos contatos daquela finalidade.
- Botão “parar lembretes” no portal e comando por mensagem quando integrado. Não adicionar campanhas a contatos que recusaram.

## 13. Estoque, compras e fornecedores

Peças/produtos com descrição, código interno, código de fabricante opcional, categoria, unidade, localização, estoque mínimo, custo e preço de venda. Busca por nome/código; código de barras opcional. Quantidades fracionárias para óleo e outros insumos com precisão definida.

Controlar saldo físico, reservado e disponível. Entradas por compra/ajuste/devolução; saídas por consumo em OS/venda avulsa/perda; estorno com motivo. Não permitir alteração direta do saldo sem movimento.

Reservar não significa consumir. Consumo e devolução devem ocorrer uma vez, com transação e chave idempotente. Padrão sem estoque negativo; exceção somente autorizada, justificada e visível. Tratar concorrência de duas OS consumindo a última peça.

Peça do cliente/compra direta para OS deve ter origem própria e não gerar estoque fictício. Registrar observação de responsabilidade sem inventar cláusula jurídica.

Fornecedores com contatos e condições; solicitação/pedido de compra, itens, recebimentos parciais, custo, vencimento e vínculo com contas a pagar. Entrada só acontece no recebimento. Cancelamento não apaga recebimentos existentes.

Inventário com contagem, divergências e ajuste auditado. Alertas de estoque mínimo. Custo médio definido e testado; salvar custo aplicado na execução para preservar a margem histórica.

## 14. Financeiro e comissões

Contas a receber vinculadas a OS ou avulsas, parcelas, vencimentos, saldo, pagamentos parciais, formas de pagamento e comprovantes privados. Contas a pagar por fornecedor/categoria, despesas fixas e variáveis, pagamentos parciais e vencimentos.

Meios de pagamento: dinheiro, Pix, cartão, transferência e outros configuráveis. Registro manual de Pix não é confirmação bancária automática. Não armazenar dados completos de cartão. Integração de cobrança online futura por adaptador, sem fingir conciliação.

Caixa com abertura, entradas/saídas, fechamento e diferença; restrição por permissão. Conciliação manual e registro de taxas. Descontos limitados por perfil. Recebimento, estorno e cancelamento preservam lançamentos; não excluir pagamentos para corrigir erro.

Separar previsto, faturado, recebido e vencido. Fluxo de caixa por vencimento e por pagamento. Margem gerencial por OS baseada em receitas, custos de peças e terceiros definidos; não chamar de lucro líquido se despesas gerais não estiverem alocadas.

Comissões opcionais por funcionário/serviço, percentual ou valor fixo, regra de competência ou recebimento configurada, base explícita, estornos e aprovação. Mecânico vê somente suas comissões se liberado. Não implementar folha trabalhista.

Gerar recibo identificado como não fiscal. Emissão fiscal não está incluída sem integração específica validada; não chamar recibo de nota fiscal.

## 15. Relatórios e relacionamento

Filtros por período, funcionário, status, serviço e veículo, respeitando permissões. Relatórios:
- Volume de OS, tempo por etapa, atrasos e ocupação.
- Orçamentos enviados/aprovados/recusados e conversão por período claramente definido.
- Ticket médio com denominador e cancelamentos tratados.
- Receita prevista/recebida, inadimplência, despesas e margem gerencial.
- Serviços e peças mais utilizados, consumo e estoque mínimo.
- Retorno preventivo: planos elegíveis, contatos, agendamentos e serviços efetivamente concluídos.
- Clientes sem atendimento há X meses, sem transformar automaticamente em campanha.
- Produção da equipe e tempo apontado, sem interpretar tempo isolado como avaliação automática de desempenho.

Exportação CSV/PDF somente mediante permissão; prevenir fórmulas perigosas em CSV e registrar exportações. Filtros devem afetar também downloads. Atribuir retorno a uma campanha somente quando existir vínculo rastreável; não inventar receita recuperada.

Central de tarefas de contato com responsável, prazo, motivo e resultado. Pós-atendimento pode registrar satisfação e pedido de contato, sem enviar campanhas automaticamente.

## 16. Dados, arquitetura e consistência

Modelar entidades equivalentes a:
- oficinas, perfis de usuário, associações de equipe, convites, papéis, permissões e escopos;
- clientes, preferências de comunicação, veículos, vínculos de propriedade e leituras de km;
- recursos/boxes, disponibilidade e agendamentos;
- catálogo de serviços, OS, tarefas, atribuições, checklists, anexos, histórico de estados e apontamentos;
- orçamentos, versões, itens, decisões de aprovação e tokens do portal;
- planos/ciclos de manutenção, recomendações e evidências de conclusão;
- templates, fila de mensagens, tentativas, eventos de webhook e tarefas de contato;
- produtos, reservas, movimentos, fornecedores, compras e recebimentos;
- contas a pagar/receber, parcelas, pagamentos, alocações, estornos, caixa e comissões;
- configurações e auditoria.

Cada registro pertencente a uma oficina deve ter isolamento verificável. Associação entre tabelas não pode ligar dados de oficinas diferentes: usar constraints/chaves compostas ou validação transacional equivalente. Não aceitar tenant_id enviado pelo cliente sem validar vínculo e escopo.

Definir índices, unicidades por oficina, chaves estrangeiras, tipos monetários exatos, precisão de quantidades e versionamento de atualizações concorrentes. Armazenar instantes em UTC e converter para o fuso da oficina; datas de vencimento sem hora devem ser tratadas como datas locais.

Usar transações para aprovação/conversão, consumo de estoque, pagamentos/estornos e fechamento/reabertura. Preferir eventos/outbox transacional para filas criadas junto com operações de negócio. Jobs são repetíveis com segurança.

Histórico financeiro e de movimentações não é removido em cascata. Arquivamento é o padrão para cadastros em uso. Auditoria inclui autor, ação, recurso, instante e mudanças relevantes, sem tokens, senhas ou dados pessoais desnecessários.

## 17. Segurança, privacidade e operação

- Autenticação real, recuperação de senha e MFA para administradores quando suportado.
- Políticas de acesso no banco e backend; service role nunca no frontend.
- Segredos fora do repositório; .env.example sem valores reais.
- Proteção contra IDOR, escalada de privilégios, SQL injection, XSS, CSRF quando aplicável, força bruta e abuso de links públicos.
- Rate limit para autenticação, aprovações, convites e formulários públicos.
- Arquivos em armazenamento privado; limites de tamanho, tipos permitidos, validação de conteúdo e URLs temporárias. Evitar servir HTML/SVG ativo enviado pelo usuário.
- Separar logs operacionais e auditoria; restringir acesso e mascarar dados sensíveis.
- Minimização de dados, preferências de contato, exportação dos dados do cliente mediante autorização e fluxo de revisão para correção/exclusão/anonimização. Não excluir automaticamente histórico necessário a obrigações aplicáveis; política de retenção deve ser configurada e revisada pela oficina.
- Documentar requisitos de privacidade sem prometer conformidade legal automática.
- Backup de banco e arquivos, política de retenção e procedimento de restauração testável. Não exibir “backup feito” sem execução confirmada.
- Monitorar erros, fila parada, falhas de envio e jobs sem execução; mostrar última execução e próximo processamento.
- Ambientes de desenvolvimento, teste e produção separados. Migrações versionadas, instruções de recuperação e proibição de reset destrutivo de produção.

## 18. Critérios de aceite e testes essenciais

Criar testes de regras críticas e testes ponta a ponta dos fluxos abaixo; não apenas testes que confirmam que um botão aparece.

1. Proprietário convida mecânico; ele aceita e vê somente OS atribuídas. Tentativa por URL/API de ver financeiro, outra OS, PDF restrito ou arquivo alheio falha.
2. Mecânico bloqueado perde acesso mesmo com sessão previamente aberta. Alterar própria função é negado.
3. Duas oficinas fictícias permanecem isoladas em listagens, joins, storage, portal, relatórios e realtime.
4. Recepção cadastra cliente com dois carros, agenda um, registra entrada e converte uma única vez em OS.
5. Orçamento parcial preserva itens recusados. Mudança de preço exige versão nova. Aprovação repetida não duplica execução.
6. Dois usuários editando a mesma OS recebem controle de conflito; não há sobrescrita silenciosa de campos críticos.
7. Estoque reservado, consumido e estornado mantém saldo correto, inclusive sob concorrência e cancelamento.
8. Pagamento parcial, parcela vencida, estorno e fechamento de caixa mantêm saldos corretos. Repetir requisição não duplica recebimento.
9. Nova manutenção executada encerra ciclo correto e cancela lembrete anterior; agendamento ou pagamento isolado não conclui manutenção.
10. Km estimado nunca aparece como vencimento confirmado. Leitura regressiva exige revisão. Mudança de mês/ano e último dia do mês funcionam.
11. Consentimento revogado entre enfileiramento e envio impede mensagem. Cliente já agendado não recebe cobrança automática de retorno.
12. Dois workers e webhooks duplicados não duplicam contato nem regredem status. Envio incerto não é reenviado cegamente.
13. Link expirado/revogado e orçamento substituído não permitem aprovação. Portal nunca expõe notas internas ou outro atendimento.
14. Mudança de proprietário do carro não expõe dados do cliente anterior.
15. Interface funciona em celular e desktop, com teclado, erros claros, carregamento e ausência de dados.
16. Backup/restauração tem procedimento validado no ambiente de teste ou fica explicitamente pendente quando depende do provedor.

Executar lint, checagem de tipos, build, testes unitários relevantes, integração e E2E dos caminhos críticos. Reportar comandos e resultados reais. Não afirmar que um teste passou se não foi executado.

## 19. Fases de implementação — todo o escopo permanece previsto

### Fase 1 — Fundação

Configuração do projeto, design system, autenticação, oficina, equipe, permissões, isolamento no banco, auditoria e cadastros de clientes/veículos. Critério: mecânico restrito e segunda oficina de teste isolada.

### Fase 2 — Operação completa

Agenda, recepção, OS, checklist, diagnóstico, fotos, orçamento versionado, aprovação segura, execução, entrega, histórico e documentos. Critério: atendimento real completo de ponta a ponta.

### Fase 3 — Preventiva e retorno

Planos/ciclos, km, painel de contatos, consentimentos, modo manual WhatsApp, tarefas, scheduler, fila e adaptador automático. Critério: manutenção gera retorno coerente e nova execução cancela o ciclo antigo.

### Fase 4 — Gestão

Estoque, compras, financeiro, caixa, comissões opcionais, relatórios e exportações. Critério: movimentações consistentes e separação efetiva de acesso.

### Fase 5 — Confiabilidade e entrega

Testes de integração/E2E, revisão de segurança, responsividade, acessibilidade, monitoramento, backups, documentação, seed demonstrativo e preparação de deploy. Ativar integrações externas somente com credenciais e ambiente apropriados.

As fases são ordem de execução, não autorização para abandonar funções silenciosamente. Usar checklist de requisitos com estados implementado/testado/pendente/bloqueado. Integrações bloqueadas por credenciais não impedem concluir módulos independentes.

## 20. Entregáveis obrigatórios

- Código funcional, organizado e sem botões de sucesso fictício.
- Migrações, políticas de segurança, índices, funções transacionais e configuração do armazenamento.
- Seed fictício separado, incluindo uma segunda oficina para testar isolamento.
- .env.example, README de instalação/execução/deploy e instruções de criação do proprietário inicial.
- Documentação do modelo de dados, permissões, estados de OS/orçamento e manutenção.
- Documentação das integrações, jobs, webhooks, backups e limitações externas.
- Testes críticos e relatório do que foi realmente executado.
- Checklist de requisitos e checkpoint de continuidade.
- Manual breve para proprietário, recepção, mecânico e financeiro.

Não inserir credenciais padrão de produção, não contratar serviços pagos, não enviar mensagens a clientes reais em testes e não publicar externamente sem autorização específica. Preparar a aplicação para revisão e teste.

## 21. Fora do escopo inicial e extensões futuras

Manter arquitetura extensível, mas não incluir agora: faturamento de assinaturas SaaS, emissão fiscal completa, conciliação bancária automática, folha de pagamento, consulta paga por placa, catálogo universal de montadoras, scanner OBD/telemetria, aplicativo nativo, diagnóstico mecânico autônomo por IA e campanhas em massa.

Esses itens podem ser adicionados depois por requisitos próprios. O sistema deve ser útil sem eles. Não bloquear cadastro manual porque um serviço externo não está conectado.

## 22. Comece agora

Leia o projeto, apresente brevemente suas decisões e a sequência de execução. Em seguida, implemente a Fase 1 e avance pelas fases, verificando cada fluxo. Não pare em um protótipo visual. Preserve esta especificação e registre qualquer alteração de escopo solicitada pelo usuário. Ao final, explique como testar, quais acessos usar no ambiente de demonstração e o que ainda exige configuração externa.
