import os
from dataclasses import dataclass

import google.auth

# Environment variable keys
PROJECT_ID = "GOOGLE_CLOUD_PROJECT"
LOG_LEVEL = "LOG_LEVEL"
INFERENCE_LOCATION = "INFERENCE_LOCATION"
INFERENCE_PROJECT_ID = "INFERENCE_PROJECT_ID"
MODEL_ID = "MODEL_ID"
GCS_BUCKET_NAME = "GCS_BUCKET_NAME"
BQ_DATASET_ID = "BQ_DATASET_ID"

# Generation config environment variable keys
GENERATION_TEMPERATURE = "GENERATION_TEMPERATURE"
GENERATION_MAX_OUTPUT_TOKENS = "GENERATION_MAX_OUTPUT_TOKENS"
GENERATION_TOP_P = "GENERATION_TOP_P"
GENERATION_TOP_K = "GENERATION_TOP_K"
GENERATION_CANDIDATE_COUNT = "GENERATION_CANDIDATE_COUNT"
GENERATION_SYSTEM_INSTRUCTION = "GENERATION_SYSTEM_INSTRUCTION"

# Default values
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_MODEL_ID = "gemini-2.5-flash"


@dataclass
class GeminiConfig:
    """Configuration for the Gemini service."""

    log_level: str
    project_id: str
    location: str
    model_id: str
    gcs_bucket_name: str | None
    temperature: float
    max_output_tokens: int
    top_p: float
    top_k: int
    candidate_count: int
    system_instruction: str
    pass_file_by_uri: bool = True
    # BigQuery specific settings for lawsy-custom-bq
    bq_project_id: str = ""
    bq_dataset_id: str = ""


def get_env_param(name: str, default, converter):
    """Helper to get and convert an environment variable."""
    try:
        value = os.environ.get(name)
        return converter(value) if value is not None else default
    except (TypeError, ValueError):
        return default


_DEFAULT_SYSTEM_INSTRUCTION = (
    "You are a friendly and helpful assistant. "
    "Ensure answers are complete unless the user requests brevity. "
    "When generating code, include explanations."
)


def load_gemini_config() -> GeminiConfig:
    """Loads configuration from environment variables."""
    # The project where this Cloud Run job is running
    job_project_id = os.environ.get(PROJECT_ID)
    # The project where the inference is executed
    inference_project_id = os.environ.get(INFERENCE_PROJECT_ID, job_project_id)

    if not job_project_id:
        raise ValueError("PROJECT_ID environment variable must be set.")

    if not inference_project_id:
        inference_project_id = job_project_id  # フォールバック

    # Determine how to pass files to the API
    pass_file_by_uri = job_project_id == inference_project_id

    # BigQuery project ID: use the same project as CloudRun via google.auth.default()
    try:
        _, bq_project_id = google.auth.default()
        if not bq_project_id:
            raise ValueError("Could not determine project ID from google.auth.default()")
    except Exception as e:
        raise ValueError(f"Failed to get project ID from google.auth.default(): {e}") from e

    bq_dataset_id = os.environ.get(BQ_DATASET_ID, "e_laws_search")

    return GeminiConfig(
        log_level=get_env_param(LOG_LEVEL, DEFAULT_LOG_LEVEL, str).upper(),
        project_id=inference_project_id,
        location=os.environ.get(INFERENCE_LOCATION, "asia-northeast1"),
        model_id=os.environ.get(MODEL_ID, DEFAULT_MODEL_ID),
        gcs_bucket_name=os.environ.get(GCS_BUCKET_NAME),
        temperature=get_env_param(GENERATION_TEMPERATURE, 0.5, float),
        max_output_tokens=4098,
        top_p=get_env_param(GENERATION_TOP_P, 1.0, float),
        top_k=get_env_param(GENERATION_TOP_K, 1, int),  # デフォルトを1に変更
        candidate_count=get_env_param(GENERATION_CANDIDATE_COUNT, 1, int),
        system_instruction=get_env_param(
            GENERATION_SYSTEM_INSTRUCTION,
            _DEFAULT_SYSTEM_INSTRUCTION,
            str,
        ),
        pass_file_by_uri=pass_file_by_uri,
        bq_project_id=bq_project_id,
        bq_dataset_id=bq_dataset_id,
    )
