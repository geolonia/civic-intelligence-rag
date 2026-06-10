import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Pool } from 'pg';
import { buildRequestAcceptedResponse, buildStatusResponse } from './async-routes';
import { extractQuestion, isIpAllowed } from './handler-utils';
import { DynamoDBJobStore } from './job-store';
import { generateLawReport, generateLawReportStream } from './law-report-pipeline';
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
    // Lambda Function URL: rawPath preserves trailing slash; requestContext.http.path strips it.
    // Use rawPath so "/requests/" matches correctly.
    const rawPath = (event as unknown as { rawPath?: string }).rawPath;
    const path = rawPath ?? event.requestContext?.http?.path ?? '/';

    if (method === 'OPTIONS') {
      const optStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 204,
        headers: corsHeaders(),
      });
      optStream.end();
      return;
    }

    // IP allow-list check (PoC: Lambda Function URL sourceIp)
    const sourceIp = event.requestContext?.http?.sourceIp;
    if (!isIpAllowed(sourceIp, process.env.ALLOWED_IPS ?? '')) {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Forbidden' }));
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

    // ── Async ExApp routes ─────────────────────────────────────────────────
    if (path === '/requests/' && method === 'POST') {
      await handleAsyncRequest(event, responseStream);
      return;
    }

    if (path.startsWith('/status/') && method === 'GET') {
      const jobId = path.replace(/^\/status\//, '');
      await handleStatusCheck(jobId, responseStream);
      return;
    }

    // ── Existing sync / streaming routes (POST / only) ────────────────────
    if (method !== 'POST') {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Method not allowed' }));
      errStream.end();
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    } catch {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Invalid JSON' }));
      errStream.end();
      return;
    }

    // Dual API schema: accept {inputs.question} (genai-web) or {query} (existing)
    const question = extractQuestion(parsedBody);
    if (!question) {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(
        JSON.stringify({ error: '"query" or "inputs.question" must be a non-empty string' }),
      );
      errStream.end();
      return;
    }

    const body: SearchRequest = {
      query: question,
      max_results: parsedBody.max_results as number | undefined,
    };

    // mode=sync: return buffered JSON { outputs: '<markdown>' }
    const syncMode = event.queryStringParameters?.['mode'] === 'sync';

    if (syncMode) {
      try {
        const db = await getPool();
        const result = await generateLawReport(body.query, db);
        const syncStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
        syncStream.write(JSON.stringify({ outputs: result.report }));
        syncStream.end();
      } catch (err) {
        console.error('generateLawReport error (sync mode):', err);
        const errStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
        errStream.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
      return;
    }

    // Default: streaming mode (existing behavior)
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

async function handleAsyncRequest(
  event: APIGatewayProxyEventV2,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  } catch {
    const errStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    errStream.write(JSON.stringify({ error: 'Invalid JSON' }));
    errStream.end();
    return;
  }

  const question = extractQuestion(parsedBody);
  if (!question) {
    const errStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    errStream.write(
      JSON.stringify({ error: '"query" or "inputs.question" must be a non-empty string' }),
    );
    errStream.end();
    return;
  }

  try {
    const jobStore = new DynamoDBJobStore();
    const jobId = await jobStore.createJob({ question });

    const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.WORKER_LAMBDA_ARN!,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ jobId, question })),
      }),
    );

    const resp = buildRequestAcceptedResponse(jobId);
    const okStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    okStream.write(JSON.stringify(resp));
    okStream.end();
  } catch (err) {
    console.error('handleAsyncRequest error:', err);
    const errStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    errStream.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

async function handleStatusCheck(
  jobId: string,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  if (!jobId) {
    const errStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    errStream.write(JSON.stringify({ error: 'jobId required' }));
    errStream.end();
    return;
  }

  try {
    const jobStore = new DynamoDBJobStore();
    const job = await jobStore.getJob(jobId);

    if (!job) {
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
      errStream.write(JSON.stringify({ error: 'Job not found' }));
      errStream.end();
      return;
    }

    const statusResp = buildStatusResponse(job);
    const okStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    okStream.write(JSON.stringify(statusResp));
    okStream.end();
  } catch (err) {
    console.error('handleStatusCheck error:', err);
    const errStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    errStream.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}
