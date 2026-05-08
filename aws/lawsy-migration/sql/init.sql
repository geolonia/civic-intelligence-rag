CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS laws_embeddings (
  law_id TEXT NOT NULL,
  embedding vector(1024),
  PRIMARY KEY (law_id)
);

CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  law_id TEXT NOT NULL,
  law_title TEXT NOT NULL,
  unique_anchor TEXT NOT NULL UNIQUE,
  article_no TEXT,
  content TEXT,
  article_summary TEXT,
  embedding vector(1024)
);

CREATE INDEX ON articles USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON laws_embeddings USING hnsw (embedding vector_cosine_ops);
