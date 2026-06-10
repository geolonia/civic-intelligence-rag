import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { DynamoDBJobStore, type IJobStore } from '../search/job-store.js';
import { generateLawReport } from '../search/law-report-pipeline.js';

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const resp = await sm.send(
    new GetSecretValueCommand({
      SecretId: process.env.DB_SECRET_ARN!,
    }),
  );

  const secret = JSON.parse(resp.SecretString!) as {
    username: string;
    password: string;
    host: string;
    port: number;
    dbname: string;
  };

  pool = new Pool({
    host: secret.host,
    port: secret.port,
    database: process.env.DB_NAME || secret.dbname || 'lawsy',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export interface WorkerEvent {
  jobId: string;
  question: string;
}

function isJobStore(x: unknown): x is IJobStore {
  return x != null && typeof (x as IJobStore).updateProgress === 'function';
}

export async function handler(event: WorkerEvent, maybeJobStore?: unknown): Promise<void> {
  const store = isJobStore(maybeJobStore) ? maybeJobStore : new DynamoDBJobStore();
  const { jobId, question } = event;

  try {
    await store.updateProgress(jobId, '法令データを検索中...');

    const db = await getPool();

    await store.updateProgress(jobId, '法令文書を解析中...');

    const result = await generateLawReport(question, db);

    await store.updateProgress(jobId, '回答を整形中...');

    await store.completeJob(jobId, result.report);
  } catch (err) {
    console.error('worker handler error:', err);
    const message = err instanceof Error ? err.message : '不明なエラー';
    const details = err instanceof Error ? err.stack : undefined;
    await store.failJob(jobId, { message, details });
  }
}
