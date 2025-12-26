import * as fs from 'fs';
import * as path from 'path';

// require compiled assembler JS from out/assembler (keeps runtime same as before)
const asm: any = require('../assembler/assembler');

// Expect a project file (.project.json). Default to sample project.
const arg = process.argv[2] || path.join('temp', 'project', 'gd_error.project.json');
const projectPath = path.resolve(arg);

try {
  const projectText = fs.readFileSync(projectPath, 'utf8');
  const project = JSON.parse(projectText);
  if (!project.asmPath) {
    throw new Error('Project file missing asmPath');
  }

  const projectDir = path.dirname(projectPath);
  const srcPath = path.isAbsolute(project.asmPath)
    ? project.asmPath
    : path.resolve(projectDir, project.asmPath);
  const outBin = project.romPath
    ? (path.isAbsolute(project.romPath) ? project.romPath : path.resolve(projectDir, project.romPath))
    : path.join(process.cwd(), 'tmp_test.rom');
  const debugPath = project.debugPath
    ? (path.isAbsolute(project.debugPath) ? project.debugPath : path.resolve(projectDir, project.debugPath))
    : undefined;

  const src = fs.readFileSync(srcPath, 'utf8');
  const writer = typeof asm.assembleAndWriteWithProject === 'function'
    ? asm.assembleAndWriteWithProject(projectPath)
    : asm.assembleAndWrite;
  const res: any = writer(src, outBin, srcPath, debugPath);
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
