# cam1 — Playlist ao vivo do CAM4

Sistema Node.js que descobre transmissões ao vivo do CAM4 (cam4.com) via API
GraphQL, valida os manifestos HLS de cada sala, gera a playlist `cam1.m3u`
e publica automaticamente no repositório
[`leandrorsnrz/cam1-playlist`](https://github.com/leandrorsnrz/cam1-playlist).

## Arquitetura

```
src/
  config.js     — leitura do .env (CAM4_*, GITHUB_*, VALIDATE_*)
  cam4.js       — descoberta: API GraphQL + fallback HTML do diretório
  validate.js   — validação dos manifestos HLS (2 passadas, pool concorrente)
  m3u.js        — geração do M3U ordenado e deduplicado
  github.js     — publicação via GitHub Contents API (GET sha + PUT base64)
  pipeline.js   — orquestração de um ciclo completo
  cycle.js      — execução única por linha de comando (CLI)
  server.js     — interface web local (porta 3333) + agendador de 15 min
test/           — suíte de testes (node --test)
```

Fluxo de um ciclo: **descobrir → filtrar → validar → gerar M3U → comparar
com o publicado → commitar apenas se houver mudança real → atualizar
`data/state.json`**.

## Uso local (via principal)

```bash
npm install
npm start            # servidor + interface em http://localhost:3333
npm test             # roda a suíte de testes
node src/cycle.js    # um ciclo completo (publica no GitHub)
node src/cycle.js --check   # descobre e valida, sem publicar
```

O servidor roda no PC e agenda um ciclo a cada 15 minutos. É a **via
principal**: o IP residencial não é bloqueado pelo CAM4, então a descoberta
e a validação funcionam normalmente.

Inicialização automática: `start-hidden.vbs` instalado na pasta
`Inicializar` do Windows (menu Iniciar → Programas → Inicializar).

## Via de reserva (GitHub Actions)

O workflow `.github/workflows/update-playlist.yml` roda a cada 15 minutos
na nuvem do GitHub e também sob demanda (aba Actions → "Atualiza playlist
CAM4" → Run workflow).

**Limitação conhecida:** o CAM4 costuma bloquear acesso vindo de IPs de
datacenter (GitHub Actions/Azure). Nesses casos a descoberta falha e o CLI
termina com o código **3** — o workflow trata esse resultado como neutro
(exit 0 + aviso `::notice` + resumo no step summary) para não mascarar
falhas reais de código, e a playlist continua sendo atualizada pelo
sistema local.

### Códigos de saída do `src/cycle.js`

| Código | Significado |
|--------|-------------|
| 0      | Sucesso: playlist gerada e publicada |
| 1      | Erro genérico (falha inesperada) |
| 2      | Ciclo concluído e publicado, mas há links inválidos não incluídos |
| 3      | Descoberta indisponível (ex.: CAM4 bloqueia IP de datacenter); nada foi publicado |

## Configuração (`.env`)

Copie `.env.example` para `.env` e preencha:

- `GITHUB_TOKEN` — token com permissão `contents: write` no repositório de destino
- `GITHUB_REPO` — `usuario/repo` (padrão: `leandrorsnrz/cam1-playlist`)
- `GITHUB_BRANCH`, `GITHUB_FILE_PATH` — destino da playlist
- `CAM4_GENDERS`, `CAM4_PAGE_SIZE`, `CAM4_MAX_PAGES`, `CAM4_MAX_ROOMS`,
  `CAM4_INCLUDE_PRIVATE` — parâmetros de descoberta
- `VALIDATE_LINKS`, `VALIDATE_CONCURRENCY`, `VALIDATE_TIMEOUT_MS` — validação HLS
- `PORT`, `LOG_LEVEL` — servidor e logs

Estado e logs ficam em `data/` (`state.json`, `cam1.m3u`, `logs/`).

## Playlist pública

<https://raw.githubusercontent.com/leandrorsnrz/cam1-playlist/main/cam1.m3u>