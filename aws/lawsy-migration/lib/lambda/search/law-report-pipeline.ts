import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { type Writable } from 'node:stream';
import type { Pool } from 'pg';
import {
  PROMPT_GENERATE_COMPLETE_REPORT,
  PROMPT_SELECT_RELEVANT_ARTICLES,
  SYSTEM_LAW_NAME_ESTIMATION,
} from './prompts';
import {
  biggramSimilarity,
  convertCitationsToLinks,
  expandLawNames,
  filterCitedReferences,
  formatReferenceForOutput,
  formatReferenceForPrompt,
  sanitizeMermaid,
} from './report-utils';
import type { DbArticle, SearchResponse, UsageSummary } from './types';
import { estimateLawNamesWithVertexAI } from './vertex-grounding';

const client = new AnthropicBedrock({ awsRegion: process.env.BEDROCK_REGION || 'ap-northeast-1' });

const MODEL_ID = 'jp.anthropic.claude-sonnet-4-6';
const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

// ── Bedrock Titan v2 Embedding ────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'ap-northeast-1' });
  const body = JSON.stringify({ inputText: text, dimensions: 1024, normalize: true });
  const resp = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL,
      body: Buffer.from(body),
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  const parsed = JSON.parse(Buffer.from(resp.body).toString()) as { embedding: number[] };
  return parsed.embedding;
}

// ── Law name estimation (Vertex AI primary, Claude fallback) — pgvector is used in search stage ──

async function estimateLawNames(query: string): Promise<string[]> {
  // Stage 1: GCP Vertex AI Web Grounding (Q2=e)
  try {
    const names = await estimateLawNamesWithVertexAI(query);
    if (names.length > 0) return names;
  } catch (err) {
    console.warn('Vertex AI grounding failed, falling back to Claude:', err);
  }

  // Stage 2 & 3 fallback: Claude with no web search
  const today = new Date().toISOString().slice(0, 10);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 512,
    system: SYSTEM_LAW_NAME_ESTIMATION(today),
    messages: [{ role: 'user', content: `クエリ: ${query}` }],
  });
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  try {
    const stripped = text.replace(/^```(?:json)?\s*\n?|```\s*$/g, '').trim();
    const parsed = JSON.parse(stripped) as { law_names?: string[] };
    return parsed.law_names ?? [];
  } catch {
    const matches = text.match(/[一-龥ァ-ヴー]+(?:法律|法|規則|政令|条例|省令)/g) ?? [];
    return [...new Set(matches)].filter((m) => m.length >= 4).slice(0, 5);
  }
}

// ── pgvector similarity search ───────────────────────────────────────────────

async function searchArticlesByEmbedding(pool: Pool, lawNames: string[], limit = 100): Promise<DbArticle[]> {
  const expandedNames = expandLawNames(lawNames);
  const seenAnchors = new Set<string>();

  // Parallel embed + query for all law names (Promise.all replaces sequential for loop)
  const rowGroups = await Promise.all(
    expandedNames.slice(0, 5).map(async (name) => {
      const embedding = await embedText(name);
      const vectorLiteral = `[${embedding.join(',')}]`;
      const result = await pool.query<DbArticle>(
        `SELECT
           a.law_id,
           a.law_title,
           a.unique_anchor,
           a.article_no,
           a.content,
           a.article_summary,
           'https://laws.e-gov.go.jp/law/' || split_part(a.law_id, '_', 1) as url,
           (a.embedding <=> $1::vector) as similarity
         FROM articles a
         INNER JOIN (
           SELECT law_id, MIN(embedding <=> $1::vector) as best_sim
           FROM laws_embeddings
           GROUP BY law_id
           ORDER BY best_sim ASC
           LIMIT 3
         ) nearest ON a.law_id = nearest.law_id
         WHERE a.embedding IS NOT NULL
         ORDER BY a.embedding <=> $1::vector ASC
         LIMIT $2`,
        [vectorLiteral, limit],
      );
      return result.rows;
    }),
  );

  // Merge results with dedup (seenAnchors is safe here — no concurrent writes)
  const allArticles: DbArticle[] = [];
  for (const rows of rowGroups) {
    for (const row of rows) {
      if (!seenAnchors.has(row.unique_anchor)) {
        seenAnchors.add(row.unique_anchor);
        allArticles.push(row);
      }
    }
  }

  return allArticles;
}

// ── AI article selection ──────────────────────────────────────────────────────

async function selectRelevantArticles(
  query: string,
  articles: DbArticle[],
  usageAccum: UsageSummary,
): Promise<DbArticle[]> {
  if (articles.length <= 5) return articles;

  const summaryList = articles
    .map((a, i) => `${i + 1}. ${a.law_title} - ${a.article_summary ?? '概要なし'}`)
    .join('\n');

  const resp = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 512,
    system: PROMPT_SELECT_RELEVANT_ARTICLES,
    messages: [{ role: 'user', content: `元のクエリ: ${query}\n\n条文概要リスト:\n${summaryList}` }],
  });
  accumUsage(usageAccum, resp.usage);

  const text = resp.content.find((b) => b.type === 'text')?.text ?? '';
  const indices: number[] = [];
  for (const part of text.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (!Number.isNaN(n) && n >= 1 && n <= articles.length) indices.push(n);
  }
  if (!indices.length) return articles.slice(0, 20);

  return [...new Set(indices)].slice(0, 20).map((i) => articles[i - 1]);
}

// ── Report generation (buffered) ─────────────────────────────────────────────

async function generateReport(query: string, referencesText: string, usageAccum: UsageSummary): Promise<string> {
  const resp = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 8192,
    system: PROMPT_GENERATE_COMPLETE_REPORT,
    messages: [
      {
        role: 'user',
        content: `クエリ: ${query}\n\n参考情報:\n${referencesText}`,
      },
    ],
  });
  accumUsage(usageAccum, resp.usage);

  let text = resp.content.find((b) => b.type === 'text')?.text ?? '';
  const firstHeading = text.search(/^#/m);
  if (firstHeading >= 0) text = text.slice(firstHeading);
  return text;
}

// ── Report generation (streaming) ────────────────────────────────────────────

async function generateReportStream(
  query: string,
  referencesText: string,
  responseStream: Writable,
): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL_ID,
    max_tokens: 8192,
    system: PROMPT_GENERATE_COMPLETE_REPORT,
    messages: [{ role: 'user', content: `クエリ: ${query}\n\n参考情報:\n${referencesText}` }],
  });

  const chunks: string[] = [];
  stream.on('text', (textDelta: string) => {
    chunks.push(textDelta);
    responseStream.write(textDelta);
  });

  await stream.finalMessage();
  return chunks.join('');
}

// ── Law name divergence warning ───────────────────────────────────────────────

function buildDivergenceWarning(estimatedNames: string[], articles: DbArticle[]): string {
  if (!estimatedNames.length || !articles.length) return '';
  const actualTitles = [...new Set(articles.map((a) => a.law_title))];
  const diverged: Array<[string, string, number]> = [];
  for (const name of estimatedNames) {
    const best = actualTitles.reduce(
      (acc, t) => {
        const sim = biggramSimilarity(name, t);
        return sim > acc.sim ? { title: t, sim } : acc;
      },
      { title: '', sim: 0 },
    );
    if (best.sim < 0.4) diverged.push([name, best.title, best.sim]);
  }
  if (!diverged.length) return '';
  const lines = ['【警告】推定された法令名とDB取得法令名に大きな乖離があります。', ''];
  for (const [est, actual] of diverged) {
    lines.push(`- 推定法令名「${est}」→ 取得法令「${actual}」`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ── Usage accumulator ────────────────────────────────────────────────────────

function accumUsage(
  acc: UsageSummary,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): void {
  acc.input_tokens += usage.input_tokens;
  acc.output_tokens += usage.output_tokens;
  if (usage.cache_read_input_tokens != null)
    acc.cache_read_tokens = (acc.cache_read_tokens ?? 0) + usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null)
    acc.cache_write_tokens = (acc.cache_write_tokens ?? 0) + usage.cache_creation_input_tokens;
}

// ── Main pipeline (streaming) ─────────────────────────────────────────────────

export async function generateLawReportStream(query: string, pool: Pool, responseStream: Writable): Promise<void> {
  const usage: UsageSummary = { input_tokens: 0, output_tokens: 0 };

  // 1. Estimate law names
  const lawNames = await estimateLawNames(query);
  if (!lawNames.length) {
    responseStream.write('クエリから関連する法令を特定できませんでした。より具体的な法令名を含めてクエリを再構成してください。');
    return;
  }

  // 2. pgvector similarity search (parallelized in searchArticlesByEmbedding)
  const articles = await searchArticlesByEmbedding(pool, lawNames);
  if (!articles.length) {
    responseStream.write('該当する法令条文が見つかりませんでした。');
    return;
  }

  // 3. AI article selection
  const divergenceWarning = buildDivergenceWarning(lawNames, articles);
  const selected = await selectRelevantArticles(query, articles, usage);

  // 4. Build references text
  const refsText = selected.map((a, i) => formatReferenceForPrompt(i, a)).join('\n\n');
  const referencesText = divergenceWarning + refsText;

  // 5. Stream report body — chunks written to responseStream as they arrive from Bedrock
  const rawReport = await generateReportStream(query, referencesText, responseStream);

  // 6. Append references section after streaming completes
  const citedRefs = filterCitedReferences(rawReport, selected);
  const fallbackRefs: Array<[number, DbArticle]> =
    citedRefs.length > 0 ? citedRefs : selected.map((a, i) => [i + 1, a]);

  const refsSection = fallbackRefs.map(([i, a]) => formatReferenceForOutput(i - 1, a)).join('\n\n');
  responseStream.write(`\n\n## 出典\n\n${refsSection}`);
}

// ── Main pipeline (buffered) ──────────────────────────────────────────────────

export async function generateLawReport(query: string, pool: Pool): Promise<SearchResponse> {
  const usage: UsageSummary = { input_tokens: 0, output_tokens: 0 };

  // 1. Estimate law names
  const lawNames = await estimateLawNames(query);
  if (!lawNames.length) {
    return {
      report: 'クエリから関連する法令を特定できませんでした。より具体的な法令名を含めてクエリを再構成してください。',
      articles: [],
      usage,
    };
  }

  // 2. pgvector similarity search
  const articles = await searchArticlesByEmbedding(pool, lawNames);
  if (!articles.length) {
    return {
      report: '該当する法令条文が見つかりませんでした。',
      articles: [],
      usage,
    };
  }

  // 3. AI article selection
  const divergenceWarning = buildDivergenceWarning(lawNames, articles);
  const selected = await selectRelevantArticles(query, articles, usage);

  // 4. Build references text
  const refsText = selected.map((a, i) => formatReferenceForPrompt(i, a)).join('\n\n');
  const referencesText = divergenceWarning + refsText;

  // 5. Generate report
  const rawReport = await generateReport(query, referencesText, usage);

  // 6. Finalize: filter citations, convert to links, sanitize mermaid
  const citedRefs = filterCitedReferences(rawReport, selected);
  const fallbackRefs: Array<[number, DbArticle]> =
    citedRefs.length > 0 ? citedRefs : selected.map((a, i) => [i + 1, a]);

  const reportWithLinks = convertCitationsToLinks(rawReport, fallbackRefs);
  const sanitized = sanitizeMermaid(reportWithLinks);
  const refsSection = fallbackRefs.map(([i, a]) => formatReferenceForOutput(i - 1, a)).join('\n\n');
  const finalReport = `${sanitized}\n\n## 出典\n\n${refsSection}`;

  return {
    report: finalReport,
    articles: selected.map((a) => ({
      law_id: a.law_id,
      law_title: a.law_title,
      article_no: a.article_no ?? '',
      content: (a.content || a.article_summary || '').slice(0, 500),
      url: a.url,
    })),
    usage,
  };
}
