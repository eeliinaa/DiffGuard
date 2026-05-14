// Strict transport contract and adapter
export type FindingTransportPacketV1 = {
  file: string;
  line: number;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  ruleId: string;
};

const SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;

function isString(x: unknown): x is string {
  return typeof x === "string";
}
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isSeverity(x: unknown): x is FindingTransportPacketV1["severity"] {
  return SEVERITIES.includes(x as any);
}

export function toTransportPacket(finding: unknown): FindingTransportPacketV1 {
  if (
    typeof finding !== "object" || finding === null || Array.isArray(finding)
  ) throw new Error("Invalid finding: not an object");
  const f = finding as Record<string, unknown>;
  if (!isString(f.file)) throw new Error("Invalid finding: file");
  if (!isNumber(f.line)) throw new Error("Invalid finding: line");
  if (!isString(f.message)) throw new Error("Invalid finding: message");
  if (!isSeverity(f.severity)) throw new Error("Invalid finding: severity");
  if (!isString(f.ruleId)) throw new Error("Invalid finding: ruleId");
  return {
    file: f.file,
    line: f.line,
    message: f.message,
    severity: f.severity,
    ruleId: f.ruleId
  };
}
