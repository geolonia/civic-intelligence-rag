export interface SearchRequest {
  query: string;
  max_results?: number;
}

export interface SearchResponse {
  report: string;
  articles: ArticleResult[];
  usage: UsageSummary;
}

export interface ArticleResult {
  law_id: string;
  law_title: string;
  article_no: string;
  content: string;
  url: string;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface DbArticle {
  law_id: string;
  law_title: string;
  unique_anchor: string;
  article_no: string | null;
  content: string | null;
  article_summary: string | null;
  url: string;
  similarity: number;
}
