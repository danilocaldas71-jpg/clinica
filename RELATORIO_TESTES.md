# Clínica Fluxo · validação com dados fictícios

Foram usados dois agentes. Um executou as regras de agenda, salas e escala. O outro executou as regras de estoque, esterilização e rastreabilidade. As suítes carregam as funções do HTML real. Um terceiro teste, executado pelo agente principal, usa o servidor HTTP, contas independentes e um banco SQLite temporário.

## Premissas da simulação

- Dois dias consecutivos, 11 e 12 de novembro de 2026, com quatro dentistas fixos, três clínicos gerais e um exclusivamente ortodontista. Três consultas por dentista a cada dia.
- Três salas, duas ASBs, ambas autorizadas pelos dentistas. Jornada fictícia de 07h50 a 16h50, com almoço de 12h a 13h.
- Seis duplas às 08h, 09h30, 11h, 13h10, 14h30 e 16h. Consultas de 40 minutos, mais 10 antes e 10 depois. Cada consulta exige uma ASB, um kit estéril e um par de luvas. O cenário de equipamento usa um fotopolimerizador.
- Estoque-base de 24 kits liberados e 40 pares de luvas. O cenário de falta inicia com 12 kits. O lote de reposição tem capacidade fictícia de 12 kits e duração de 75 minutos, com 15 de preparo, 45 de ciclo e finalização e 15 de conferência e liberação. O bloco planejado das 08h às 09h15 está no dia anterior à agenda de dois dias.
- O cenário de atraso considera liberação efetiva às 09h10 do segundo dia. A disponibilidade de material nos totais significa cobertura pelo estoque registrado, antes da separação física. Cada cenário de exceção parte de uma base própria.

## Resultados

| Cenário | Esperado | Observado | Falha reproduzida |
|---|---|---|---|
| Agenda-base em dois dias | 12 consultas por dia, três por dentista | 24/24 com horário, 24/24 com ASB e 24/24 com material | Nenhuma |
| Ausência de uma ASB | Um encaixe por dupla nos horários fixos | 6/12 com horário, ASB e material | Nenhuma |
| Esterilização ocupa uma ASB às 13h10 | Uma das duas consultas pode usar a outra ASB | 1/2 com horário, ASB e material. O outro pedido foi recusado com indicação de esterilização | Nenhuma |
| Bloco de 75 min sobre consultas | Bloquear a escala conflitante | Nenhuma ASB teve 75 min contínuos livres no primeiro dia. Bloco aceito no dia anterior sem compromissos | Nenhuma |
| Consulta das 08h termina às 09h25 | Bloquear preparo seguinte às 09h20 na mesma sala e com a mesma ASB | O encaixe das 09h30 foi recusado. Às 09h45, o preparo pode começar após o giro | Corrigida e retestada |
| Fotopolimerizador compartilhado | Apenas um encaixe simultâneo | 1/2 com horário, ASB e material. O outro pedido indicou conflito de equipamento | Nenhuma |
| Cancelamento antes de separar | Liberar horário, ASB e demanda de kit | Consulta substituta encaixada. No cenário sem estoque, o dia seguinte passou a 1/12 com material | Nenhuma |
| Cancelamento após separar | Reter kit para reprocessamento e preservar a origem | Pacote ficou aguardando reprocessamento, com vínculo ao atendimento original | Nenhuma |
| Reagendamento | Mover a reserva e recalcular as pendências | Reagendamento para 09h30 do dia seguinte aceito no cenário-base. Ao mover uma consulta de D1 para D3 no cenário de falta, D2 passou a 1/12 com material e D3 ficou pendente | Nenhuma |
| 12 kits sem reposição | Cobrir o primeiro dia, indicar faltas no segundo | D1 teve 12 horários, 12 ASBs e 12 com material. D2 teve 12 horários, 12 ASBs e 0 com material, com 12 pendências de um kit | Nenhuma |
| Reposição prevista e lote futuro | Previsão separada do estoque disponível | Previsão de 12 kits exibida. Zero kits físicos antes da liberação. Lote importado com data futura também ficou fora da projeção atual | Falha de lote futuro corrigida e retestada |
| Liberação técnica atrasada | Indicar falta no preparo das 08h e preservar a informação sobre os prazos perdidos | Após liberar às 09h10, as 12 consultas tinham cobertura de estoque atual. As duas faltas por prazo vencido permaneceram no histórico | Corrigida e retestada |
| Reprocessamento | Vincular nova carga à anterior e ao atendimento | Vínculos conferidos. A nova carga entrou no estoque após liberação pelo responsável técnico | Nenhuma |
| Duas contas disputam o mesmo horário e ASB | Uma gravação e uma recusa motivada | HTTP 200 e 409. A recusa indicou Camila, os intervalos ocupados e a Sala 1 | Nenhuma |
| Duas contas tentam separar PK-01 | Uma separação e uma recusa motivada | HTTP 200 e 409. A recusa informou que PK-01 já havia sido separado | Nenhuma |
| Migração, permissões e persistência | Prévia sem gravação, repetição sem duplicação e registros após reiniciar | Verificado no HTTP, incluindo acesso anônimo recusado e tentativa de liberar lote pela ASB recusada | Nenhuma |

Para validar a operação real, meça tempos de consulta e de preparo por procedimento, frequência e duração dos atrasos, composição e consumo de kits, capacidade útil por carga, duração completa da esterilização, tempo até a liberação pelo responsável técnico, disponibilidade de ASBs e equipamento e estoque liberado no início do dia. A simulação verifica o comportamento do sistema sob premissas controladas. O histórico registra o horário em que a falta foi detectada. Com o sistema desligado, a próxima conferência pode detectar uma falta ainda existente, mas não comprova a disponibilidade anterior.
