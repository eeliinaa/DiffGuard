import fs from 'fs';
import path from 'path';
import ts from 'typescript';

describe('Transport Layer Static Enforcement', () => {
  it('should only allow one export producing FindingTransportPacketV1', () => {
    const srcDir = path.join(__dirname, '..');
    let count = 0;
    function scan(file) {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        const source = fs.readFileSync(file, 'utf8');
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        ts.forEachChild(ast, node => {
          if (ts.isFunctionDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
            if (node.type.typeName.getText() === 'FindingTransportPacketV1') {
              count++;
            }
          }
        });
      }
    }
    function walk(dir) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else scan(full);
      }
    }
    walk(srcDir);
    expect(count).toBe(1);
  });
});
