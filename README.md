# 🇧🇷 YTSBR Catalog - Stremio Addon

Um addon customizado para o **Stremio** que adiciona o catálogo de filmes e séries da equipe do YTS Brasil diretamente na sua interface!

🚀 Desenvolvido focado em velocidade e metadados detalhados:
- Detecta automaticamente a qualidade dos Magnets (720p, 1080p, 4K)
- Mostra opções de Dual Áudio ou legendados
- Suporte 100% nativo a **Temporadas e Episódios de Séries** (inclusive "Packs" de temporada completa)
- Detecta labels exclusivas de qualidade CAM de cinema.

## 📦 Como rodar sem o uso do Notebook (Hospedagem na Nuvem Grátis)

Você pode hospedar este Addon de graça por 24 horas por dia na nuvem do **Render**, para que não precise deixar o seu computador ligado. 

1. Tenha certeza de que este código está salvo num repositório pessoal seu no [GitHub](https://github.com/);
2. Crie uma conta gratuita em [Render.com](https://render.com);
3. No painel do Render, clique em **"New"** -> **"Web Service"**;
4. Conecte sua conta do GitHub e selecione o repositório `YTS---Brasil`;
5. O Render detectará automaticamente as configurações (usando o arquivo `render.yaml`) e iniciará a instalação;
6. Aguarde 2 minutinhos até ficar com a bolinha verde demonstrando "Live";
7. Copie o URL da sua aplicação gerada pelo Render (exemplo: `https://ytsbr-stremio-addon.onrender.com`);
8. No seu Stremio, vá em Adicionar Addons, jogue a URL copiando com `/manifest.json` no final (`https://ytsbr-stremio-addon.onrender.com/manifest.json`) e clique em Instalar. 

Pronto! Seu Addon agora está rodando de forma remota na nuvem e disponível na sua TV, celular e aplicativo sem utilizar a força computacional local do seu notebook.

## 💻 Para desenvolvedores locais

Caso queira fazer alterações e rodar localmente no seu computador:
```bash
# Baixar pacotes exigidos (Express, axios, cheerio, sdk do stremio)
npm install

# Iniciar servidor local
npm start
# ou 
node index.js
```
Acessível na porta HTTP local `http://127.0.0.1:7000/manifest.json`.

---
*Este é um projeto não-oficial construído interativamente, desfrute do ecossistema do Stremio.*
