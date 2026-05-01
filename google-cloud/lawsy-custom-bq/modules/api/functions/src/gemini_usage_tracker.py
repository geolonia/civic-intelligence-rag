from collections import defaultdict
from typing import Any, TypedDict

from google.genai import types
from schemas import EstimatedCostInfo

# ---- Pricing Information ----
# Constants for dictionary keys to avoid literals
KEY_CURRENCY = "currency"
KEY_PRICING_UNIT = "pricing_unit"
KEY_TOKEN_CATEGORIES = "token_categories"
KEY_CATEGORY_NAME = "category_name"
KEY_UNIT_PRICE = "unit_price"

# Constants for summary keys
KEY_REQUEST_COUNT = "requestCount"
KEY_TOKENS = "tokens"
KEY_MODEL_VERSION = "modelVersion"
KEY_ESTIMATED_COST_INFO = "estimatedCostInfo"


class TokenPricingInfo(TypedDict):
    category_name: str
    unit_price: float


class ModelPricing(TypedDict):
    currency: str
    pricing_unit: int
    token_categories: dict[str, TokenPricingInfo]


MODEL_PRICING: dict[str, ModelPricing] = {
    "gemini-2.5-flash-lite": {
        KEY_CURRENCY: "USD",
        KEY_PRICING_UNIT: 1_000_000,
        KEY_TOKEN_CATEGORIES: {
            "prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.1},
            "cached_content_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.025},
            "tool_use_prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.1},
            "candidates_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 0.4},
            "thoughts_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 0.4},
        },
    },
    "gemini-2.5-flash": {
        KEY_CURRENCY: "USD",
        KEY_PRICING_UNIT: 1_000_000,
        KEY_TOKEN_CATEGORIES: {
            "prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.3},
            "cached_content_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.075},
            "tool_use_prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.3},
            "candidates_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 2.5},
            "thoughts_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 2.5},
        },
    },
    "gemini-2.5-pro": {
        KEY_CURRENCY: "USD",
        KEY_PRICING_UNIT: 1_000_000,
        KEY_TOKEN_CATEGORIES: {
            "prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 1.25},
            "cached_content_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.3125},
            "tool_use_prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 1.25},
            "candidates_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 10},
            "thoughts_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 10},
        },
    },
    "gemini-2.5-flash-image-preview": {
        KEY_CURRENCY: "USD",
        KEY_PRICING_UNIT: 1_000_000,
        KEY_TOKEN_CATEGORIES: {
            "prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.1},
            "cached_content_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.025},
            "tool_use_prompt_token_count": {KEY_CATEGORY_NAME: "input", KEY_UNIT_PRICE: 0.1},
            "candidates_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 30},
            "thoughts_token_count": {KEY_CATEGORY_NAME: "output", KEY_UNIT_PRICE: 0.4},
        },
    },
}


class UsageTracker:
    """
    生成AIの利用状況を追跡し、サマリーを生成するヘルパークラス。
    """

    def __init__(self):
        """
        個々のレスポンス情報を格納するリストを初期化します。
        """
        # (modelVersion, usage_metadata) のタプルを格納
        self.usages: list[tuple[str, types.UsageMetadata]] = []

    def add_usage(self, response: types.GenerateContentResponse):
        """
        レスポンスからmodel_versionとUsageMetadataを抽出し、リストに蓄積

        Args:
            response: `google.genai.types.GenerateContentResponse` オブジェクト。
        """
        # responseにusage_metadataやmodel_versionが含まれない場合は何もしない
        if not hasattr(response, "usage_metadata") or not hasattr(response, "model_version"):
            return

        model_version = "unknown"
        # Extract model version string, which might be in a different format
        # e.g., projects/PROJECT/locations/LOCATION/publishers/google/models/gemini-1.5-pro-latest
        if hasattr(response, "model_version") and response.model_version:
            model_version = response.model_version.split("/")[-1]

        self.usages.append((model_version, response.usage_metadata))

    def _format_pricing_unit(self, unit: int) -> str:
        if unit == 1000:
            return "1K"
        if unit == 1_000_000:
            return "1M"
        return str(unit)

    def _snake_to_camel(self, snake_str: str) -> str:
        parts = snake_str.split("_")
        return parts[0] + "".join(p.capitalize() for p in parts[1:])

    def _calculate_estimated_cost(
        self, model_version: str, aggregated_tokens: dict[str, int]
    ) -> EstimatedCostInfo | None:
        model_pricing = MODEL_PRICING.get(model_version)
        if not model_pricing:
            return None

        total_cost = 0.0
        cost_details = {}

        pricing_unit = model_pricing[KEY_PRICING_UNIT]
        unit_str = self._format_pricing_unit(pricing_unit)

        # Group tokens by category (e.g., 'input', 'output')
        tokens_by_category = defaultdict(int)

        for sdk_key, pricing_info in model_pricing[KEY_TOKEN_CATEGORIES].items():
            camel_key = self._snake_to_camel(sdk_key)
            token_count = aggregated_tokens.get(camel_key, 0)

            if token_count > 0:
                cost = (token_count / pricing_unit) * pricing_info[KEY_UNIT_PRICE]
                total_cost += cost
                tokens_by_category[pricing_info[KEY_CATEGORY_NAME]] += token_count

        # Build the detailed cost dictionary
        for category, total_tokens in tokens_by_category.items():
            cost_details[f"{category}Tokens"] = total_tokens

        # Add unit prices for categories that have tokens
        unique_categories = {
            v[KEY_CATEGORY_NAME]: v[KEY_UNIT_PRICE]
            for v in model_pricing[KEY_TOKEN_CATEGORIES].values()
        }
        for category, unit_price in unique_categories.items():
            if f"{category}Tokens" in cost_details:
                cost_details[f"{category}Token{unit_str}UnitPrice"] = unit_price

        return EstimatedCostInfo(
            estimatedCost=total_cost, currency=model_pricing[KEY_CURRENCY], **cost_details
        )

    def get_usage_summary(self) -> list[dict[str, Any]]:
        """
        蓄積された全利用情報から、モデルごとに集計されたサマリーを生成します。

        Returns:
            usageMetadataのフォーマットに準拠した辞書のリスト。
        """
        summary_data = defaultdict(lambda: {KEY_REQUEST_COUNT: 0, KEY_TOKENS: defaultdict(int)})

        for model_version, usage_metadata in self.usages:
            summary_data[model_version][KEY_REQUEST_COUNT] += 1

            # UsageMetadataが持つtoken関連の属性を動的に処理する
            metadata_dict = vars(usage_metadata)
            for key, value in metadata_dict.items():
                if value is not None and key.endswith("token_count"):
                    camel_key = self._snake_to_camel(key)
                    summary_data[model_version][KEY_TOKENS][camel_key] += value

        output_summary = []
        for model_version, data in summary_data.items():
            tokens_dict = dict(data[KEY_TOKENS])
            estimated_cost_info = self._calculate_estimated_cost(model_version, tokens_dict)

            summary_entry = {
                KEY_MODEL_VERSION: model_version,
                KEY_REQUEST_COUNT: data[KEY_REQUEST_COUNT],
                KEY_TOKENS: tokens_dict,
            }
            if estimated_cost_info:
                summary_entry[KEY_ESTIMATED_COST_INFO] = estimated_cost_info.dict()

            output_summary.append(summary_entry)

        return output_summary
