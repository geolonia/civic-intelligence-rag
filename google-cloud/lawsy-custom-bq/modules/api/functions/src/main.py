# ---------------------------
# ライブラリ
# ---------------------------
import logging
import sys

import functions_framework
import genai_util
from flask import Request
from google import genai

from . import gemini_config, retrieval_bq
from .law_report_pipeline import generate_law_report
from .schemas import ResponseBody

# ---------------------------
# 初期化
# ---------------------------

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
handler.setFormatter(formatter)
logger.addHandler(handler)

# グローバル変数と初期化
genai_client = None
app_config = None
bq_retriever = None

try:
    logger.info("アプリケーションの初期化を開始します...")

    # 設定オブジェクトの読み込み
    app_config = gemini_config.load_gemini_config()

    # Gemini Client初期化 (INFERENCE_PROJECT_IDを使用)
    genai_client = genai.Client(
        vertexai=True, project=app_config.project_id, location=app_config.location
    )
    logger.info("Gemini Client initialized successfully.")

    # BigQuery Retrieverの初期化
    bq_retriever = retrieval_bq.BigQueryRetriever(
        project=app_config.bq_project_id, dataset=app_config.bq_dataset_id
    )
    logger.info("BigQuery Retrieverが正常に初期化されました。")

    logger.info("アプリケーションの初期化が完了しました。")

except Exception as e:
    logger.critical(f"アプリケーションの初期化中に致命的なエラーが発生しました: {e}", exc_info=True)
    genai_client = None
    app_config = None
    bq_retriever = None


# ---------------------------
# エントリーポイント
# ---------------------------


@functions_framework.http
def main(request: Request):
    if not genai_client or not app_config:
        return genai_util.create_json_response(
            {"error": "Internal Server Error: AI model not configured."}, 500
        )

    if request.method == "OPTIONS":
        return genai_util.create_json_response({}, 204)

    if request.method != "POST":
        return genai_util.create_json_response({"error": "Method not allowed"}, 405)

    try:
        payload = request.get_json(silent=True)
        if not payload:
            return genai_util.create_json_response({"error": "Invalid JSON"}, 400)

        input_text = payload.get("inputs", {}).get("input_text")
        if not input_text:
            return genai_util.create_json_response(
                {"error": 'Invalid payload. "inputs.input_text" is required.'}, 400
            )

        logger.info(f"処理開始: クエリ='{input_text}'")
        final_report_content, usage_summary = generate_law_report(
            input_text, genai_client, app_config, bq_retriever
        )

        # レスポンスボディを作成してusageMetadataを含める
        response_body = ResponseBody(outputs=final_report_content, usageMetadata=usage_summary)
        return genai_util.create_json_response(response_body.dict(exclude_none=True), 200)

    except Exception as e:
        logger.error(f"エラー発生: {e!s}", exc_info=True)
        return genai_util.create_json_response({"error": "Internal server error"}, 500)
