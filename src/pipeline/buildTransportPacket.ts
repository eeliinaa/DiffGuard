// Entry point for building transport packets
import { FEATURE_FLAGS } from "../config/featureFlags.js";
import { toTransportPacket } from "../transport/FindingTransport.js";
import { legacyToTransportPacket } from "../transport/internal/adapter.js";

export function buildTransportPacket(finding: unknown) {
  if (FEATURE_FLAGS.STRICT_TRANSPORT) {
    return toTransportPacket(finding);
  } else {
    return legacyToTransportPacket(finding);
  }
}
