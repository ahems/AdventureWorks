#!/usr/bin/env bash
# Queue AI review generation on the deployed Functions API.
#
# Usage: scripts/generators/generate-reviews-with-embeddings.sh [productId ...]
#
# Authenticates as the seeded admin identity through scripts/utilities/azure-auth.py
# (Functions audience, admin.write) for the selected azd environment. Review batches
# run serially on ai-job-chat-queue; when that queue drains, the processor enqueues
# review embeddings automatically. Progress is visible in the admin portal.
# This calls Foundry models and can incur cost.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

body='{}'
if [ "$#" -gt 0 ]; then
    for id in "$@"; do
        [[ "$id" =~ ^[0-9]+$ ]] || { echo "Product IDs must be integers: $id" >&2; exit 1; }
    done
    body="{\"ProductIds\":[$(IFS=,; echo "$*")]}"
fi

echo "Queueing AI review generation (embeddings follow automatically)..."
python3 "$REPO_ROOT/scripts/utilities/azure-auth.py" request \
    --identity admin --resource functions \
    --path /api/GenerateProductReviewsUsingAI_HttpStart --method POST \
    --data "$body"
echo
