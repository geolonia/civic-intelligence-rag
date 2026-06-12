#!/usr/bin/env bash
# deploy-lawsy.sh — LawsyMigrationStack-dev 安全 deploy ラッパー
#
# INCIDENT #1 (subtask_508f_hotfix): ALLOWED_IPS 脱落 → 403
# INCIDENT #2 (subtask_508g2_hotfix2): LAWSY_API_KEY_HASH 空(len=0) → 401
# 再発防止のため HASH と ALLOWED_IPS を必ず両方セットして deploy する。
#
# Keychain 統合 (Phase 3 / cmd_520):
#   macOS: macOS Keychain 経由 (get-secret.sh) — per-use Touch ID 不要
#   WSL/Linux: 1Password (op) 経由 (従来通り — C6 遵守)
#
# 使い方:
#   ./scripts/deploy-lawsy.sh          # 実際に deploy
#   ./scripts/deploy-lawsy.sh --dry-run # deploy せず env 確認のみ
#
# ── 初回 macOS Keychain 投入手順 (殿が1回実施) ──────────────────────────────────
#   1. ~/.config/keychain-sync/secrets.conf を以下の内容で作成:
#      lawsy-api-key      lawsy-civic-intelligence-rag  geonic-ops  LAWSY_API_KEY
#      lawsy-api-key-hash lawsy-civic-intelligence-rag  geonic-ops  LAWSY_API_KEY_HASH
#   2. 初回投入 (1Password Touch ID 1回で Keychain にキャッシュ):
#      bash ~/tools/multi-agent-shogun/scripts/sync-secrets-to-keychain.sh
#   以降の deploy は Touch ID なし (login keychain 解錠中の場合)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
set +x  # C3: disable trace to prevent secret values in logs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CDK_DIR="${REPO_ROOT}/aws/lawsy-migration"
STACK_NAME="LawsyMigrationStack-dev"
AWS_PROFILE="${AWS_PROFILE:-genai-eval}"
GET_SECRET_SCRIPT="${GET_SECRET_SCRIPT:-$HOME/tools/multi-agent-shogun/scripts/get-secret.sh}"
SYNC_SCRIPT="$HOME/tools/multi-agent-shogun/scripts/sync-secrets-to-keychain.sh"
DRY_RUN=false

# ── 引数処理 ──────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      echo "  --dry-run  Show computed env vars without deploying"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ── get-secret.sh を source ────────────────────────────────────────────────────
if [[ ! -f "$GET_SECRET_SCRIPT" ]]; then
  echo "[ERROR] get-secret.sh not found: $GET_SECRET_SCRIPT" >&2
  echo "[ERROR] Set GET_SECRET_SCRIPT env var or install multi-agent-shogun at ~/tools/multi-agent-shogun" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$GET_SECRET_SCRIPT"

# ── 依存コマンド確認 ──────────────────────────────────────────────────────────
for cmd in aws curl openssl awk; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "[ERROR] Required command not found: $cmd" >&2
    exit 1
  fi
done

# ── Layer 3: deploy 前に Keychain を強制最新化 (macOS のみ実施) ───────────────
if [[ "$(uname -s)" == "Darwin" ]] && [[ -f "$SYNC_SCRIPT" ]]; then
  echo "[0/5] Keychain を最新化中 (Layer 3 pre-deploy refresh)..."
  bash "$SYNC_SCRIPT" --force-refresh lawsy-api-key 2>/dev/null || true
fi

echo "[1/5] LAWSY_API_KEY を取得中..."
# C3: 変数にのみ格納 — echo/log/report に出さぬこと
# macOS → Keychain 経由 (get-secret.sh が自動分岐), WSL/Linux → op 直接
LAWSY_API_KEY=$(get_secret "lawsy-api-key")

if [ -z "$LAWSY_API_KEY" ]; then
  echo "[ERROR] LAWSY_API_KEY の取得に失敗しました" >&2
  exit 1
fi

echo "[2/5] LAWSY_API_KEY_HASH を算出中..."
LAWSY_API_KEY_HASH=$(printf '%s' "$LAWSY_API_KEY" | openssl dgst -sha256 | awk '{print $2}')
HASH_LEN="${#LAWSY_API_KEY_HASH}"

if [ "$HASH_LEN" -ne 64 ]; then
  echo "[ERROR] HASH の長さが不正です: expected=64 actual=${HASH_LEN}" >&2
  exit 1
fi
echo "    HASH len=${HASH_LEN} ✓"

echo "[3/5] GenU スタックから NAT EIP × 2 を取得中..."
NAT_EIPS=$(aws ec2 describe-addresses \
  --profile "${AWS_PROFILE}" \
  --query "Addresses[?Tags[?Key=='aws:cloudformation:stack-name' && contains(Value,'GenerativeAiUseCasesStack')]].PublicIp" \
  --output text 2>/dev/null | tr '\t' ',')

if [ -z "$NAT_EIPS" ]; then
  echo "[ERROR] GenU スタックの NAT EIP が取得できませんでした" >&2
  exit 1
fi

NAT_EIP_COUNT=$(echo "$NAT_EIPS" | tr ',' '\n' | grep -c .)
echo "    NAT EIP count=${NAT_EIP_COUNT} ✓"

echo "[4/5] Mac mini egress IP を取得中..."
MAC_MINI_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null) || { echo "ERROR: ipify request failed" >&2; exit 1; }
if ! echo "$MAC_MINI_IP" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
  echo "ERROR: Invalid IP format from ipify" >&2; exit 1
fi
echo "    Mac mini IP 取得完了 ✓"

if [ "$NAT_EIP_COUNT" -lt 2 ]; then
  echo "ERROR: Expected 2 NAT EIPs, got ${NAT_EIP_COUNT} (check GenerativeAiUseCasesStack)" >&2; exit 1
fi
ALLOWED_IPS="${NAT_EIPS},${MAC_MINI_IP}"

echo "[5/5] deploy 準備完了"
echo "    STACK: ${STACK_NAME}"
echo "    HASH_LEN: ${HASH_LEN}"
echo "    ALLOWED_IPS_COUNT: $(echo "$ALLOWED_IPS" | tr ',' '\n' | grep -c .)"
echo "    AWS_PROFILE: ${AWS_PROFILE}"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[DRY-RUN] deploy をスキップします。"
  echo "    平文の HASH・IP 値は表示しません (セキュリティポリシー)。"
  exit 0
fi

echo ""
echo ">>> npx cdk deploy ${STACK_NAME} を実行中..."
cd "${CDK_DIR}"
LAWSY_API_KEY_HASH="${LAWSY_API_KEY_HASH}" \
  ALLOWED_IPS="${ALLOWED_IPS}" \
  AWS_PROFILE="${AWS_PROFILE}" \
  npx cdk deploy "${STACK_NAME}" \
    --require-approval never \
    --app "npx ts-node bin/lawsy-migration.ts"

echo ""
echo "✅ deploy 完了。Lambda 環境変数を検証中..."

SEARCH_FUNC=$(aws lambda list-functions --profile "${AWS_PROFILE}" \
  --query "Functions[?starts_with(FunctionName,'LawsyMigrationStack-') && ends_with(FunctionName,'-searchFunction')].FunctionName | [0]" \
  --output text 2>/dev/null)
if [ -z "$SEARCH_FUNC" ] || [ "$SEARCH_FUNC" = "None" ]; then
  echo "ERROR: SearchLambda not found under LawsyMigrationStack" >&2; exit 1
fi

DEPLOYED_HASH=$(aws lambda get-function-configuration \
  --function-name "$SEARCH_FUNC" --profile "${AWS_PROFILE}" \
  --query "Environment.Variables.LAWSY_API_KEY_HASH" --output text)
if [ "$DEPLOYED_HASH" != "$LAWSY_API_KEY_HASH" ]; then
  echo "ERROR: Deployed HASH mismatch" >&2; exit 1
fi
DEPLOYED_IPS=$(aws lambda get-function-configuration \
  --function-name "$SEARCH_FUNC" --profile "${AWS_PROFILE}" \
  --query "Environment.Variables.ALLOWED_IPS" --output text)
if [ "$DEPLOYED_IPS" != "$ALLOWED_IPS" ]; then
  echo "ERROR: Deployed ALLOWED_IPS mismatch" >&2; exit 1
fi
echo "✅ 検証 PASS: HASH and ALLOWED_IPS match"
