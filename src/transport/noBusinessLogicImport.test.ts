// Test: Warn if transport imports analysis or rules (soft mode)
import fs from "fs";
import path from "path";

const transportDir = path.join(__dirname);
const forbidden = ["analysis", "rules"];

describe("Transport Layer Import Guard", () => {
  fs.readdirSync(transportDir)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .forEach(file => {
      test(`${file} should not import forbidden modules`, () => {
        const content = fs.readFileSync(path.join(transportDir, file), "utf8");
        forbidden.forEach(mod => {
          if (content.includes(`from '../${mod}`) || content.includes(`from "../${mod}`)) {
            console.warn(`[Transport Import Guard] ${file} imports ${mod} — WARNING`);
          }
        });
      });
    });
});
