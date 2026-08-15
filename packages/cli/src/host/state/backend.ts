import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID as CLAWSEC_BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  type BrokerBackendCapabilitiesV1 as ClawsecBrokerBackendCapabilitiesV1,
  brokerBackendCapabilitiesDigest as clawsecBrokerBackendCapabilitiesDigest,
  canonicalBrokerBackendCapabilitiesV1 as clawsecCanonicalBrokerBackendCapabilitiesV1,
  parseBrokerBackendCapabilitiesV1 as clawsecParseBrokerBackendCapabilitiesV1,
  SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
} from "@remote-claw/clawsec";
import { type A1Digest, parseA1Digest } from "./ids.js";

export const BROKER_BACKEND_CAPABILITIES_SCHEMA_ID = CLAWSEC_BROKER_BACKEND_CAPABILITIES_SCHEMA_ID;

export type BrokerBackendCapabilitiesV1 = ClawsecBrokerBackendCapabilitiesV1;

/** Exact selected-A1 vector shared by the browser, broker, and host-state kernel. */
export const REQUIRED_BROKER_BACKEND_CAPABILITIES_V1 = SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1;

export function parseBrokerBackendCapabilitiesV1(value: unknown): BrokerBackendCapabilitiesV1 {
  return clawsecParseBrokerBackendCapabilitiesV1(value);
}

/** Exact CanonicalWriter bytes retained by the host as its protected capability artifact. */
export function canonicalBrokerBackendCapabilitiesV1(value: unknown): Uint8Array {
  return clawsecCanonicalBrokerBackendCapabilitiesV1(value);
}

export async function brokerBackendCapabilitiesDigest(value: unknown): Promise<A1Digest> {
  return parseA1Digest(await clawsecBrokerBackendCapabilitiesDigest(value));
}
