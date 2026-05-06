# Geolonia Civic Intelligence — Roadmap

This document outlines the Geolonia-specific implementation roadmap for the `civic-intelligence-rag` fork of [digital-go-jp/genai-ai-api](https://github.com/digital-go-jp/genai-ai-api).

## Geolonia 独自対応項目

### 1. geonicdb (NGSI-LD) 連携

- GeonicDB (NGSI-LD 準拠の地理空間データストア) との API 連携
- 行政データ・地理情報を RAG のナレッジソースとして活用

### 2. 4 種 DB ハイブリッド検索

以下のデータソースを横断するハイブリッド検索基盤の構築:

- **GeonicDB** — NGSI-LD 地理空間データ
- **PostGIS** — 地理空間 PostgreSQL
- **Milvus** — ベクトルデータベース
- **Bedrock Knowledge Base** — AWS マネージド RAG

### 3. 災害 flow (UC2 高松市コパイロット)

- ユースケース2: 高松市の災害対応コパイロット実装
- リアルタイム災害情報と行政データの統合
- 市民・行政職員向け AI アシスタント機能

## 優先実装順序

| Phase | 内容 | 状態 |
|-------|------|------|
| Phase 1 | AWS base セットアップ (`aws/query-expansion-rag` ベース) | 着手予定 |
| Phase 2 | geonicdb (NGSI-LD) 連携 | 未着手 |
| Phase 3 | 4 種 DB ハイブリッド検索 | 未着手 |
| Phase 4 | 災害 flow (UC2 高松市) | 未着手 |

## GCP / Azure コードについて

本リポジトリには upstream `digital-go-jp/genai-ai-api` 由来の GCP (`google-cloud/`) および Azure (`azure/`) コードが含まれますが、Geolonia CI プロジェクトでは **当面未使用** です。
upstream との同期を維持するため残置しています。将来的に整理する cmd を別途発令予定です。

## 参考リンク

- [upstream: digital-go-jp/genai-ai-api](https://github.com/digital-go-jp/genai-ai-api)
- [GeonicDB](https://github.com/geolonia/geonicdb)
- [genai-web-eval (評価環境)](https://github.com/geolonia/genai-web-eval)
