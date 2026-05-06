---
> **Geolonia Civic Intelligence (CI) Fork**
> Forked from digital-go-jp/genai-ai-api for Geolonia Civic Intelligence (CI).
> AWS query-expansion-rag (aws/) を civic AI app の base として使用。
> GCP (gcp/lawsy-custom-bq) と Azure (azure/genai-azure) は当面未使用、upstream 追従のため残置。
---

日本語 | [English](README.en.md)

# 源内 AI アプリ

## 概要

源内（GenAI）は、デジタル庁が開発・運用する生成 AI 利活用基盤です。行政職員が業務特化の生成 AI アプリケーションを、迅速かつ安全かつ簡単に利用できる環境を提供します。  
源内は大きく分けて2種類のシステムで構成されます。

- [源内 Web](https://github.com/digital-go-jp/genai-web): 利用者が直接さわる Web アプリケーション
- [行政実務用 AI アプリ](https://github.com/digital-go-jp/genai-ai-api): 生成 AI を活用したマイクロサービス

本リポジトリではこのうち、中央省庁で実際に展開されている行政実務用 AI アプリの一部を公開しています。  
源内の取り組み・構想・生成 AI 活用方法の詳細等は、[デジタル庁のTechブログ](https://digital-gov.note.jp/m/m90208c3610d0)で発信中です。

## 公開中の行政実務用 AI アプリ

源内で利用できる行政実務用 AI アプリは、源内 Web との間のプロトコルに準拠すれば、源内 Web と独立した環境で構築ができ、GUI 等の操作で源内への追加登録ができます。  
以下、ガバメントクラウドに採択されたクラウドサービスごとに、どのような行政実務用 AI アプリを本リポジトリで公開しているか、について簡単にまとめたものです。

### Microsoft Azure

- [LLM（大規模言語モデル）をセルフデプロイして利用する開発テンプレート](./azure/genai-azure/)

### Google Cloud

- [最新の法律条文データを参照・回答する法制度に関するAIアプリの再現可能な実装](./google-cloud/lawsy-custom-bq/)

### Amazon Web Services

- [行政実務用ＲＡＧ（検索拡張生成）の開発テンプレート](./aws/query-expansion-rag/)

それぞれの行政実務用 AI アプリの詳細は、フォルダ内の README ファイルをご参照ください。

## Issue / Pull Request の対応方針

本リポジトリでは、サービスの安定運用に影響する致命的な問題に限り、Issue での報告を受け付けています。Pull Request は受け付けておりません。

### Issues

#### 報告対象となるもの

- データの損失・破損 を引き起こす不具合
- サービスが利用不能になる 障害
- 法令・規則への違反 に関わる問題（例：個人情報の意図しない露出）

#### 報告対象外のもの

以下については、Issue での報告はご遠慮ください。  
テンプレートに合致しない Issue はクローズさせていただく場合があります。

- 機能追加の要望・提案
- 軽微な表示崩れ・誤字脱字
- パフォーマンスの改善提案
- コーディングスタイルに関する指摘
- 質問・使い方の相談

### 対応について

- Issue への対応は、内部の優先度判断に基づき行います
- すべての Issue に対応できるとは限りません
- 対応状況についてのお問い合わせへの個別回答は行っておりません
- 致命的と判断された問題については、可能な範囲で対応状況を Issue 上でお知らせします

## 脆弱性の報告

脆弱性の報告は、https://github.com/digital-go-jp/genai-ai-api/security よりご報告ください。

## このソースコード・ドキュメント等の性格

このリポジトリ（ソースコードおよびドキュメント）は、デジタル庁が作成し、公開するものです。  
公的資源として、OSS コミュニティのすべての方にオープンにしております。そのため、以下のことは禁止します。

- 特定の思想・団体・企業を支持または排除するような行為
- 政治的・宗教的・差別的な内容の発言
- 個人情報や機微情報をリポジトリ上で扱う行為
- セキュリティ脆弱性発見時に、デジタル庁に報告・承諾を得ることなく、脆弱性内容を第三者に開示する行為
- 本ソースコードを他システムへの攻撃を目的として改変する行為

## 関連リンク

- [ガバメント AI、プロジェクト「源内」の構想紹介 - デジタル庁 note 記事](https://digital-gov.note.jp/n/ndc07326b7491)

## License

- Software: Licensed under the [MIT License](LICENSE).
- Documentation: Licensed under the [Creative Commons Attribution 4.0 International License](LICENSE-CC-BY) (CC BY 4.0).
