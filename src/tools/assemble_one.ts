import * as fs from 'fs';
import * as path from 'path';

// require compiled assembler JS from out/assembler (keeps runtime same as before)
const asm: any = require('../out/assembler');

const arg = process.argv[2] || path.join('test','asm_test_all_i8080_set','fill_erase_scr_set_pal.asm');
const srcPath = path.resolve(arg);
try {
  const src = fs.readFileSync(srcPath, 'utf8');
  const outBin = path.join(process.cwd(), 'tmp_test.rom');
  const res: any = asm.assembleAndWrite(src, outBin, srcPath);
  if (!res.success) {
    console.error('Assembly failed:');
    if (res.errors) res.errors.forEach((e: any) => console.error(e));
    process.exit(2);
  }
  console.log('Wrote', res.path);
} catch (err: any) {
  console.error('Error:', err && err.message ? err.message : err);
  process.exit(2);
}
