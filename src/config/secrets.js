import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || "deft-effect-416921";
const client = new SecretManagerServiceClient();
const memory = new Map();

/**
 * Agency feed API key: env first, then Secret Manager `transit-{slug}-api-key`.
 * @param {{ apiKeyEnv?: string, apiKeySecret?: string, slug: string }} agency
 */
export async function getAgencyApiKey(agency) {
  const envName = agency.apiKeyEnv || `TRANSIT_${agency.slug.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  if (process.env[envName]) return process.env[envName];

  const secretId = agency.apiKeySecret || `transit-${agency.slug}-api-key`;
  if (memory.has(secretId)) return memory.get(secretId);

  try {
    const name = `projects/${projectId}/secrets/${secretId}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });
    const key = version.payload?.data?.toString("utf8")?.trim() || null;
    if (key) memory.set(secretId, key);
    return key;
  } catch (err) {
    console.warn(`[secrets] No key for ${secretId}: ${err.message}`);
    return null;
  }
}
