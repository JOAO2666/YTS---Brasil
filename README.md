# 🎬 YTSBR Pro — Stremio Addon

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/JOAO2666/YTS---Brasil)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> High-performance Stremio addon that brings the entire **YTS Brasil** catalog to your fingertips — movies, series and anime with automatic title translation and parallel search.

---

## ✨ Features

| | Feature | Details |
|---|---|---|
| 🌐 | **Universal Search** | Translates English IMDb titles to Portuguese via TMDB, then searches YTSBR in both languages simultaneously |
| ⚡ | **Parallel Pipeline** | Cinemeta metadata, TMDB translation, and YTSBR search all run concurrently — typical response under 3 s |
| 💾 | **Smart Cache** | 2-hour in-memory cache eliminates redundant network calls; subsequent lookups return in < 50 ms |
| 🎬 | **Movies** | 720p · 1080p · 4K — Dual Audio, Dubbed, Subtitled |
| 📺 | **Series** | Automatic season/episode routing with full-season pack support |
| 🇯🇵 | **Anime** | Detects both individual episodes and batch packs |
| 🔗 | **Dual Format** | Extracts magnet hashes (pt-BR pages) and `.torrent` URLs (EN pages) |

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
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Cinemeta │────▶│  TMDB    │────▶│  YTSBR   │
│ (title)  │  ∥  │ (pt-BR)  │  ∥  │ (search) │
└──────────┘     └──────────┘     └──────────┘
     └──────────────┬──────────────────┘
                    ▼
             ┌────────────┐
             │ Page Fetch │
             │ + Extract  │
             └────────────┘
                    │
                    ▼
             magnet / .torrent
```

All external calls run in parallel via `Promise.all` to stay within Vercel's 10 s timeout.

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
| Search | YTSBR internal JSON API |
| Cache | node-cache (2 h TTL) |
| Hosting | Vercel Serverless |

---

## 📝 Disclaimer

This addon is an aggregator of publicly available torrent links. No files are hosted or distributed. Usage is at your own responsibility and must comply with your local laws.

---

## 📄 License

[MIT](LICENSE) — feel free to fork, modify and redistribute.
