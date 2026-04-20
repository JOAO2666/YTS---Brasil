-- YTSBR Pro — Schema inicial do cache de torrents.
--
-- Execute este SQL no Supabase em: Project → SQL Editor → New Query
--
-- A tabela é particionada lógica por (imdb_id, season, episode) — a
-- combinação forma a chave de busca primária feita pelo addon.

CREATE TABLE IF NOT EXISTS torrents (
  imdb_id      TEXT        NOT NULL,
  season       INTEGER     NOT NULL DEFAULT 0,
  episode      INTEGER     NOT NULL DEFAULT 0,
  info_hash    TEXT,
  url          TEXT,
  provider     TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  description  TEXT,
  quality      TEXT,
  seeders      INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- info_hash é a chave natural para dedup por torrent. Para entradas
  -- baseadas em URL (sem magnet), usamos a URL como parte da chave.
  CONSTRAINT torrents_unique UNIQUE (imdb_id, season, episode, info_hash)
);

-- Índice principal de lookup (usado em CADA request do Stremio).
CREATE INDEX IF NOT EXISTS idx_torrents_lookup
  ON torrents (imdb_id, season, episode);

-- Índice para limpeza de entradas antigas.
CREATE INDEX IF NOT EXISTS idx_torrents_created
  ON torrents (created_at);

-- Housekeeping: remove entradas com mais de 14 dias a cada execução do
-- indexer. Mantém o banco dentro dos 500 MB do tier gratuito do Supabase.
--
-- Pode ser chamado manualmente ou via scheduled function:
--   SELECT cleanup_old_torrents();
CREATE OR REPLACE FUNCTION cleanup_old_torrents()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM torrents WHERE created_at < NOW() - INTERVAL '14 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Permissões: o service_role key do Supabase bypassa RLS, então não
-- precisamos definir políticas. Se algum dia ativar RLS, adicionar:
--
--   ALTER TABLE torrents ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "service_write" ON torrents FOR ALL USING (true);
