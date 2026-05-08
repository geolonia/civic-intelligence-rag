-- lawsy AWS migration schema initialization
-- Run once after Aurora cluster is ready via RDS Query Editor or psql

CREATE EXTENSION IF NOT EXISTS vector;

-- Source layer: raw law metadata
CREATE TABLE IF NOT EXISTS laws (
    law_id       VARCHAR(64)  PRIMARY KEY,
    law_no       VARCHAR(64),
    law_title    TEXT         NOT NULL,
    valid_from   DATE,
    valid_to     DATE,
    xml_content  TEXT,
    fetched_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS laws_law_no_idx ON laws (law_no);

-- DWH layer: articles with summaries
CREATE TABLE IF NOT EXISTS articles (
    id               BIGSERIAL     PRIMARY KEY,
    law_id           VARCHAR(64)   NOT NULL REFERENCES laws(law_id) ON DELETE CASCADE,
    law_title        TEXT          NOT NULL,
    article_no       VARCHAR(32),
    unique_anchor    VARCHAR(128)  NOT NULL,
    content          TEXT,
    article_summary  TEXT,
    embedding        vector(1024),
    embedded_at      TIMESTAMPTZ,
    CONSTRAINT articles_law_id_anchor_uq UNIQUE (law_id, unique_anchor)
);

-- HNSW index for cosine similarity search (pgvector)
CREATE INDEX IF NOT EXISTS articles_embedding_idx
    ON articles USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Law-level embeddings for fast law lookup
CREATE TABLE IF NOT EXISTS laws_embeddings (
    law_id    VARCHAR(64)  NOT NULL REFERENCES laws(law_id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL,
    PRIMARY KEY (law_id)
);

CREATE INDEX IF NOT EXISTS laws_embedding_hnsw_idx
    ON laws_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
