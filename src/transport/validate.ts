// Output validation for transport packets
import { FindingTransportPacketV1 } from "./contracts.js";

export function validateTransportPacket(packet: any, debug = false): boolean {
  const valid =
    typeof packet.file === "string" &&
    typeof packet.line === "number" &&
    typeof packet.message === "string" &&
    ["LOW", "MEDIUM", "HIGH"].includes(packet.severity) &&
    typeof packet.ruleId === "string";
  if (!valid && debug) {
    console.warn("[Transport] Malformed packet", packet);
  }
  return valid;
}
