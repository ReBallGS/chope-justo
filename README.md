# Chope Justo

Cada pessoa paga o que consumiu. O app mostra quem lançou cada chope, pede confirmação quando outra pessoa anota e guarda o histórico. Ele não acusa ninguém. Também não enxerga um copo que ninguém registrou.

## Arquitetura

O site é um React estático (Vite), feito para o GitHub Pages. O banco, o login e a sincronização ficam no Supabase. O navegador só recebe a URL do projeto e a chave **anon**, que é pública por desenho.

Operações de dinheiro não são feitas no navegador e não passam por Edge Function. Elas rodam em funções `security definer` do Postgres, na mesma transação:

- o preço é lido da rodada, não do formulário;
- o total é recalculado no banco;
- um lançamento repetido com a mesma chave não cobra de novo;
- correção, contestação e denúncia são eventos novos;
- lançamento confirmado não é apagado, nem por quem organiza.

Edge Function foi deixada de fora de propósito. Uma função HTTP separada abriria uma segunda implementação das regras e dificultaria a transação. O equivalente seguro, aqui, é o próprio Postgres.

Quem organiza a rodada não tem um poder oculto. Pode anotar para os outros só se isso foi marcado, e esse lançamento fica pendente. Não apaga histórico, não muda a conta de alguém sem aceite e não divide a sobra da conta do bar.

## Modelo

Dinheiro em centavos inteiros.

| Tabela | Papel |
| --- | --- |
| `profiles` | Nome público. Sem e-mail. |
| `rounds` | Mesa, preço, código de 20 caracteres e status. |
| `round_participants` | Quem entrou com a própria conta, papel e permissão de anotar. |
| `consumption_entries` | Fato original do chope. Não muda e não some. |
| `entry_confirmations` | Só quem consumiu confirma. |
| `disputes`, `dispute_resolutions`, `dispute_acceptances` | Contestação e desfecho. A conta só muda com aceite. |
| `corrections` e aceites/retiradas | Correção compensatória, com o original preservado. |
| `divergence_reports` e `report_resolutions` | Denúncia. Não altera dívida. |
| `round_adjustments` | Desconto, cortesia, arredondamento ou diferença, sempre para uma pessoa nomeada. |
| `audit_events` | Histórico só de inclusão. |
| `round_closings` e `closing_acknowledgements` | Proposta e aceite explícito. |
| `rate_limit_events` | Limite de tentativas. |

Status da rodada: `open`, `review`, `provisionally_closed`, `closed`.

Um chope entra no valor a pagar só quando está confirmado, sem divergência aberta e sem anulação aceita. Pendência e contestação aparecem à parte. A diferença entre a conta do bar e a soma confirmada fica visível e não é rateada.

## Riscos e o que o sistema faz com eles

| Risco | Mitigação |
| --- | --- |
| Alguém lança chope para outra pessoa | O lançamento fica pendente, com o nome de quem anotou, até a pessoa confirmar. |
| Alguém apaga ou edita o histórico | Não há `update`/`delete` para o navegador. Gatilhos recusam apagar lançamento, auditoria e denúncia. |
| Organizador encerra divergência em silêncio | A decisão fica registrada e quem consumiu precisa aceitar. |
| Denúncia usada para mudar a conta | A denúncia não mexe em valor. Há limite de quantidade e repetição. |
| Duas requisições iguais | Chave de idempotência única e trava por rodada. |
| Preço ou quantidade inventados no navegador | A função não recebe preço. Quantidade só de 1 a 10. |
| Pessoa de outra mesa | RLS e a função recusam quem não participa. |
| Alguém se promove | Não é possível alterar a própria permissão. |
| Diferença da conta jogada em todo mundo | O fechamento guarda os dois números e não cria rateio. |
| Várias contas | Cada entrada exige conta. Isso não impede dois e-mails. |
| Chope que ninguém viu | Nenhum sistema prova esse consumo. O fluxo só reduz a chance de ele passar batido. |
| Dono do projeto Supabase | A `service_role` e o SQL do painel ignoram o app. Essa chave não pode ir para o frontend nem para o GitHub Actions. |

## Limitações honestas

- Se a bebida não foi lançada e ninguém reportou, a conta não a inclui.
- Duas contas de e-mail ainda podem ser criadas pela mesma pessoa. O app impede a segunda entrada na mesma mesa com a mesma conta, não a existência de outro e-mail.
- O código da rodada é um segredo. Quem tiver o código e uma conta entra.
- O fechamento definitivo espera que as pendências acabem e que cada participante aceite. Se alguém não responder, a mesa fica em aberto ou em fechamento provisório.
- Arredondamento aceito não passa de R$ 1,00. Um desconto maior precisa nomear a pessoa e ter a justificativa e o aceite dela.

## Criar o projeto Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Em **Project Settings → API**, copie a URL e a chave `anon` / `public`.
3. Não copie a `service_role`.
4. No **SQL Editor**, execute, nesta ordem:
   - `supabase/migrations/20261029120000_schema.sql`
   - `supabase/migrations/20261029120100_functions.sql`
   - `supabase/migrations/20261029120200_functions_governance.sql`
5. Em **Authentication → Providers → Email**, deixe o cadastro ligado.
6. Em **Authentication → URL configuration**, coloque a URL do site:
   - local: `http://127.0.0.1:5173`
   - Pages: `https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/`
7. Em **Database → Replication**, confira se as tabelas da rodada estão na publicação `supabase_realtime`. A migração tenta incluí-las.
8. Para o teste entre amigos, a confirmação de e-mail pode ficar desligada. Em uso aberto, ligue a confirmação. Isso dificulta conta descartável, mas não elimina.

Com a CLI e o Docker:

```bash
supabase start
supabase db reset
```

`enable_confirmations` no `supabase/config.toml` local está `false` para o ensaio. No projeto hospedado, a configuração é a do painel.

## Variáveis

```bash
cp .env.example .env
```

```env
VITE_SUPABASE_URL=https://SEU_PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua_chave_anon_publica
VITE_BASE_PATH=/
```

A chave anon vai parar no JavaScript publicado. Isso é esperado. A proteção é a RLS e as funções, não o sigilo dessa chave.

## Rodar e testar

```bash
npm install
npm test
npm run dev
```

Abra `http://127.0.0.1:5173`.

`npm test` sobe o Postgres em memória, aplica a mesma migração e cobre os doze cenários de autorização e cálculo. `npm run build` gera `dist/`.

No projeto Supabase local, as checagens estruturais também rodam com:

```bash
supabase test db
```

## Publicar no GitHub Pages

1. Suba o repositório para o GitHub.
2. Em **Settings → Secrets and variables → Actions → Variables**, crie:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Em **Settings → Pages**, escolha **GitHub Actions** como fonte.
4. O workflow `.github/workflows/pages.yml` testa, compila e publica.
5. O endereço fica `https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/#/`.
6. Coloque essa URL nas URLs permitidas do Supabase Auth.

As rotas usam hash (`#/r/...`) para funcionar sem reescrita de servidor. O QR aponta para `#/j/CODIGO`.

Build manual:

```bash
VITE_BASE_PATH=/NOME_DO_REPOSITORIO/ npm run build
```

## Roteiro com amigos

Use três celulares, ou uma janela anônima para a segunda conta.

1. Ana cria a conta, informa o nome e cria a rodada com o preço do chope. Marque se ela pode anotar para os outros.
2. Ana mostra o QR ou o código. Bruno e Caio entram com as próprias contas.
3. Ana registra o próprio chope. Ele aparece confirmado no extrato dela.
4. Ana, se estiver autorizada, registra um chope para Bruno. No celular do Bruno o item fica **aguardando confirmação** e não entra no total a pagar.
5. Bruno confirma. O valor passa para o total dele.
6. Caio registra o próprio chope e contesta outro lançamento. O item contestado sai do total confirmado e aparece em divergência.
7. Alguém reporta um chope visto e não lançado. A contagem de denúncias sobe. Os totais não mudam.
8. Quem organiza registra a verificação da denúncia. De novo, a conta não muda sozinha.
9. Quem quiser corrigir um lançamento pede a correção com justificativa. O original continua na lista. O valor só muda se a pessoa afetada aceitar.
10. Alguém tenta anotar para outra pessoa sem permissão, ou mudar o próprio papel. O servidor recusa.
11. Iniciem a revisão. Informem a conta do bar se ela for diferente da soma. Leiam a diferença. Ela não é dividida.
12. Com item pendente, o fechamento definitivo é recusado. O provisório só vale se cada pessoa aceitar, e os itens abertos continuam marcados.
13. Depois de confirmar, resolver as divergências e todos aceitarem, a rodada pode encerrar. Copiem o resumo.

Se a rede cair no meio de um lançamento, o celular mostra **sincronização pendente**. Esse item não entra na conta até o servidor aceitar.

## O que não colocar no repositório

- `.env`
- `service_role`
- senha do banco
- token de acesso
