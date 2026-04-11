# 🚀 YTSBR Pro - Stremio Addon

[![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com/new)
[![Stremio](https://img.shields.io/badge/Stremio-Addon-blueviolet?style=for-the-badge&logo=stremio)](https://www.strem.io/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)

O **YTSBR Pro** é um addon de alto desempenho para Stremio, focado na entrega ultra-rápida de conteúdos do YTS Brasil. Desenvolvido com uma arquitetura resiliente e um motor de busca "Omni-Search", ele resolve o problema de títulos traduzidos e garante que você encontre o que procura, seja um filme, série ou anime.

---

## 🔥 Diferenciais "Senior"

*   **Motor Omni-Search v3**: Busca paralela em múltiplos idiomas (PT-BR/EN) e resoluções de títulos via Wikipedia/API Interna.
*   **Performance Serverless**: Otimizado para Vercel. Sem necessidade de servidores ligados 24/7.
*   **Zero Mismatch**: Inteligência artificial de busca que converte títulos originais (IMDb) para os nomes usados no catálogo brasileiro.
*   **Suporte Full**: 
    *   🎥 Filmes em 720p, 1080p e 4K.
    *   📺 Séries com detecção automática de temporadas.
    *   🇯🇵 Animes (Incluso packs de episódios).
*   **Cache Inteligente**: Redução de 80% no tempo de resposta usando `node-cache`.

---

## 🛠️ Instalação (Deploy Fácil e Grátis)

Para ter seu addon funcionando 24/7 sem gastar nada e sem depender do seu computador:

### 1. Deploy na Vercel
1.  Acesse o site da [Vercel](https://vercel.com/).
2.  Clique em **"Add New"** > **"Project"**.
3.  Importe este repositório do seu GitHub.
4.  No campo **Framework Preset**, deixe como `Other`.
5.  Clique em **Deploy**.

### 2. Adicionar ao Stremio
Após o deploy, a Vercel te dará um link (ex: `https://yts-brasil-pro.vercel.app`).
1.  Copie esse link.
2.  Abra o [Stremio](https://web.stremio.com/).
3.  Vá em **Addons** > **Paste Addon URL**.
4.  Cole o link da Vercel e clique em **Install**.

---

## 🏗️ Estrutura Técnica

*   **Linguagem**: Node.js v20+
*   **Framework**: Stremio Addon SDK / Express
*   **Motor de Scraping**: Axios + Cheerio (altíssima velocidade)
*   **Busca**: YTSBR Internal JSON API (Resiliente a mudanças no site)

---

## 📝 Isenção de Responsabilidade
Este addon é apenas um indexador de links torrent fornecidos publicamente pelo site YTSBR. Não hospedamos nenhum arquivo. O uso é de inteira responsabilidade do usuário.

---

<p align="center">
  Desenvolvido com ❤️ para a comunidade Stremio Brasil.
</p>
