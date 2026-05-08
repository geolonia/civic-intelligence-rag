import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

interface GcpServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

interface VertexGroundingCandidate {
  content?: {
    parts?: Array<{ text?: string }>;
  };
  groundingMetadata?: {
    webSearchQueries?: string[];
    groundingChunks?: Array<{
      web?: { uri?: string; title?: string };
    }>;
  };
}

let cachedGcpKey: GcpServiceAccountKey | null = null;
let cachedAccessToken: string | null = null;
let tokenExpiry = 0;

async function loadGcpKey(): Promise<GcpServiceAccountKey> {
  if (cachedGcpKey) return cachedGcpKey;
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
  const secretArn = process.env.GCP_VERTEX_SECRET_ARN ?? 'geolonia/civic-intelligence/gcp-vertex-key';
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!resp.SecretString) throw new Error('GCP Vertex key secret is empty');
  cachedGcpKey = JSON.parse(resp.SecretString) as GcpServiceAccountKey;
  return cachedGcpKey;
}

async function getAccessToken(key: GcpServiceAccountKey): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiry - 60_000) return cachedAccessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const { createSign } = await import('node:crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!tokenResp.ok) {
    throw new Error(`GCP token fetch failed: ${tokenResp.status} ${await tokenResp.text()}`);
  }
  const tokenData = (await tokenResp.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = tokenData.access_token;
  tokenExpiry = Date.now() + tokenData.expires_in * 1000;
  return cachedAccessToken;
}

/**
 * GCP Vertex AI Web Grounding で法令名を推定する (Q2=e)。
 * Lambda から Secrets Manager の gcp-vertex-key を取得し aiplatform.googleapis.com を呼び出す。
 */
export async function estimateLawNamesWithVertexAI(query: string): Promise<string[]> {
  const key = await loadGcpKey();
  const accessToken = await getAccessToken(key);
  const projectId = key.project_id;
  const location = 'us-central1';
  const model = 'gemini-2.0-flash-001';

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `以下のクエリに関連する日本の法令名を調査して、JSON形式で回答してください。JSONのみ出力してください。\n\nクエリ: ${query}`;
  const systemInstruction = `本日の日付は ${today} です。クエリに関連する日本の法令を調査し、法令名を{"law_names":["法令名1","法令名2"]}のJSON形式のみで返してください。廃止・失効した法令は除外してください。`;

  const reqBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
    },
  };

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok) {
    throw new Error(`Vertex AI grounding failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { candidates?: VertexGroundingCandidate[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    const stripped = text.replace(/^```(?:json)?\s*\n?|```\s*$/g, '').trim();
    const parsed = JSON.parse(stripped) as { law_names?: string[] };
    return parsed.law_names ?? [];
  } catch {
    const matches = text.match(/[一-龥ァ-ヴー]+(?:法律|法|規則|政令|条例|省令)/g) ?? [];
    return [...new Set(matches)].filter((m) => m.length >= 4).slice(0, 5);
  }
}
