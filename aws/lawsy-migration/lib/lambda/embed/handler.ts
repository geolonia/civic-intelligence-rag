/**
 * Bedrock Titan v2 embedding Lambda:
 * 未 embedding の articles を Bedrock Titan Embeddings v2 で embedding して Aurora に保存する。
 * normalize Lambda 完了後に invoke、または Step Functions で連鎖実行。
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Pool } from 'pg';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'ap-northeast-1' });
let pool: Pool | null = null;

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

interface EmbedEvent {
  lawId?: string;
  batchSize?: number;
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN! }));
  const secret = JSON.parse(resp.SecretString!) as DbSecret;
  pool = new Pool({
    host: secret.host,
    port: secret.port,
    database: process.env.DB_NAME || 'lawsy',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}

async function embedText(text: string): Promise<number[]> {
  const body = JSON.stringify({ inputText: text.slice(0, 8_192), dimensions: 1024, normalize: true });
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0',
    body: Buffer.from(body),
    contentType: 'application/json',
    accept: 'application/json',
  }));
  const parsed = JSON.parse(Buffer.from(resp.body).toString()) as { embedding: number[] };
  return parsed.embedding;
}

export async function handler(event: EmbedEvent): Promise<{ processed: number }> {
  const db = await getPool();
  const batchSize = event.batchSize ?? 50;
  const whereClause = event.lawId
    ? `WHERE a.embedding IS NULL AND a.law_id = $2 LIMIT $1`
    : `WHERE a.embedding IS NULL LIMIT $1`;
  const params = event.lawId ? [batchSize, event.lawId] : [batchSize];

  const articles = await db.query<{ id: number; content: string; article_summary: string | null }>(
    `SELECT id, content, article_summary FROM articles ${whereClause}`,
    params,
  );

  console.log(`Embedding ${articles.rows.length} articles...`);
  let processed = 0;

  for (const row of articles.rows) {
    const text = row.content || row.article_summary || '';
    if (!text.trim()) continue;

    try {
      const embedding = await embedText(text);
      const vectorLiteral = `[${embedding.join(',')}]`;
      await db.query(
        `UPDATE articles SET embedding = $1::vector, embedded_at = NOW() WHERE id = $2`,
        [vectorLiteral, row.id],
      );
      processed++;
    } catch (err) {
      console.error(`Failed to embed article ${row.id}:`, err);
    }
  }

  // Also update laws_embeddings table for law-level vector search
  if (event.lawId) {
    try {
      const lawResp = await db.query<{ law_title: string }>(
        `SELECT law_title FROM laws WHERE law_id = $1`,
        [event.lawId],
      );
      if (lawResp.rows.length > 0) {
        const embedding = await embedText(lawResp.rows[0].law_title);
        const vectorLiteral = `[${embedding.join(',')}]`;
        await db.query(
          `INSERT INTO laws_embeddings (law_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT DO NOTHING`,
          [event.lawId, vectorLiteral],
        );
      }
    } catch (err) {
      console.error('Failed to update laws_embeddings:', err);
    }
  }

  console.log(`Embedded ${processed} articles.`);
  return { processed };
}
