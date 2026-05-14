// Internal only: fallback adapter (for legacy mode)
import { FindingTransportPacketV1 } from "../FindingTransport.js";

export function legacyToTransportPacket(finding: any): FindingTransportPacketV1 {
  return {
    file: typeof finding.file === "string" ? finding.file : "unknown",
    line: typeof finding.line === "number" ? finding.line : 0,
    message: typeof finding.message === "string" ? finding.message : "",
    severity: ["LOW", "MEDIUM", "HIGH"].includes(finding.severity)
      ? finding.severity
      : "LOW",
    ruleId: typeof finding.ruleId === "string" ? finding.ruleId : "unknown"
  };
}
