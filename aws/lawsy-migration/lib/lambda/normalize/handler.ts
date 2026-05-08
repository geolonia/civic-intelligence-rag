/**
 * XML normalize Lambda: S3 に保存された e-Gov XML を解析して Aurora に挿入する。
 * S3 ObjectCreated イベントによりトリガー。
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';
import type { Pool } from 'pg';
import { getDbPool } from '../db-client';

const s3 = new S3Client({ region: process.env.AWS_REGION });
let schemaInitialized = false;

async function getPool(): Promise<Pool> {
  const pool = await getDbPool();
  if (!schemaInitialized) {
    await initSchema(pool);
    schemaInitialized = true;
  }
  return pool;
}

async function initSchema(db: Pool): Promise<void> {
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS laws (
      law_id       VARCHAR(64) PRIMARY KEY,
      law_no       VARCHAR(64),
      law_title    TEXT NOT NULL,
      valid_from   DATE,
      valid_to     DATE,
      xml_content  TEXT,
      fetched_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id            BIGSERIAL PRIMARY KEY,
      law_id        VARCHAR(64) NOT NULL REFERENCES laws(law_id) ON DELETE CASCADE,
      law_title     TEXT NOT NULL,
      article_no    VARCHAR(32),
      unique_anchor VARCHAR(128) NOT NULL UNIQUE,
      content       TEXT,
      article_summary TEXT,
      embedding     vector(1024),
      embedded_at   TIMESTAMPTZ,
      CONSTRAINT articles_law_id_anchor_uq UNIQUE (law_id, unique_anchor)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS laws_embeddings (
      law_id    VARCHAR(64)  NOT NULL REFERENCES laws(law_id) ON DELETE CASCADE,
      embedding vector(1024) NOT NULL,
      PRIMARY KEY (law_id)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS articles_embedding_idx
    ON articles USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);
}

interface LawArticle {
  articleNo: string;
  uniqueAnchor: string;
  content: string;
}

function extractArticles(xml: string, _lawId: string): LawArticle[] {
  const articles: LawArticle[] = [];
  const articlePattern = /<Article[^>]*>([\s\S]*?)<\/Article>/g;
  const articleNumPattern = /<ArticleNum>([^<]*)<\/ArticleNum>/;
  const captionPattern = /<ArticleCaption>([^<]*)<\/ArticleCaption>/;
  const paragraphPattern = /<Sentence>([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]*>)*[^<]*)<\/Sentence>/g;

  let articleIndex = 1;

  for (;;) {
    const match = articlePattern.exec(xml);
    if (!match) break;
    const articleXml = match[1];
    const numMatch = articleNumPattern.exec(articleXml);
    const rawNum = numMatch ? numMatch[1].trim() : '';
    const articleNo = rawNum || `条${articleIndex}`;
    const uniqueAnchor = `Main_Article_${articleIndex}`;

    // Collect paragraph texts
    const paragraphs: string[] = [];
    const pPattern = new RegExp(paragraphPattern.source, 'g');
    for (;;) {
      const pMatch = pPattern.exec(articleXml);
      if (!pMatch) break;
      const text = pMatch[1].replace(/<[^>]+>/g, '').trim();
      if (text) paragraphs.push(text);
    }

    const captionMatch = captionPattern.exec(articleXml);
    const caption = captionMatch ? captionMatch[1].trim() : '';
    const content = [articleNo, caption, ...paragraphs].filter(Boolean).join('\n');

    if (content.trim()) {
      articles.push({ articleNo, uniqueAnchor, content });
    }
    articleIndex++;
  }

  return articles;
}

function extractLawTitle(xml: string): string {
  const m = xml.match(/<LawTitle[^>]*>([^<]+)<\/LawTitle>/);
  return m ? m[1].trim() : '不明';
}

function extractLawNo(xml: string): string {
  const m = xml.match(/<LawNum[^>]*>([^<]+)<\/LawNum>/);
  return m ? m[1].trim() : '';
}

export async function handler(event: S3Event): Promise<void> {
  const db = await getPool();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (!key.startsWith('raw-xml/') || !key.endsWith('.xml')) continue;

    const lawId = key.split('/')[1];
    console.log(`Processing ${lawId} from s3://${bucket}/${key}`);

    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const xml = await s3Resp.Body!.transformToString('utf-8');

    const lawTitle = extractLawTitle(xml);
    const lawNo = extractLawNo(xml);
    const articles = extractArticles(xml, lawId);

    // Upsert law record
    await db.query(
      `INSERT INTO laws (law_id, law_no, law_title, xml_content, fetched_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (law_id) DO UPDATE
         SET law_no = EXCLUDED.law_no,
             law_title = EXCLUDED.law_title,
             xml_content = EXCLUDED.xml_content,
             fetched_at = EXCLUDED.fetched_at`,
      [lawId, lawNo, lawTitle, xml.slice(0, 5_000_000)],
    );

    // Upsert articles (without embedding — embed Lambda handles that)
    for (const article of articles) {
      await db.query(
        `INSERT INTO articles (law_id, law_title, article_no, unique_anchor, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (law_id, unique_anchor) DO UPDATE
           SET content = EXCLUDED.content,
               article_no = EXCLUDED.article_no`,
        [lawId, lawTitle, article.articleNo, article.uniqueAnchor, article.content],
      );
    }

    console.log(`Stored ${articles.length} articles for law ${lawId} (${lawTitle})`);
  }
}
