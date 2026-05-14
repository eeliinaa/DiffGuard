// Transport Layer Contracts for DiffGuard
// DO NOT ADD FIELDS. STRICT CONTRACT ONLY.

export type FindingTransportPacketV1 = {
  file: string;
  line: number;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  ruleId: string;
};
