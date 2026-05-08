import type { DbArticle } from './types';

export function formatReferenceForPrompt(index: number, article: DbArticle): string {
  const content = article.content || article.article_summary || '';
  return `[${index + 1}] 【e-laws公式条文】 ${article.law_title} ${article.article_no ?? ''}\n${content}`;
}

export function formatReferenceForOutput(index: number, article: DbArticle): string {
  const title = `${article.law_title} ${article.article_no ?? ''}`.trim();
  const snippet = (article.content || article.article_summary || '').slice(0, 200);
  const contentLine = snippet ? `\n　　> ${snippet.replace(/\n/g, ' ')}...` : '';
  return `[${index + 1}] 🔗 **[${title}](${article.url})**${contentLine}`;
}

export function filterCitedReferences(reportText: string, articles: DbArticle[]): Array<[number, DbArticle]> {
  const rawNums = [...reportText.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)];
  const citedIndices = new Set<number>();
  for (const m of rawNums) {
    for (const n of m[1].split(',')) {
      citedIndices.add(parseInt(n.trim(), 10));
    }
  }
  const sorted = [...citedIndices].sort((a, b) => a - b);
  return sorted.filter((i) => i >= 1 && i <= articles.length).map((i) => [i, articles[i - 1]]);
}

export function sanitizeMermaid(text: string): string {
  return text.replace(/```mermaid\n([\s\S]*?)\n```/g, (_match, content: string) => {
    const sanitized = content
      .replace(
        /\(([^)]+)\)/g,
        (_m: string, inner: string) => `(${inner.replace(/[<>]/g, (c: string) => (c === '<' ? '＜' : '＞'))})`,
      )
      .replace(
        /\[([^\]]+)\]/g,
        (_m: string, inner: string) => `[${inner.replace(/[<>]/g, (c: string) => (c === '<' ? '＜' : '＞'))}]`,
      );
    return `\`\`\`mermaid\n${sanitized}\n\`\`\``;
  });
}

export function convertCitationsToLinks(text: string, references: Array<[number, DbArticle]>): string {
  const refMap = new Map<number, DbArticle>(references);
  return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (match, inner: string) => {
    const nums = inner.split(',').map((s: string) => parseInt(s.trim(), 10));
    if (nums.length === 1) {
      const ref = refMap.get(nums[0]);
      if (!ref) return match;
      return `[[${nums[0]}]](${ref.url})`;
    }
    return nums
      .map((n: number) => {
        const ref = refMap.get(n);
        return ref ? `[[${n}]](${ref.url})` : `[${n}]`;
      })
      .join(' ');
  });
}

export function biggramSimilarity(s1: string, s2: string): number {
  const particles = /[をにはがのもとでやへからまで等]/g;
  const n1 = s1.replace(particles, '');
  const n2 = s2.replace(particles, '');
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const b1 = bigrams(n1);
  const b2 = bigrams(n2);
  if (!b1.size || !b2.size) return 0;
  let intersection = 0;
  for (const bg of b1) if (b2.has(bg)) intersection++;
  return intersection / (b1.size + b2.size - intersection);
}

export function expandLawNames(names: string[]): string[] {
  const expanded = [...names];
  for (const name of names) {
    if (name.endsWith('法律') || name.endsWith('法')) {
      expanded.push(`${name}施行令`, `${name}施行規則`);
    }
  }
  return [...new Set(expanded)];
}
