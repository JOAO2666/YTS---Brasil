# 🚀 YTSBR Pro — Stremio Addon

[![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com/new)
[![Stremio](https://img.shields.io/badge/Stremio-Addon-blueviolet?style=for-the-badge&logo=stremio)](https://www.strem.io/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)

Addon de alta performance para Stremio que integra o catálogo do **YTS Brasil** com tradução automática de títulos, busca paralela e suporte completo a filmes, séries e animes.

---

## ⚡ Funcionalidades

| Feature | Descrição |
|---|---|
| 🎬 **Filmes** | 720p, 1080p, 4K — Dual Áudio, Dublado e Legendado |
| 📺 **Séries** | Detecção automática de temporadas e packs |
| 🇯🇵 **Animes** | Suporte a episódios individuais e packs completos |
| 🌐 **Tradução TMDB** | Converte títulos automaticamente (EN → PT-BR) |
| 🔍 **Busca Paralela** | Múltiplas queries simultâneas para máxima cobertura |
| 💾 **Cache Inteligente** | Respostas instantâneas após a primeira busca |

---

## 🛠️ Deploy na Vercel (Grátis, 24/7)

1. Faça **fork** deste repositório
2. Acesse [vercel.com](https://vercel.com/) → **Add New** → **Project**
3. Importe o repositório, selecione **Other** como Framework Preset
4. Clique em **Deploy**
5. Copie o link gerado (ex: `https://seu-projeto.vercel.app`)

### Instalar no Stremio

Cole o link no campo de addon do Stremio:
```
https://seu-projeto.vercel.app/manifest.json
```

---

## 🏗️ Stack Técnica

- **Runtime**: Node.js 20+
- **Framework**: Stremio Addon SDK + Express
- **Tradução**: TMDB API (gratuita)
- **Scraping**: Axios + Cheerio
- **Busca**: API interna JSON do YTSBR
- **Cache**: node-cache (2h TTL)

---

## 📝 Aviso Legal

Este addon é apenas um indexador de links torrent disponíveis publicamente. Não hospedamos nenhum arquivo. O uso é de inteira responsabilidade do usuário.
