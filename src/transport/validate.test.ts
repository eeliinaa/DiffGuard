import { validateTransportPacket } from "./validate";

describe("validateTransportPacket", () => {
  it("accepts valid packets", () => {
    expect(
      validateTransportPacket({
        file: "a.js",
        line: 1,
        message: "msg",
        severity: "LOW",
        ruleId: "R1"
      })
    ).toBe(true);
  });

  it("rejects invalid packets in debug", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      validateTransportPacket({ file: 1, line: "x", message: 2, severity: "BAD", ruleId: 3 }, true)
    ).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not reject in prod mode", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      validateTransportPacket({ file: 1, line: "x", message: 2, severity: "BAD", ruleId: 3 }, false)
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
