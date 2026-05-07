import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { generateLawReport } from './law-report-pipeline';
import { SearchRequest } from './types';

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const resp = await sm.send(new GetSecretValueCommand({
    SecretId: process.env.DB_SECRET_ARN!,
  }));

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

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body: SearchRequest;
  try {
    body = JSON.parse(event.body ?? '{}') as SearchRequest;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.query) {
    return json(400, { error: '"query" is required' });
  }

  try {
    const db = await getPool();
    const result = await generateLawReport(body.query, db);
    return json(200, result);
  } catch (err) {
    console.error('generateLawReport error:', err);
    return json(500, { error: 'Internal server error' });
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
