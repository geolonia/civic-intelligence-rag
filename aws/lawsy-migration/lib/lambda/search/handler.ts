import { createHash, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Pool } from 'pg';
import { generateLawReportStream } from './law-report-pipeline';
import type { SearchRequest } from './types';

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

function verifyApiKey(headerKey: string | undefined): boolean {
  const hashHex = process.env.LAWSY_API_KEY_HASH;
  if (!hashHex || !headerKey) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = createHash('sha256').update(headerKey).digest();

  // Use timingSafeEqual to prevent timing attacks (=== comparison is forbidden)
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream: awslambda.HttpResponseStream, _context: Context) => {
    const method = event.requestContext.http.method;

    if (method === 'OPTIONS') {
      const optStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 204,
        headers: corsHeaders(),
      });
      optStream.end();
      return;
    }

    if (method !== 'POST') {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Method not allowed' }));
      errStream.end();
      return;
    }

    const headerKey = event.headers?.['x-api-key'];
    if (!verifyApiKey(headerKey)) {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Unauthorized' }));
      errStream.end();
      return;
    }

    let body: SearchRequest;
    try {
      body = JSON.parse(event.body ?? '{}') as SearchRequest;
    } catch {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Invalid JSON' }));
      errStream.end();
      return;
    }

    if (typeof body.query !== 'string' || body.query.trim().length === 0) {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: '"query" must be a non-empty string' }));
      errStream.end();
      return;
    }

    let textStream: awslambda.HttpResponseStream | null = null;
    try {
      const db = await getPool();
      textStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders(),
        },
      });
      await generateLawReportStream(body.query, db, textStream);
    } catch (err) {
      console.error('generateLawReportStream error:', err);
      if (textStream) {
        textStream.write('\n\n[ERROR] レポート生成中にエラーが発生しました。');
      } else {
        const errStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
        errStream.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }
    } finally {
      textStream?.end();
    }
  },
);

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}
