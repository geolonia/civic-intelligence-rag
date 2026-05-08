/**
 * e-Gov fetch Lambda: 法令 XML を e-Gov API から取得して S3 source layer に保存する。
 * CloudWatch Events 毎週日曜 00:00 UTC にスケジュール実行。
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const SOURCE_BUCKET = process.env.SOURCE_BUCKET!;

// e-Gov 法令 API v1
const EGOV_BASE = 'https://laws.e-gov.go.jp/api/1';

interface EgovLawEntry {
  LawId: string;
  LawName: string;
  LawNo: string;
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

async function fetchLawList(categoryId: string): Promise<EgovLawEntry[]> {
  const url = `${EGOV_BASE}/lawdata/category/${categoryId}`;
  const resp = await fetchWithRetry(url);
  const xml = await resp.text();

  // Parse law list from XML (simplified extraction)
  const entries: EgovLawEntry[] = [];
  const matches = xml.matchAll(
    /<LawId>([^<]+)<\/LawId>[\s\S]*?<LawName>([^<]+)<\/LawName>[\s\S]*?<LawNo>([^<]+)<\/LawNo>/g,
  );
  for (const m of matches) {
    entries.push({ LawId: m[1], LawName: m[2], LawNo: m[3] });
  }
  return entries;
}

async function fetchAndStoreLawXml(lawId: string): Promise<void> {
  const url = `${EGOV_BASE}/lawdata/${lawId}`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url);
  } catch (err) {
    console.warn(`Skipping ${lawId}: ${err}`);
    return;
  }
  const xml = await resp.text();
  if (!xml.includes('<Law')) {
    console.warn(`No Law element in response for ${lawId}, skipping.`);
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
  console.log('Starting e-Gov law fetch...');

  // 基本法令カテゴリ (法律) を取得
  // e-Gov category: 1=憲法, 2=法律, 3=政令, 4=省令
  const CATEGORIES = ['2', '3', '4'];
  const allLaws: EgovLawEntry[] = [];

  for (const cat of CATEGORIES) {
    try {
      const laws = await fetchLawList(cat);
      console.log(`Category ${cat}: ${laws.length} laws`);
      allLaws.push(...laws);
    } catch (err) {
      console.error(`Failed to fetch category ${cat}:`, err);
    }
  }

  console.log(`Total laws to fetch: ${allLaws.length}`);

  // Lambda タイムアウト (15 min) を考慮して最大 100 件/回
  const batchSize = 100;
  const batch = allLaws.slice(0, batchSize);

  let success = 0;
  for (const law of batch) {
    try {
      await fetchAndStoreLawXml(law.LawId);
      success++;
    } catch (err) {
      console.error(`Failed to store ${law.LawId}:`, err);
    }
  }

  console.log(`Fetch complete: ${success}/${batch.length} stored to S3.`);
}
