/**
 * e-Gov fetch Lambda: 法令 XML を e-Gov API v2 から取得して S3 source layer に保存する。
 * CloudWatch Events 毎週日曜 00:00 UTC にスケジュール実行。
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const SOURCE_BUCKET = process.env.SOURCE_BUCKET!;

// e-Gov 法令 API v2
const EGOV_BASE = 'https://laws.e-gov.go.jp/api/2';

// PoC 用の取得件数上限 (全件対応は後続フェーズで実施)
const FETCH_LIMIT = 100;

interface EgovV2LawEntry {
  law_info: {
    law_id: string;
    law_num: string;
  };
  revision_info: {
    law_title: string;
  };
}

interface EgovV2LawsResponse {
  total_count: number;
  count: number;
  next_offset: number;
  laws: EgovV2LawEntry[];
}

interface EgovV2LawDataResponse {
  law_info?: { law_id: string };
  revision_info?: { law_title: string };
  law_full_text?: string; // base64-encoded XML
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status} for ${url}`);
    } catch (err) {
      lastErr = err;
      const delay = 1000 * 2 ** i;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchLawList(): Promise<EgovV2LawEntry[]> {
  // v2: JSON レスポンス形式
  const url = `${EGOV_BASE}/laws?law_type=Act&offset=0&limit=${FETCH_LIMIT}`;
  const resp = await fetchWithRetry(url);
  const data = (await resp.json()) as EgovV2LawsResponse;
  return data.laws ?? [];
}

async function fetchAndStoreLawXml(lawId: string): Promise<void> {
  // v2: JSON レスポンス + law_full_text が base64 エンコードされた XML
  const url = `${EGOV_BASE}/law_data/${lawId}?law_full_text_format=xml`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url);
  } catch (err) {
    console.warn(`Skipping ${lawId}: ${err}`);
    return;
  }

  const data = (await resp.json()) as EgovV2LawDataResponse;
  if (!data.law_full_text) {
    console.warn(`No law_full_text in response for ${lawId}, skipping.`);
    return;
  }

  // base64 デコードして実際の XML を取得
  const xml = Buffer.from(data.law_full_text, 'base64').toString('utf-8');
  if (!xml.includes('<Law')) {
    console.warn(`No Law element in decoded XML for ${lawId}, skipping.`);
    return;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: `raw-xml/${lawId}/latest.xml`,
      Body: xml,
      ContentType: 'application/xml',
      Metadata: {
        'law-id': lawId,
        'fetched-at': new Date().toISOString(),
      },
    }),
  );
}

export async function handler(): Promise<void> {
  console.log('Starting e-Gov law fetch (API v2)...');

  let laws: EgovV2LawEntry[] = [];
  try {
    laws = await fetchLawList();
    console.log(`Fetched ${laws.length} laws from e-Gov API v2`);
  } catch (err) {
    console.error('Failed to fetch law list:', err);
    return;
  }

  console.log(`Total laws to fetch: ${laws.length}`);

  let success = 0;
  for (const entry of laws) {
    const lawId = entry.law_info.law_id;
    try {
      await fetchAndStoreLawXml(lawId);
      success++;
    } catch (err) {
      console.error(`Failed to store ${lawId}:`, err);
    }
  }

  console.log(`Fetch complete: ${success}/${laws.length} stored to S3.`);
}
