# Clínica Fluxo em rede local

A versão compartilhada roda com Node.js 24 e SQLite, sem instalar dependências. O servidor entrega a interface e guarda agenda, equipe e escalas, pacientes, catálogo, lotes, pacotes, fotos, previsões e auditoria em um banco local. As operações reaplicam as regras do projeto no servidor. Os dispositivos consultam a mesma base e a tela aberta atualiza a cada cinco segundos quando não há formulário em edição.

## Iniciar em um computador

A partir da pasta `esterilizacao`, configure contas individuais. O identificador final liga a conta ao profissional da base. Use senhas diferentes com pelo menos 12 caracteres. No terminal Bash ou Zsh:

```sh
printf 'Senha da conta técnica: '; IFS= read -rs senha; printf '\n'
CLINIC_ACCOUNT_PASSWORD="$senha" node server.mjs account responsavel rt
unset senha

printf 'Senha da recepção: '; IFS= read -rs senha; printf '\n'
CLINIC_ACCOUNT_PASSWORD="$senha" node server.mjs account recepcao r1
unset senha

node server.mjs
```

Abra **http://127.0.0.1:8787**. Os IDs iniciais são `d1` Helena, `d2` André, `d3` Marina, `d4` Rafael, `t1` Camila, `a1` Bianca, `r1` Luiza, `l1` Joana e `rt` Patrícia. O ID `t1` preserva compatibilidade com backups, e Camila é ASB na base nova. Executar o comando de conta sem parâmetros lista os profissionais cadastrados. Repita o comando para cada pessoa. Para redefinir uma senha, use o mesmo nome de conta. As sessões dessa conta serão encerradas.

O banco padrão é `data/clinic.sqlite`. Defina `CLINIC_DB` para usar outro arquivo e mantenha a mesma configuração ao criar contas e iniciar o servidor. Para começar uma demonstração com consultas fictícias, acrescente `--demo` na primeira criação do banco, inclusive se o primeiro comando for o cadastro de conta. A configuração padrão contém o catálogo e a equipe de exemplo, com agenda vazia.

## Abrir em outros dispositivos

Para testar com dados fictícios na mesma rede:

```sh
CLINIC_HOST=0.0.0.0 CLINIC_PORT=8787 node server.mjs
```

Nos outros dispositivos, abra `http://IP-DO-COMPUTADOR:8787`. Cada pessoa entra na própria conta. A recepção vê disponibilidade de salas e o resumo do estoque. Auxiliares veem a escala e operam o preparo e a esterilização conforme suas atribuições. A liberação de lotes e a importação pertencem ao responsável técnico.

Para uso com dados reais, configure HTTPS em um proxy interno e inicie o backend com `CLINIC_SECURE_COOKIE=1`. Defina o endereço fixo, as regras de acesso da rede, a proteção do computador servidor, o backup consistente do SQLite e a restauração testada. Mantenha o banco em disco local protegido. Cadastre os perfis reais, delegações, especialidades, escalas e parâmetros de esterilização da clínica. Esta versão usa um processo servidor e um banco local. Planeje a retenção das fotos e os limites de armazenamento antes de migrar uma base grande.

## Importar sem alterar o navegador original

1. Na versão estática, abra **Exportar dados** no mesmo endereço em que os registros foram gravados. Para um site antigo sem esse botão, use a exportação do armazenamento local nas ferramentas do navegador. A chave é `clinica-fluxo-v1`, e o conteúdo deve ser salvo como JSON sem alterações.
2. Inicialize um banco novo e configure primeiro a conta do responsável técnico que também existe no backup. Cadastre as demais contas depois da importação, especialmente se funções antigas diferirem.
3. No servidor, entre como responsável técnico, abra **Importar dados**, selecione o JSON e clique em **Ver prévia**. Se o navegador já tiver os dados gravados no mesmo endereço do servidor, o arquivo é opcional.
4. Confira as quantidades e confirme. A importação inicial substitui a base de demonstração do servidor. Uma nova tentativa com o mesmo conteúdo é idempotente, inclusive depois de outras gravações. Um backup diferente exige um banco novo, para evitar sobrescrever operações em andamento.

A origem permanece intacta. Guarde o arquivo de exportação em local protegido e faça backup do banco antes de disponibilizá-lo na rede.

## Mapa do sistema

Entre como responsável técnico e abra **Mapa do sistema**. Expanda uma seção para ver a origem, o destino e a situação de cada vínculo. O mapa usa a base atual e acompanha as gravações do dispositivo e a sincronização do servidor a cada cinco segundos, enquanto não há formulário em edição.

Vínculos cancelados ou suspensos que a base conserva aparecem com sua situação. Vínculos removidos da base, como uma delegação revogada, deixam de aparecer.

## Testes

```sh
node test.mjs
node test-agenda.mjs
node test-estoque.mjs
```

O teste HTTP cria contas e dados fictícios em um banco temporário, usa sessões independentes, disputa recursos e reinicia o servidor para verificar persistência. Os outros dois testes executam funções reais do HTML com datas e registros fictícios. Veja o relatório de simulação para as premissas e falhas observadas.

## Prévia na Vercel

Importe a branch `main` com a raiz apontando para a raiz do repositório GitHub.
O arquivo `vercel.json` publica `dist/index.html` em modo demonstrativo, com
dados de teste e armazenamento no navegador. A agenda e o estoque compartilhados
continuam disponíveis pelo servidor local. Para disponibilizá-los online, o
servidor precisa de uma hospedagem com armazenamento persistente para o SQLite.
