import { toTransportPacket } from "./FindingTransport";

describe("toTransportPacket (strict)", () => {
  it("throws on invalid input", () => {
    expect(() => toTransportPacket(null)).toThrow();
    expect(() => toTransportPacket({})).toThrow();
    expect(() => toTransportPacket({ file: 1, line: 2, message: 3, severity: 4, ruleId: 5 })).toThrow();
  });

  it("returns correct shape for valid finding", () => {
    const finding = {
      file: "src/foo.js",
      line: 42,
      message: "Risk detected",
      severity: "HIGH",
      ruleId: "XSS-001"
    };
    expect(toTransportPacket(finding)).toEqual(finding);
  });

  it("throws if severity is outside enum", () => {
    const finding = {
      file: "src/foo.js",
      line: 42,
      message: "Risk detected",
      severity: "CRITICAL",
      ruleId: "XSS-001"
    };
    expect(() => toTransportPacket(finding)).toThrow();
  });
});
