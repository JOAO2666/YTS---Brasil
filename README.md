# 🎬 YTSBR Pro — Stremio Addon

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/JOAO2666/YTS---Brasil)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Stremio addon multi-provider que agrega torrents em pt-BR de **YTS Brasil**, **NerdFilmes**, **XFilmes**, **HDR Torrent**, **Apache Torrent** e **Nyaa.si** — com tradução automática do título e busca paralela.

---

## ✨ Features

| | Feature | Details |
|---|---|---|
| 🌐 | **Multi-Provider** | YTSBR · NerdFilmes · XFilmes · HDR Torrent · Apache Torrent · Nyaa.si — todos em paralelo |
| 🇧🇷 | **Universal Search** | Traduz títulos IMDb EN → pt-BR via TMDB e consulta os sites em ambos os idiomas simultaneamente |
| ⚡ | **Pipeline Paralelo** | Cinemeta + TMDB + 6 providers rodam concorrentemente — resposta típica dentro do orçamento de 10 s da Vercel |
| 💾 | **Smart Cache** | Cache de 2 h em memória; lookups subsequentes retornam em < 50 ms |
| 🎬 | **Filmes** | 720p · 1080p · 4K — Dual Áudio, Dublado, Legendado |
| 📺 | **Séries** | Roteamento automático por temporada/episódio com suporte a packs |
| 🇯🇵 | **Anime** | Nyaa.si + YTSBR · detecta episódios individuais e batches |
| 🔗 | **Formatos** | Magnet hashes (infoHash) + `.torrent` URLs + resolução de redirects (XFilmes) |

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

## 🏗️ Architecture

```
                    Stremio Client
                         │
                         ▼
            ┌────────────────────────┐
            │  Cinemeta  ║   TMDB    │   (paralelo)
            │  (título)  ║  (pt-BR)  │
            └────────────┬───────────┘
                         ▼
   ┌────────┬────────────┬────────────┬────────────┬────────┐
   │ YTSBR  │ NerdFilmes │  XFilmes   │   Apache   │  HDR   │  +  Nyaa
   └────────┴────────────┴────────────┴────────────┴────────┘
                         │   (6 providers em paralelo)
                         ▼
               Agregação + dedup por infoHash
                         │
                         ▼
                 magnet / .torrent
```

Todas as chamadas externas rodam em paralelo via `Promise.all`, cada provider com timeout hard para caber nos 10 s da Vercel.

### Provedores

| Provider | Estratégia | Foco |
|---|---|---|
| **YTSBR** | JSON API + `data-downloads` | Filmes/Séries pt-BR |
| **NerdFilmes** | `/?s=` + magnets diretos | Filmes/Séries pt-BR |
| **XFilmes** | `/?s=` + redirect 302 (`/?go=HASH` → `magnet:`) | Filmes/Séries pt-BR |
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
├── index.js        # Addon manifest, handlers & HTTP layer
├── scraper.js      # Search engine, translation & stream extraction
├── vercel.json     # Vercel serverless configuration
├── package.json    # Dependencies & scripts
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
| Providers | YTSBR · NerdFilmes · XFilmes · HDR · Apache · Nyaa.si |
| Cache | node-cache (2 h TTL) |
| Hosting | Vercel Serverless |

---

## 📝 Disclaimer

This addon is an aggregator of publicly available torrent links. No files are hosted or distributed. Usage is at your own responsibility and must comply with your local laws.

---

## 📄 License

[MIT](LICENSE) — feel free to fork, modify and redistribute.
