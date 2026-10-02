# 🍃 Folha Caixa — *O caixa da banca.*

PDV (frente de caixa) para hortifruti: sacolão, banca de feira, quitanda, mercearia de perecíveis.
Vende **por quilo** com a balança, lê **código de barras** (câmera do celular/PC, leitor USB e etiqueta de balança), tem **atalhos de banca** com ícone e cor, aceita **pagamento misto**, controla **fiado com limite**, **perdas** e **fechamento de caixa**.

**Dois jeitos de usar — a mesma tela:**

| | 🌐 **Online** (celular + PC) | 🖥️ **Local** (computador do balcão) |
|---|---|---|
| Endereço | **https://rafaelytofc7-spec.github.io/folha-caixa/** | http://localhost:5170 |
| Dados | banco online (Supabase/Postgres), **os mesmos em todos os aparelhos** | SQLite no próprio computador |
| Internet | precisa (sem internet: abre, mostra o aviso e guarda vendas simples numa fila) | não precisa |
| Instalar | botão **📲 Instalar app** ou Chrome ⋮ › *Instalar app* (PWA) | `npm install && npm run build && npm start` |
| Impressora térmica de rede (9100) | não (navegador não deixa) — imprime pelo diálogo, PDF ou .bin | sim |

![Tela de venda](docs/prints/04-venda-carrinho.png)

---

## 0. Modo online (GitHub Pages + Supabase)

**Abrir:** https://rafaelytofc7-spec.github.io/folha-caixa/ — no **Chrome do Android** (ou no PC/iPhone).

### Primeiro acesso (uma vez só, pelo dono)

1. Abra o link **no Chrome**. Se abriu pelo WhatsApp/Instagram (navegador embutido), aparece a faixa *“Abra no Chrome para instalar”* → toque em **Abrir no Chrome**.
2. Como o banco ainda não tem nenhuma conta, abre a tela **Criar cadastro**: *nome*, *usuário* (letras minúsculas/números, ex.: `rafael`), *senha* (mínimo 8) e um **PIN de 4 dígitos** (para trocar de operador e autorizar como gerente).
3. **A primeira conta criada vira ADMIN** e cai direto na tela **Hoje**. A partir daí o cadastro **fecha**: a tela de entrada só mostra *usuário + senha*, e ninguém de fora consegue criar conta.
4. **Instalar como app:** botão **📲 Instalar app** (no topo ou na tela de entrada) → *Instalar*. Se o botão não aparecer: Chrome **⋮ → Instalar app** (ou *Adicionar à tela inicial*). iPhone: Safari → Compartilhar → *Adicionar à Tela de Início*. Abre em tela cheia com o ícone da folha.
5. **Funcionários:** *Config. › Usuários › + Novo usuário*: nome, **usuário**, papel (**gerente** ou **operador**) e PIN. A senha é gerada na hora e aparece numa tela para **copiar** e passar à pessoa (ela pode trocar depois). *Editar* muda nome/papel/PIN/ativo; **Nova senha** gera outra senha se a pessoa esquecer.

### No dia a dia

- Cada pessoa entra com **usuário + senha** no próprio aparelho.
- **No caixa, trocar de operador é pelo PIN:** menu do usuário (canto superior) → **Trocar operador** → escolhe a pessoa → PIN. Não precisa de senha nem sair da conta.
- **PIN do gerente/admin** autoriza cancelamento, desconto acima do limite, perda e ajuste — como no modo local.
- **Minha conta** (*Config. › Minha conta*): trocar a própria senha (pede a atual) e sair da conta. *Sair da conta* avisa se ainda há vendas na fila offline.
- **Atualização do app:** quando sai versão nova aparece a faixa **“Nova versão do Folha Caixa”**; toque em *Atualizar agora* quando terminar a venda e o app recarrega já na versão nova. A versão aparece em *Config. › Loja e cupom* (atual: **3.0.0**).
- **Nome do app:** o app instalado se chama **Folha Caixa** (manifest `name`/`short_name`, `<title>`, `application-name`). Depois de *Atualizar agora* a barra de título do Windows já mostra “Folha Caixa”. O nome do ícone/da lista de apps abertos é atualizado pelo Chrome: no **Windows** aparece *“Atualização do app disponível”* no menu ⋮ da janela do app → *Revisar* → *Atualizar*; no **Android** o Chrome refaz o app instalado sozinho (quando o app fica fechado e o celular está no Wi-Fi/carregando; para forçar: Chrome › `about://webapks` › *Update*). Não precisa desinstalar.
- **Backup:** *Config. › Backup* baixa **todas as tabelas em JSON** (um arquivo) ou **CSV por tabela** (abre no Excel). Senhas e PINs não saem no backup.

### O que tem para o dono da banca

| Tela | O que faz |
|---|---|
| **Hoje** | vendido no dia (e comparação com ontem), nº de vendas, **ticket médio**, **por forma de pagamento**, **perdas**, **top produtos**, últimas vendas (reimprimir cupom) e alertas |
| **Produtos › Preço do dia** | lista de todos os preços editável **em massa** (busca, ±10% nos marcados, margem na hora, destaca o que mudou) → *Salvar* vale na venda na hora; fica na auditoria |
| **Compras** | **fornecedores** (cadastro) e **entrada de compra por fornecedor** com vários itens (qtd., custo, lote, validade) — tudo ou nada; atualiza estoque e custo. Histórico de compras com busca e itens |
| **Estoque › Alertas** | **estoque baixo** (abaixo do mínimo) e **lotes vencendo**; o número aparece no topo (⚠) |
| **Vendas** | histórico com **busca** (nº, cliente, operador, forma), filtro de período (hoje/ontem/7 dias/mês/datas) e status; reimprimir; cancelar (só do dia, PIN do gerente) |
| **Config. › Usuários** | (admin) criar/editar usuários, PIN, nova senha |

**Celular (390 px):** barra de navegação embaixo (gerente/admin: Venda, Hoje, Vendas, Estoque, *Mais*; operador: Venda, Caixa, Vendas, Fiado, *Mais*). A venda vira duas abas — **Produtos** (atalhos/busca, com a barra verde “🧺 N itens · total · Sacola ›”) e **Sacola** (itens, total, *Receber*). Tocar num produto dá um retorno (“+1”, vibração). Tocar num produto por quilo abre o teclado de peso.

**Sem internet (honesto):** o app (a “casca”) abre sem internet pelo service worker e aparece a faixa vermelha **“Sem internet”**. Dá para **finalizar vendas em dinheiro/PIX/cartão/voucher**: elas ficam numa **fila no aparelho** e sobem sozinhas quando a conexão volta (cada venda tem um `client_uuid`, reenviar nunca duplica). **Não funciona offline:** entrar (login), fiado, desconto que exige gerente, cancelamento, estoque, compras, abrir/fechar caixa. Venda da fila não é barrada por estoque (ela já aconteceu) e fica marcada `offline` na auditoria.

**Impressão no modo online:** *Imprimir (80 mm)* (diálogo do navegador), **PDF** e **.bin ESC/POS** gerados no navegador. Mandar direto para a impressora de rede (porta 9100) não é possível a partir de um navegador; esse botão some no modo online.

### Como o modo online é montado

- **Frontend:** o mesmo React de `web/`, compilado com `npm run build:pages` (`vite build --mode supabase`, base `/folha-caixa/`) e publicado pelo GitHub Actions (`.github/workflows/pages.yml`) a cada push na `main`. A camada `web/src/backend/supabase.ts` traduz as rotas `/api/...` para chamadas do Supabase.
- **PWA:** `manifest.webmanifest` com `id`, ícones normais e *maskable*, atalhos e capturas (o Android mostra a janela de instalação completa); o botão **Instalar app** usa o evento `beforeinstallprompt`; o service worker só troca de versão quando você toca em *Atualizar* (sem misturar arquivos de versões diferentes).
- **Banco:** Postgres do Supabase (`supabase/sql/`): toda operação que mexe em dinheiro ou estoque é uma função `SECURITY DEFINER` atômica (venda, cancelamento, caixa, entrada de compra, perda, fiado, preço do dia). Número de venda sequencial, auditoria, estoque negativo, limite de fiado, um caixa por terminal e **PIN conferido no servidor** (bcrypt do pgcrypto).
- **Contas (usuário + senha):** o Supabase Auth guarda cada usuário como `usuario@folhacaixa.app` (e-mail interno, ninguém digita e-mail). O **cadastro público do Supabase fica desligado** (`disable_signup`). Contas só nascem pela **Edge Function `accounts`** (`supabase/functions/accounts/`), que roda no servidor com a chave de serviço: `bootstrap` só funciona com **zero usuários** (trava a tabela para não haver dois “primeiros”) e cria o admin; `create_user`/`set_password` exigem login **de admin** (conferido no banco). A `service_role` **nunca** vai para o site nem para o repositório.
- **Sessão e PIN:** depois do login com senha o aparelho tem a sessão; a troca rápida por PIN gera um token de operador que as RPCs exigem. Voltar a ser o dono da conta pede **senha de novo** (o banco confere que a senha foi digitada há menos de 10 min), então um operador que entrou pelo PIN não vira admin.
- **RLS** em todas as tabelas: só usuário ativo logado lê; ninguém escreve direto nas tabelas (só pelas RPCs). Hash dos PINs e tokens não são legíveis pela API. A chave do site é a **publishable/anon** (pública por natureza), em `web/.env.supabase`.

### Administrar o banco online (no computador do dono)

Precisa do token da Management API do Supabase em `SUPABASE_ACCESS_TOKEN` (nunca commitar):

```bash
npm run db:apply                      # aplica supabase/sql/*.sql (tabelas, funções, permissões)
npm run db:reset                      # APAGA tudo (inclusive as contas) e recria a banca de exemplo sem usuários
node supabase/setup-auth.mjs          # confere/força: cadastro público desligado, sem anônimo, senha mínima 8
supabase functions deploy accounts --project-ref cprtigvovwbmigxbosac --no-verify-jwt --use-api   # publica a Edge Function
npm run test:supabase                 # ⚠ ZERA o banco (reset_seed apaga TODAS as contas e vendas) — só antes da banca começar a usar
npm run qa:online                     # ⚠ idem: QA com Chrome headless que ZERA o banco no começo e no fim
npm run qa:v3                         # QA da v3 (leitor + nome do app) na URL publicada: NÃO grava nada no banco (Supabase simulado no teste, banco real só lido)
```

Depois de um `db:reset` o próximo a abrir o site vê **Criar cadastro** de novo (e vira admin).

---

## 1. Modo local: instalar e ligar

Precisa de **Node.js 20 ou mais novo** (com npm). Não precisa de internet depois de instalar.

```bash
npm install        # instala as dependências (só na primeira vez)
npm run build      # confere os tipos e gera a tela e o servidor
npm test           # roda os testes do fluxo do dia (opcional)
npm start          # liga o caixa
```

Abra **http://localhost:5170** no navegador do balcão (Chrome/Edge). No tablet, use o IP do computador na mesma rede só se você mudar `HOST=0.0.0.0` (veja abaixo) — por padrão o servidor só atende o próprio computador.

Na primeira vez o banco é criado sozinho em `server/data/folha.db` com a loja de exemplo.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `5170` | porta do caixa |
| `HOST` | `127.0.0.1` | `0.0.0.0` libera para o tablet da rede local |
| `FOLHA_DB` | `server/data/folha.db` | arquivo do banco SQLite |
| `LOG` | — | `LOG=1` mostra o log de requisições |

Outros comandos:

```bash
npm run dev                 # desenvolvimento: API em :5170 + Vite em :5173 (com proxy)
npm run seed -- --reset     # APAGA o banco e recria a loja de exemplo (cuidado!)
npm run prints              # gera as capturas de tela em docs/prints (usa o Chrome instalado)
npm run zip                 # gera ../folha-caixa.zip com o código (sem node_modules)
```

## 2. Usuários e PINs no modo local (loja de exemplo “Banca Folha”)

No **modo local** a entrada é só pelo PIN (o computador do balcão é da loja). No **modo online** não há usuários de exemplo: veja *Primeiro acesso* acima.

| Usuário | Papel | PIN |
|---|---|---|
| Admin | admin | **1234** |
| Dona Cida | gerente | **2580** |
| Zé do Caixa | operador | **1111** |

- **Operador** vende, abre/fecha caixa, faz sangria/suprimento, recebe fiado.
- **Gerente** (ou admin) autoriza com PIN: **cancelamento de venda**, **desconto acima do limite** (padrão 10%), **perda/quebra**, **ajuste de estoque** e lançamento manual no fiado. Quando o operador tenta, abre a janela “PIN do gerente” e o servidor confere o papel.
- **Admin** cria usuários e troca PINs (Config. › Usuários).

Troque os PINs antes de usar de verdade.

## 3. Teclado, balança e leitor de código de barras

| Tecla | O que faz |
|---|---|
| **F2** | digitar o peso na mão (teclado numérico grande; 1 2 5 0 = 1,250 kg) |
| **F4** | ir para o campo da balança |
| **F3** | busca por nome / código / EAN |
| **Enter** | confirma peso, código ou busca |
| **F6** | pausar venda · **F8** retomar |
| **F7** | desconto no total (% ou R$) |
| **F9** | limpar a sacola |
| **F10 / F12** | receber (pagamento) — e, dentro do pagamento, finalizar |
| **F1…F6** (no pagamento) | Dinheiro, PIX, Débito, Crédito, Voucher, Fiado |
| **↑ ↓ / Delete** | escolher / tirar item da sacola |
| **Esc** | fecha janela / cancela pesagem |

**Balança e leitor entram como teclado** (modo “keyboard wedge”), com Enter no fim:

- O **peso** pode chegar no campo da balança ou na busca: `1,250`, `01.250` ou `0.500` (com separador = kg). Digitado sem vírgula vale em **gramas** (`1250` = 1,250 kg).
- Fluxo da banca: **põe na balança → toca no atalho** (o peso vai para o item e zera). Ou **toca no atalho primeiro** → aparece “Pese o Tomate e aperte Enter”.
- **Código de barras** (EAN) ou **código interno** na busca + Enter adiciona o item.
- **Etiqueta de balança** (EAN-13 que começa com `2`): `2` + código do produto (5 dígitos) + peso em gramas (6 dígitos) + DV. Ex.: `2 00101 001500 6` (2001010015006) = Tomate 1,500 kg. Em Config. dá para trocar para “preço na etiqueta” e 4/5/6 dígitos de código.

### Leitor de código de barras (v3)

| Jeito | Como usar |
|---|---|
| **📷 Câmera** (celular ou webcam do PC) | Na venda, botão **📷** ao lado da busca. Aponte para o código a um palmo; ao ler dá **bipe + vibração** e o item entra na sacola. A janela fica aberta para ler o próximo (*leitura contínua*); toque em **Concluir** no fim. Para somar outra unidade do mesmo produto, tire o código da frente da câmera e aponte de novo (ou toque na linha da sacola e mude a quantidade). Lê **EAN-13, EAN-8, UPC-A/E, Code128 e QR**. Tem 🔦 lanterna e 🔄 trocar câmera quando o aparelho deixa, e ⌨ *Digitar código*. |
| **Leitor USB / Bluetooth** (modo teclado) | Plugue e leia: funciona em qualquer lugar da tela de venda, **mesmo com o cursor fora da busca** (até no campo da balança — o peso não é estragado). O app reconhece o leitor porque as teclas chegam muito rápido e terminam com Enter; o que a pessoa digita devagar continua normal. |
| **Etiqueta da balança** (EAN-13 com “2”) | Leia com a câmera ou o leitor: o app tira o **código do produto** e o **peso** (ou o **preço**, conforme *Config. › Etiqueta de balança*) e já lança a quantidade. O código da etiqueta é o **Código (PLU da balança)** do cadastro — use na balança o mesmo código. Em *Config.* há um campo **“Testar uma etiqueta”** que mostra o que o app entende antes de vender. |
| **Cadastrar o código de barras** | *Produtos › (produto) › Código de barras (EAN) › 📷* — lê e preenche; toque em *Salvar produto*. *Produtos › 📷 Ler código* acha o produto pelo código (ou abre um novo já com o código). Avisa se o dígito verificador está errado, se o código já é de outro produto ou se parece etiqueta de balança. |
| **Código desconhecido na venda** | Aparece o aviso **“Código … não cadastrado”** com o botão **Cadastrar produto** (gerente/admin): abre o cadastro ali mesmo, com o código preenchido, sem perder a sacola; ao salvar o produto já entra na venda. Operador vê “peça ao gerente para cadastrar”. |
| **Compras e estoque** | O campo *Adicionar produto* da compra e o seletor de produto do estoque (perda/ajuste/entrada) têm **📷** para escolher o produto pelo código. |

- **Por dentro:** usa o leitor nativo do navegador (**BarcodeDetector**) quando o aparelho tem (Android/ChromeOS/macOS) e, quando não tem (Chrome do **Windows**, alguns Android), a biblioteca **ZXing** — carregada só quando a câmera abre e guardada pelo service worker. A procura do produto é feita na lista já carregada (funciona sem internet); se não achar, pergunta ao banco (produto cadastrado em outro aparelho). UPC-A de 12 dígitos e EAN-13 com zero na frente valem como o mesmo código.
- **Câmera precisa de https** (o GitHub Pages já é). Se a permissão for negada aparece a explicação em português (Android: cadeado › Permissões › Câmera; app instalado: segurar o ícone › Informações do app › Permissões; Windows: cadeado › Câmera e *Configurações › Privacidade › Câmera*) com **Tentar de novo**, e dá para digitar o código na mesma janela.
- **Bipe:** liga/desliga por aparelho em *Config. › Leitor de código de barras* (a vibração do celular continua).

## 4. Um dia de banca

1. **Abrir o caixa** — Entre com o PIN, conte o fundo de troco (ex.: R$ 100,00) e toque em *Abrir caixa* (na própria tela de venda ou em *Caixa*). Um caixa aberto por terminal; o nome do terminal fica em Config.
2. **Chegou mercadoria** — *Compras › Nova compra*: escolha o **fornecedor** e lance os itens (quantidade, custo por kg/un, **lote e validade opcionais**). Tudo entra de uma vez; o custo atualiza a margem. Mudou o preço na pedra? *Produtos › Preço do dia*.
3. **Vender com a balança** — Ponha o tomate na balança, toque em **Tomate**: entra `1,250 kg × R$ 6,99/kg = R$ 8,74` (total da linha = `round(preço/kg × gramas ÷ 1000)`). Alface/maço/bandeja/dúzia/pacote entram por unidade; toque de novo para somar. Toque na linha para mudar peso/quantidade ou dar **desconto no item** (% ou R$).
4. **Receber** — F10. Lance quanto foi em cada forma: **PIX R$ 20,00 + Dinheiro R$ 50,00** → mostra o **troco** (troco só sai do dinheiro; PIX/cartão/voucher/fiado não passam do total). Cliente é opcional; **fiado** exige cliente e respeita o limite.
5. **Cupom** — sai na tela, com *Imprimir (80 mm)*, *PDF*, *.bin ESC/POS* e *Térmica* (impressora de rede). Todo cupom diz **“NÃO É DOCUMENTO FISCAL”**.
6. **Freguês esqueceu a carteira** — F6 *Pausar* (dá um nome, “Moça do boné”), atende o próximo, F8 *Retomar*.
7. **Sangria / suprimento** — *Caixa › Sangria* tira dinheiro da gaveta (não deixa tirar mais do que tem); *Suprimento* põe troco.
8. **Perda / quebra** — *Estoque › Perda*: produto, quantidade, motivo (**amadureceu, estragou, queda, consumo interno**). Precisa do PIN do gerente, baixa o estoque, **não vira venda** e aparece no relatório de perdas pelo custo.
9. **Item vencendo / estoque baixo** — o cabeçalho mostra “⚠ N” (lotes que vencem em até 2 dias + produtos abaixo do mínimo) e leva a *Estoque › Alertas*; o atalho ganha a etiqueta “vence”.
10. **Fiado** — *Fiado*: extrato do cliente, **Receber** (dinheiro/PIX/cartão — entra no caixa aberto) e *Lançar no fiado* (dívida antiga do caderno, com PIN do gerente).
11. **Cancelar venda** — *Vendas › Cancelar* (só vendas do dia, PIN do gerente): **o estoque volta, o caixa é estornado** por forma e o fiado também.
12. **Fechar o caixa** — *Caixa › Fechar caixa*: digite o **contado** de cada forma (dinheiro, PIX, débito, crédito, voucher, fiado); a tela mostra **esperado × contado × diferença** (sobra/falta) e imprime o fechamento.
13. **Relatórios** — dia/período: vendido, nº de vendas, **ticket médio**, **margem estimada** (preço − custo), por **operador**, **pagamento**, **categoria**, **produto**, **perdas** — com botão **CSV** em cada bloco (separador `;`, abre no Excel) e impressão.
14. **Backup** — *Config. › Backup › Fazer backup agora* e copie o arquivo para um pendrive.

## 5. Estoque negativo, itens inativos e regras

- Produto **inativo não vende** (nem pela busca, nem pelo leitor).
- **Estoque negativo é bloqueado** por padrão. Para o fim de feira, libere em *Config. › Liberar estoque negativo* ou só no produto (*Pode vender sem estoque*).
- Desconto acima do limite (Config., padrão 10% sobre o bruto da venda) pede PIN do gerente.
- Unidades: **KG** (padrão), **UN**, **BANDEJA**, **MAÇO**, **DÚZIA**, **PCT**.
- **Dinheiro em centavos** (inteiro) no banco. **Peso em gramas** (inteiro), exibido em kg com 3 casas. Para unidades, a quantidade é guardada ×1000 (2 un = 2000), o que deixa uma só fórmula para todos.

## 6. Cupom e impressora

- **HTML 80 mm**: botão *Imprimir* usa `window.print()` com CSS de 80 mm (escolha a térmica no diálogo do navegador). Também em `/api/sales/:id/receipt.html?print=1`.
- **PDF 80 mm**: `/api/sales/:id/receipt.pdf` (gerado no servidor com pdfkit).
- **ESC/POS 80 mm (48 colunas)**: `/api/sales/:id/receipt.bin` — inicializa, página de código PC860 (acentos em português), negrito, total em fonte dupla, abre a gaveta quando teve dinheiro e corta o papel.
- **Impressora de rede**: informe IP/porta (RAW 9100) em Config. e use *Térmica ESC/POS*. Sem impressora configurada ou desligada, aparece um aviso — o caixa não trava.
- O fechamento de caixa tem as mesmas saídas (`/api/cash/sessions/:id/report.{html,pdf,bin}`).

## 7. Backup e restauração

- *Config. › Backup* cria uma cópia consistente do SQLite (API de backup do SQLite, pode ser feita com o caixa aberto) em `server/data/backups/folha-AAAA-MM-DD-HH-MM-SS.db` e deixa baixar.
- **Restaurar**: desligue o caixa (`Ctrl+C`), substitua `server/data/folha.db` pelo arquivo do backup (apague `folha.db-wal` e `folha.db-shm` se existirem) e ligue de novo.

## 8. Fiscal

O cupom é **não fiscal**. Existe a interface `FiscalProvider` (`server/src/services/fiscal.ts`) com um **`MockFiscalProvider`** que só registra uma “emissão simulada” em `fiscal_documents` para cada venda. Nada é enviado à SEFAZ. NCM, CFOP e CST ficam guardados no produto para uma NFC-e futura.

## 9. Por dentro

```
folha-caixa/
├── shared/      tipos, cálculo de venda/desconto/troco, formatação BRL/kg, barcode.ts (EAN/UPC, etiqueta de balança, leitor USB)
├── server/      Fastify + TypeScript + better-sqlite3
│   ├── migrations/               migrações SQL (rodam sozinhas ao ligar)
│   ├── src/services/             caixa, vendas, estoque, fiado, relatórios, cupom, fiscal
│   ├── src/app.ts                rotas /api (validação com zod) + serve a tela compilada
│   └── test/flow.test.ts         testes de integração (vitest) em SQLite temporário
├── web/         React + TypeScript + Vite (fonte DM Sans embutida, sem CDN)
│   ├── src/backend/   modo online: supabase.ts (rotas → RPCs), fila offline, datas
│   ├── src/files.ts   PDF (jsPDF), .bin ESC/POS, CSV e backup gerados no navegador
│   ├── src/scan/      leitor de código: engine.ts (BarcodeDetector → ZXing), useWedge.ts (leitor USB), feedback.ts (bipe/vibração)
│   ├── src/components/Scanner.tsx  janela da câmera
│   └── public/        manifest.webmanifest + ícones do PWA (sw.js é gerado no build)
├── supabase/    modo online: sql/ (esquema, funções, contas, seed, permissões), functions/accounts (Edge Function), apply.mjs, setup-auth.mjs, test/
├── scripts/     prints.mjs, prints-v2.mjs, qa-online.mjs, qa-v3.mjs, barcode-video.mjs, pwa-audit.mjs, icons.mjs, zip.sh
├── .github/workflows/pages.yml   build + deploy no GitHub Pages
└── docs/prints/ capturas de tela (online/ = modo online; v2/before e v2/after = antes/depois da v2)
```

- **Transação** em toda baixa de estoque e movimento de caixa (venda, cancelamento, perda, entrada, ajuste, sangria, suprimento, recebimento de fiado, fechamento).
- **Kardex** (`stock_movements`) com saldo após cada movimento; **auditoria** (`audit_log`) de login, vendas, cancelamentos, perdas, descontos autorizados, configurações, usuários e backups — visível em *Config. › Auditoria*.
- **Número de venda sequencial** único; **uma sessão aberta por terminal** garantida por índice único no banco.
- Tela: fundo creme `#F7F4EC`, verde-folha `#1F7A4D` nas ações, lima `#8FBF3F` no destaque, tomate `#E25B45` só para cancelar/perda, carvão `#1C1917` no texto. Números tabulares grandes; botões ≥ 48 px; pensado para 1366×768 e tablet (1024×768, 1180×820).

## 10. Testes

`npm run test:supabase` roda `supabase/test/flow.test.mjs` (15 testes) **contra o banco online de verdade** (RPCs + RLS + Edge Function): banco zerado e cadastro aberto só para o primeiro; sem login não lê nem chama nada; signup público do Supabase desligado; **primeiro cadastro vira admin e depois o cadastro fecha**; admin cria gerente/operador e outros não; troca de senha; PIN certo/errado e hash ilegível; fornecedor, **entrada de compra com vários itens** e preço do dia; abrir caixa; vender **1,250 kg de tomate com PIX + dinheiro** e troco; estoque negativo/inativo/troco/desconto com gerente; fila offline sem duplicar; fiado; perda; cancelar; sangria/suprimento e fechar; relatório e auditoria. As contas são temporárias (senhas aleatórias só na memória) e o teste **confere que termina com zero contas**.

`npm test` roda `server/test/barcode.test.ts` (20 testes: dígito verificador EAN-13/EAN-8/UPC-A, UPC-E→UPC-A, limpeza do que vem do leitor, UPC ⇄ EAN-13, **etiqueta de balança** com 4/5/6 dígitos, DV errado, peso e **preço** (acha o peso que dá exatamente o preço da etiqueta), resolução contra o cadastro, código desconhecido, **detector do leitor USB** (rápido × digitado) e o `/api/products/lookup` do servidor local) e `server/test/flow.test.ts` (21 testes) num banco temporário:
abrir caixa (e recusar o segundo), vender **1,250 kg** de tomate com **PIX + dinheiro** e troco, recusar PIX acima do total, cupom texto/ESC-POS/PDF com “NÃO É DOCUMENTO FISCAL”, desconto acima do limite com gerente, **lançar perda**, estoque negativo bloqueado/liberado, item inativo, fiado com limite e recebimento, sangria/suprimento, **cancelar** (estorna estoque e caixa), pausar/retomar, **fechar caixa** (contado × esperado), relatório/CSV, auditoria, backup, **fornecedores/entrada de compra e preço do dia**.

## 11. Capturas (docs/prints)

| | |
|---|---|
| `01-login-pin.png` | entrada com PIN |
| `02-venda-caixa-fechado.png` | venda com caixa fechado (abre ali mesmo) |
| `03-venda-carrinho-balanca.png` | pesando a cebola (pesagem pendente) |
| `04-venda-carrinho.png` | sacola com peso, preço/kg e total |
| `05-pagamento-misto.png` | PIX + dinheiro com troco |
| `06-cupom.png` | cupom 80 mm |
| `07-caixa-aberto.png` / `08-caixa-fechamento.png` / `09-caixa-relatorio-fechamento.png` | caixa e fechamento |
| `10-estoque-perda.png` | perda/quebra |
| `11-relatorio.png` | relatório do dia |
| `12-cadastro-produto.png` / `13-atalhos-config.png` | cadastro e atalhos |
| `14-fiado-extrato.png` / `15-vendas-do-dia.png` | fiado e vendas |
| `16-venda-pausada.png` / `17-cancelamento-pin-gerente.png` / `18-venda-cancelada.png` | pausa e cancelamento |
| `tablet-1024x768-*.png`, `tablet-1180x820-*.png` | tablet no balcão |

**Versão 2** (`docs/prints/v2/`): `before/` = como era; `after/` = como ficou, tirado na URL publicada (`desk-*` 1366×768, `tab-*` 1024×768, `cel-*` 390×844): criar cadastro, entrar com usuário, PIN/trocar operador, Hoje, venda, compras/fornecedores, preço do dia, alertas, vendas com busca, usuários, minha conta, instalar. Gerado por `node scripts/prints-v2.mjs after` (zera o banco no fim).

**Versão 3** (`docs/prints/v3/`, gerado por `npm run qa:v3`; resultado em `RESULTADO.txt`): `desk-01-venda-botao-camera`, `desk-02-leitor-camera-lendo`, `desk-03-leitor-etiqueta-balanca`, `desk-04-codigo-desconhecido-cadastrar`, `desk-05-cadastro-pelo-codigo`, `desk-06-produto-campo-ean`, `desk-07-config-etiqueta-balanca`, `desk-08-camera-sem-permissao`, `desk-09-sacola-depois-das-leituras`, `desk-10-aviso-nova-versao` (faixa “Nova versão” com *Atualizar agora*, tirada no build local), `cel-01-venda-botao-camera`, `cel-02-leitor-camera`, `cel-03-produto-campo-ean`.

**QA online** (`docs/prints/online/`, gerado por `npm run qa:online`; resultado em `RESULTADO.txt`): entrar com usuário e senha, trocar operador pelo PIN, venda 1,250 kg PIX + dinheiro e cupom, faixa “Sem internet” e fila, app reaberto sem internet, trocar senha, backup, outro navegador vendo as mesmas vendas; `tab-*` 1024×768 e `cel-*` 390×844.

## 12. Limitações (o que ainda não faz)

- **Sem NFC-e/SEFAZ**: só o `MockFiscalProvider`. Cupom não fiscal.
- **Balança serial direta** (protocolo Toledo/Filizola pela porta COM) não está implementada: a balança precisa estar em modo teclado (wedge) ou usar etiqueta EAN-2.
- **Etiqueta de balança no modo preço:** a quantidade é o peso que dá o preço da etiqueta com o preço/kg do cadastro; se o preço da balança estiver diferente do cadastro, o total da linha segue o cadastro (pode diferir alguns centavos da etiqueta). Etiquetas com “dígito verificador do preço” dentro do valor (layout raro) não são lidas.
- **Câmera:** a leitura depende de foco e luz; códigos muito pequenos/amassados podem precisar do leitor USB. iPhone/Safari usa a biblioteca ZXing (sem leitor nativo). Leitor USB que não manda Enter no fim precisa ser configurado para mandar (quase todos vêm assim).
- **TEF/maquininha e PIX dinâmico** não integrados: o operador lança o valor recebido na maquininha.
- **Lotes**: a saída consome o lote que vence primeiro (informativo); o cancelamento devolve ao saldo do produto, mas não ao lote.
- **Vários terminais** funcionam se apontarem para o mesmo servidor (cada um com seu nome em Config.), mas não há sincronização entre servidores diferentes. No **modo online** todos os aparelhos já compartilham o mesmo banco (dê um nome de terminal diferente a cada aparelho que tiver caixa próprio).
- **Online × local não se sincronizam**: são bancos separados (Supabase × SQLite).
- **Modo online offline**: só vendas simples entram na fila (sem fiado, sem desconto acima do limite); o resto precisa de internet. Se o aparelho for limpo (dados do navegador apagados) com vendas na fila, elas se perdem.
- **Modo online sem impressão direta na térmica de rede** (porta 9100) e sem *teste de impressora*; sem **restaurar backup** pela tela (o backup online é só exportação JSON/CSV).
- **PIN de 4 dígitos** no modo online: só funciona depois que o aparelho entrou com usuário + senha; tentativas erradas ficam na auditoria, mas não há bloqueio automático por excesso de tentativas.
- **Esqueci a senha do admin**: não há “esqueci minha senha” por e-mail (o e-mail é interno). Outro admin gera *Nova senha*; se só existe um admin, o dono redefine pelo painel do Supabase (Authentication › Users).
- Busca de clientes no **modo local** ainda diferencia acentos (a de produtos não).
- Plano gratuito do Supabase pausa o projeto depois de ~1 semana sem uso; é só reativar no painel.
- Retirar item da sacola **antes** de finalizar não pede gerente (nada foi vendido ainda); cancelamento de venda finalizada pede.
- A impressão HTML depende do diálogo do navegador; para imprimir sem diálogo use a impressora de rede ESC/POS ou o modo quiosque do Chrome (`--kiosk-printing`).
- O seed traz 24 atalhos prontos; dá para trocar em *Produtos › Atalhos* (ou *Sugerir pelos mais vendidos*).
