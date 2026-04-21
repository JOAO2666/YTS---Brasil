# 🎬 YTSBR Pro — Stremio Addon

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/JOAO2666/YTS---Brasil)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Stremio addon multi-provider que agrega torrents em pt-BR de **YTS Brasil**, **BluDV**, **NerdFilmes**, **XFilmes**, **BaixaFilmesHDR**, **HDR Torrent**, **Apache Torrent** e **Nyaa.si** — com tradução automática do título e busca paralela.

---

## ✨ Features

| | Feature | Details |
|---|---|---|
| 🌐 | **Multi-Provider** | YTSBR · BluDV · NerdFilmes · XFilmes · BaixaFilmesHDR · HDR Torrent · Apache Torrent · Nyaa.si — todos em paralelo |
| 🇧🇷 | **Universal Search** | Traduz títulos IMDb EN → pt-BR via TMDB e consulta os sites em ambos os idiomas simultaneamente |
| ⚡ | **Pipeline Paralelo** | Cinemeta + TMDB + 8 providers rodam concorrentemente — resposta típica dentro do orçamento de 10 s da Vercel |
| 💾 | **Smart Cache** | Cache de 2 h em memória; lookups subsequentes retornam em < 50 ms |
| 🎬 | **Filmes** | 720p · 1080p · 4K — Dual Áudio, Dublado, Legendado |
| 📺 | **Séries** | Roteamento automático por temporada/episódio com suporte a packs |
| 🇯🇵 | **Anime** | Nyaa.si + YTSBR · detecta episódios individuais e batches |
| 🔗 | **Formatos** | Magnet hashes (infoHash) + `.torrent` URLs + resolução de redirects (XFilmes) + bypass do "protetor de links" `systemads.xyz` (BluDV / BaixaFilmesHDR) sem seguir redirects, timer ou ads |
| 🗄️ | **Cache Supabase** | Torrents pré-indexados · lookups em < 200 ms (opt-in via env vars) |
| 🔄 | **Auto-indexer** | GitHub Action roda a cada 6 h, popula o cache com top 100 títulos TMDB |
| ⚡ | **Real-Debrid** | Suporte opcional para marcar streams com cache em RD |

---

## 🚀 Deploy (Free, 24/7)

### One-Click Vercel

Click the button above **or** follow these steps:

1. Fork this repository
2. Go to [vercel.com](https://vercel.com) → **Add New** → **Project**
3. Import `YTS---Brasil`, set Framework to **Other**
4. Click **Deploy**

### Install in Stremio

```
https://YOUR-PROJECT.vercel.app/manifest.json
```

Paste the URL in **Stremio → Addons → Install from URL**.

---

## ⚡ Modo turbo — Cache persistente no Supabase (opcional mas recomendado)

Com o Supabase ligado o addon **responde em ~200 ms** (vs 3-6 s do scraping ao vivo). É grátis, leva 5 min pra configurar.

### 1️⃣ Criar projeto Supabase

1. Cadastre-se em [supabase.com](https://supabase.com) (grátis, sem cartão)
2. **New Project** → escolha nome + senha + região mais próxima
3. Aguarde ~2 min até o provisionamento completar

### 2️⃣ Rodar a migration SQL

1. No painel Supabase → **SQL Editor** → **New Query**
2. Cole o conteúdo de [`migrations/001_init.sql`](migrations/001_init.sql)
3. Clique em **Run**

### 3️⃣ Pegar as credenciais

No painel Supabase → **Settings** → **API**:

| Variável | Campo no painel |
|---|---|
| `SUPABASE_URL` | **Project URL** (ex.: `https://abcd.supabase.co`) |
| `SUPABASE_KEY` | **service_role** secret (⚠️ não a `anon`!) |

### 4️⃣ Configurar no Vercel

No dashboard Vercel do projeto → **Settings** → **Environment Variables** → adicione as duas variáveis. Depois **Deployments** → botão "…" no último deploy → **Redeploy**.

### 5️⃣ Configurar no GitHub (para o indexer rodar)

No repositório GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `TMDB_KEY` (opcional — pega em [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api))

### 6️⃣ Rodar o primeiro indexer

No GitHub → aba **Actions** → **Cache Indexer** → **Run workflow** → **Run workflow**.
Em ~10 min o Supabase terá ~100 títulos populares pré-indexados com todos os torrents. Depois disso, rode automaticamente de 6 em 6 h via cron.

### ⚡ (Opcional) Real-Debrid

Se tiver conta RD, adicione `REALDEBRID_KEY` no Vercel (obter em [real-debrid.com/apitoken](https://real-debrid.com/apitoken)). Streams com cache em RD aparecem marcados com `⚡ RD+`.

---

## 🏗️ Architecture

```
                    Stremio Client
                         │
                         ▼
              ┌──────────────────┐
              │  ⚡ FAST PATH    │  ─── cache Supabase (~200 ms)
              │  cache hit?      │       ▶ devolve + fim
              └────────┬─────────┘
                       │ miss
                       ▼
            ┌────────────────────────┐
            │  Cinemeta  ║   TMDB    │   (paralelo)
            │  (título)  ║  (pt-BR)  │
            └────────────┬───────────┘
                         ▼
   ┌───────┬───────┬────────────┬──────────┬───────────┬────────┬─────┐
   │ YTSBR │ BluDV │ NerdFilmes │ XFilmes  │ BaixaHDR  │ Apache │ HDR │ +Nyaa
   └───────┴───────┴────────────┴──────────┴───────────┴────────┴─────┘
                         │   (8 providers em paralelo)
                         ▼
               Agregação + dedup por infoHash
                         │
                         ├──▶ write-behind Supabase (próximo hit = rápido)
                         │
                         ├──▶ (opt) Real-Debrid: marca streams em cache
                         │
                         ▼
                 magnet / .torrent

   ─── Background ───────────────────────────────────────────────
   GitHub Actions cron (6h) ──▶ scripts/indexer.js
     └─ TMDB top 100 títulos ──▶ pré-popula Supabase
```

Todas as chamadas externas rodam em paralelo via `Promise.all`, cada provider com timeout hard para caber nos 10 s da Vercel.

### Provedores

| Provider | Estratégia | Foco |
|---|---|---|
| **YTSBR** | JSON API + `data-downloads` | Filmes/Séries pt-BR |
| **BluDV** | `/?s=` + resolver `systemads.xyz` (reverse-base64 no-redirect) | Filmes/Séries/Animes pt-BR |
| **NerdFilmes** | `/?s=` + magnets diretos | Filmes/Séries pt-BR |
| **XFilmes** | `/?s=` + redirect 302 (`/?go=HASH` → `magnet:`) | Filmes/Séries pt-BR |
| **BaixaFilmesHDR** | `/?s=` + resolver `systemads.xyz` (reverse-base64 no-redirect) | Filmes/Séries pt-BR |
| **HDR Torrent** | `/?s=` + magnets diretos | Filmes/Séries pt-BR |
| **Apache Torrent** | `/?s=` + magnets diretos | Filmes/Séries pt-BR |
| **Nyaa.si** | Tabela HTML com magnets embutidos | Animes / live-action asiático |

---

## 🛠️ Local Development

```bash
git clone https://github.com/JOAO2666/YTS---Brasil.git
cd YTS---Brasil
npm install
npm start          # http://localhost:7000/manifest.json
```

Hot reload:

```bash
npm run dev        # uses --watch (Node 18+)
```

---

## 📁 Project Structure

```
.
├── index.js                       # Addon manifest, handlers & HTTP layer
├── scraper.js                     # 8-provider aggregator + orchestration
├── db.js                          # Supabase cache (read-through + write-behind)
├── debrid.js                      # Real-Debrid integration (optional)
├── scripts/
│   └── indexer.js                 # Background indexer (populates Supabase)
├── migrations/
│   └── 001_init.sql               # Supabase schema
├── .github/workflows/indexer.yml  # Cron a cada 6 h
├── .env.example                   # Template de variáveis de ambiente
├── vercel.json                    # Vercel serverless config
├── package.json
└── .gitignore
```

---

## ⚙️ Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Framework | Stremio Addon SDK + Express |
| Translation | TMDB API (free) |
| Scraping | Axios + Cheerio |
| Providers | YTSBR · BluDV · NerdFilmes · XFilmes · BaixaFilmesHDR · HDR · Apache · Nyaa.si |
| Cache | node-cache (2 h) + Supabase Postgres (72 h) |
| Indexer | GitHub Actions cron 6 h + TMDB Popular API |
| Debrid | Real-Debrid API (optional) |
| Hosting | Vercel Serverless |

---

## 📝 Disclaimer

This addon is an aggregator of publicly available torrent links. No files are hosted or distributed. Usage is at your own responsibility and must comply with your local laws.

---

## 📄 License

[MIT](LICENSE) — feel free to fork, modify and redistribute.
