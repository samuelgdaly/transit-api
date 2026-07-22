#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-deft-effect-416921}"
REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-transit-api}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/transit/${SERVICE}"

gcloud config set project "${PROJECT_ID}"

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  --project "${PROJECT_ID}"

if ! gcloud artifacts repositories describe transit --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create transit \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Transit API images" \
    --project="${PROJECT_ID}"
fi

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}"

DEPLOY_ARGS=(
  --image "${IMAGE}"
  --region "${REGION}"
  --platform managed
  --allow-unauthenticated
  --min-instances=0
  --max-instances=3
  --memory=1Gi
  --cpu=1
  --concurrency=20
  --timeout=120
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCP_PROJECT=${PROJECT_ID},NODE_OPTIONS=--max-old-space-size=768"
  --project "${PROJECT_ID}"
)

# Bind any transit-* secrets present (no hardcoded city list).
SECRET_BINDS=()
while IFS= read -r secret; do
  [[ -z "${secret}" ]] && continue
  if [[ "${secret}" == "transit-mobilitydb-refresh-token" ]]; then
    SECRET_BINDS+=("MOBILITYDB_REFRESH_TOKEN=${secret}:latest")
  elif [[ "${secret}" == transit-*-api-key ]]; then
    mid="${secret#transit-}"
    mid="${mid%-api-key}"
    env="TRANSIT_$(echo "${mid}" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
    SECRET_BINDS+=("${env}=${secret}:latest")
  fi
done < <(gcloud secrets list --project="${PROJECT_ID}" --format='value(name)' 2>/dev/null | grep '^transit-' || true)

if ((${#SECRET_BINDS[@]})); then
  DEPLOY_ARGS+=(--set-secrets="$(IFS=,; echo "${SECRET_BINDS[*]}")")
fi

gcloud run deploy "${SERVICE}" "${DEPLOY_ARGS[@]}"

echo "Service URL:"
gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT_ID}" --format='value(status.url)'
