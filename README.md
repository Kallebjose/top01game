# TOP 1 — Multiplayer online

Jogo multiplayer em **HTML, CSS e JavaScript puro**, preparado para GitHub Pages, usando **Firebase Authentication anônimo** e **Firebase Realtime Database**.

Esta versão foi revisada para evitar os problemas encontrados no projeto anterior: `PERMISSION_DENIED` na criação da sala, limite de jogadores dependente de `numChildren()`, resposta privada exposta cedo demais, fase presa em “apurando”, disputa de host e vagas fantasmas.

## Mecânica

1. O host cria uma sala e compartilha um código de 6 caracteres.
2. O host escolhe os temas e os pontos necessários para vencer.
3. Cada rodada sorteia uma pergunta e uma letra compatível.
4. Cada jogador tem **45 segundos** para enviar uma resposta começando com a letra sorteada. Se todos responderem antes, a rodada avança sem precisar esperar o relógio zerar.
5. As respostas ficam protegidas até a votação.
6. Respostas iguais (ignorando maiúsculas/minúsculas e acentos) são agrupadas e aparecem **uma única vez** na votação.
7. Se uma resposta compartilhada vencer, **todos os jogadores que deram aquela resposta recebem a pontuação**.
8. Na votação, aparecem apenas os textos, sem revelar os autores.
9. Ninguém pode votar no grupo da própria resposta.
10. Vencedor isolado da votação: **+2 pontos para cada autor daquela resposta**.
11. Empate em primeiro entre respostas diferentes: **+1 ponto para cada autor das respostas empatadas**.
12. Se mais de um jogador alcançar a meta empatado no topo, a partida continua em desempate até existir um líder isolado.

## Arquivos

- `index.html` — interface principal
- `styles.css` — design responsivo
- `app.js` — salas, presença, reconexão, votação, host e pontuação
- `data.js` — categorias, perguntas e letras compatíveis
- `firebase-config.js` — configuração do app Web Firebase
- `firebase.rules.json` — regras do Realtime Database
- `favicon.svg` — ícone do site
- `README.md` — configuração e testes

## 1. Configurar o Firebase Web

O projeto usa:

- Project ID: `top01-b6b93`
- Realtime Database: `https://top01-b6b93-default-rtdb.firebaseio.com`

Abra:

**Firebase Console → Configurações do projeto → Geral → Seus apps**

Copie o objeto `firebaseConfig` do aplicativo Web e coloque os valores em `firebase-config.js`.

Se você já preencheu esse arquivo na versão anterior, pode manter/copiar o seu `firebase-config.js` configurado para esta versão.

Exemplo:

```js
window.FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "top01-b6b93.firebaseapp.com",
  databaseURL: "https://top01-b6b93-default-rtdb.firebaseio.com",
  projectId: "top01-b6b93",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

A `apiKey` do Firebase Web é configuração pública do cliente. A proteção dos dados é feita por Authentication + Security Rules.

## 2. Ativar login anônimo

No Firebase Console:

**Authentication → Sign-in method → Anonymous → Enable**

O jogo usa o `auth.uid` anônimo como identidade do jogador. A persistência é `LOCAL`, então atualizar a página mantém o mesmo usuário e permite reconectar à sala.

## 3. Publicar as regras corretas

No Firebase Console:

**Realtime Database → Rules**

Apague as regras atuais, copie **todo** o conteúdo de `firebase.rules.json` desta versão e clique em **Publish**.

Não misture as regras antigas com estas.

### O que foi corrigido nas regras

- Não usa `numChildren()`.
- A criação inicial da sala é validada sem depender de um jogador que ainda não existia no banco.
- O limite de 10 participantes usa **10 slots fixos (`0` a `9`)**, reservados por transação.
- Duas pessoas tentando entrar ao mesmo tempo não conseguem ocupar a mesma vaga.
- Um jogador só pode criar o próprio registro depois de possuir um slot.
- Lista de jogadores só pode ser lida por quem já pertence à sala.
- Resposta/autoria/voto ficam separados por fase.
- Durante `answering`, outro jogador não consegue ler sua resposta pelo navegador.
- O limite de **45 segundos** também é aplicado nas Security Rules usando o relógio do servidor (`now`), não apenas na interface.
- Respostas iguais usam o mesmo identificador de opção, então viram uma única alternativa sem expor a autoria antes da apuração.
- Durante `voting`, todos veem os textos, mas não o vínculo autor ↔ resposta.
- O host só ganha acesso ao mapeamento e aos votos na fase técnica de apuração.
- Um jogador não pode votar na própria resposta nem alterar o voto depois de enviado.

## 4. Testar localmente

Na pasta do projeto:

```powershell
py -m http.server 5500 --bind 127.0.0.1
```

Abra:

```text
http://127.0.0.1:5500/
```

Evite abrir o arquivo diretamente como `file://`.

### Teste multiplayer correto

Use sessões diferentes, porque abas normais do mesmo navegador compartilham o mesmo Firebase Anonymous Auth.

Exemplo:

- Jogador 1: Chrome normal
- Jogador 2: janela anônima
- Jogador 3: Edge ou outro navegador

Roteiro recomendado:

1. Criar sala.
2. Entrar com mais 2 jogadores.
3. Alterar pontuação e temas como host.
4. Iniciar.
5. Enviar três respostas e confirmar que o contador começa em 45s.
6. Testar deixar um jogador sem responder até o contador chegar a 0 e confirmar que a rodada avança.
7. Fazer dois jogadores enviarem a mesma resposta com diferenças de maiúsculas/acentos e confirmar que ela aparece uma única vez.
8. Confirmar que nenhum jogador vê as respostas antes da votação.
9. Votar e confirmar que ninguém consegue votar no grupo da própria resposta.
10. Fazer a resposta duplicada vencer e conferir que os dois autores recebem +2; em empate entre respostas, cada autor das respostas empatadas recebe +1.
11. Atualizar uma página no meio da partida e validar reconexão.
12. Fechar o host e validar transferência automática de host.
13. Desconectar alguém durante resposta/votação e confirmar que a fase não fica presa.
14. Testar “Cancelar rodada” como saída de segurança para uma rodada sem jogadores/respostas suficientes.

## 5. Como funciona o limite de 10 jogadores

A sala possui:

```text
slots/
  0: UID
  1: UID
  ...
  9: UID
```

Ao entrar, o navegador tenta reservar um slot vazio usando uma **transaction** do Realtime Database. A transação impede que dois jogadores ganhem a mesma vaga simultaneamente.

Durante a pequena janela entre reservar a vaga e criar o jogador, existe um `onDisconnect().remove()` temporário no slot. Depois que o registro do jogador é criado com sucesso, esse `onDisconnect` temporário é cancelado. Isso reduz o risco de vaga fantasma caso a conexão caia exatamente no processo de entrada.

## 6. Presença e troca de host

Cada jogador possui `connected: true/false`.

Ao entrar na sala, o jogo registra:

```js
onDisconnect().set(false)
```

Se o host cair, os clientes conectados tentam assumir `meta/hostUid` através de uma transaction. Como a transaction é atômica, apenas um cliente vence a disputa.

Sair manualmente do lobby remove o jogador e libera seu slot. Durante uma partida, sair apenas marca o jogador como desconectado para preservar placar e reconexão.

## 7. Fases

```text
lobby
  ↓
answering
  ↓
voting
  ↓
scoring
  ↓
result
  ↓
answering ...
  ↓
finished
```

A fase `scoring` é curta e usada para impedir que autoria/votos sejam liberados antes do fechamento da votação.

A versão anterior possuía uma inconsistência que podia deixar a tela eternamente em **“Apurando os votos”**. Nesta versão, a apuração é executada somente quando `meta/phase === "scoring"`.

## 8. Casos extremos tratados

- sala inexistente;
- sala cheia;
- partida já iniciada;
- nome ou código inválido;
- duas entradas simultâneas;
- duas pessoas tentando assumir host;
- atualização da página;
- queda de conexão;
- host saindo;
- jogador desconectando depois de responder;
- jogador desconectando antes de votar;
- apenas um votante restante;
- resposta enviada duas vezes;
- tempo de resposta encerrado em 45 segundos;
- respostas iguais agrupadas em uma única alternativa;
- pontuação compartilhada entre todos os autores da mesma resposta vencedora;
- voto enviado duas vezes;
- voto na própria resposta;
- empate na rodada;
- empate ao atingir a meta;
- rodada sem condições de continuar, com cancelamento pelo host;
- reinício da partida limpando dados das rodadas anteriores;
- HTML digitado como nome/resposta sendo escapado na interface;
- mensagens explícitas para erros de Firebase em vez de loading infinito.

## 9. Publicar no GitHub Pages

1. Envie os arquivos para a raiz do repositório.
2. GitHub → **Settings → Pages**.
3. Em **Build and deployment**, escolha **Deploy from a branch**.
4. Branch: `main`.
5. Pasta: `/ (root)`.
6. Salve.

Não é necessário npm, Node, build ou backend próprio.

## Observação de segurança

Sem Cloud Functions/backend confiável, o host continua sendo a autoridade do cliente para avançar fases e calcular a pontuação. As regras protegem o fluxo normal contra leitura indevida e ações de outros jogadores, mas um host malicioso com acesso ao próprio console do navegador ainda é um cliente privilegiado. Para partidas entre amigos, essa arquitetura mantém o projeto simples e compatível com GitHub Pages.
#   t o p 0 1 g a m e  
 