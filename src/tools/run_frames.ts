#!/usr/bin/env node
/**
 * run_frames.ts
 *
 * Assembles an `.asm` (if provided) and runs the ROM in the Emulator for N frames.
 * Writes each frame to a raw RGBA file and — if `pngjs` is installed — to a PNG.
 *
 * NOTE: This script expects `pngjs` to be installed if PNG output is desired:
 *    npm install pngjs
 *
 * The script uses the native framebuffer resolution exported by the `Display`
 * implementation (`FRAME_W` and `FRAME_H`) and does not alter or rescale frames.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assemble } from '../assembler';
// When running this tool from Node (outside of VS Code) the extension's
// emulator module imports `vscode`. Intercept module loading for 'vscode'
// to provide a lightweight mock so the emulator can initialize without the
// real VS Code API.
const { Hardware } = require('../hardware');
const { HardwareReq } = require('../hardware_reqs');
const { ROM_LOAD_ADDR } = require('../memory');
import { FRAME_W, FRAME_H } from '../emulator/display';

function usage() {
  console.log('Usage: npm run run-frames -- <asm|rom> <numFrames> [outDir]');
  console.log('Example: npm run run-frames -- test/asm_test_all_i8080_set/fill_erase_scr_set_pal.asm 5 frames_out');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 2) usage();

const input = argv[0];
const numFrames = parseInt(argv[1], 10);
const outDir = argv[2] || 'frames_out';

if (!fs.existsSync(input)) {
  console.error('Input file not found:', input);
  process.exit(2);
}
if (isNaN(numFrames) || numFrames <= 0) {
  console.error('Invalid numFrames:', argv[1]);
  process.exit(3);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function assembleIfNeeded(inputPath: string): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.rom') return inputPath;
  if (ext !== '.asm') throw new Error('Unsupported input extension: ' + ext);

  // Use the project's assembler
  try {
    const src = fs.readFileSync(inputPath, 'utf8');
    const res = assemble(src, inputPath);
    if (!res || !res.success || !res.output) {
      console.error('Assembly failed for', inputPath, res && res.errors ? res.errors : 'unknown');
      process.exit(4);
    }
    const romPath = path.join(outDir, path.basename(inputPath, '.asm') + '.rom');
    fs.writeFileSync(romPath, res.output);
    console.log('Assembled ->', romPath, 'len=', res.output.length);
    return romPath;
  } catch (e) {
    console.error('Assemble error:', String(e));
    process.exit(5);
  }
}

// The display now produces native RGBA-packed bytes in the frame buffer.
// We can write the raw buffer directly.

async function main() {
  const romPath = await assembleIfNeeded(input);

  // Create Hardware and load ROM into memory
  const hw = new Hardware('', '', true);
  try {
    const buffer = fs.readFileSync(romPath);
    const result = new Uint8Array(buffer);
    hw.Request(HardwareReq.SET_MEM, { data: result, addr: ROM_LOAD_ADDR });
  } catch (e) {
    console.error('Failed to load ROM into hardware:', e);
    process.exit(6);
  }
  // Ensure HW is running
  try { hw.Request(HardwareReq.RESTART); } catch (e) {}
  try { hw.Request(HardwareReq.RUN); } catch (e) {}

  // small warmup
  await new Promise(r => setTimeout(r, 50));

  for (let f = 0; f < numFrames; f++) {
    // execute one frame without breaks
    try { hw.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS); } catch (e) { console.error(e); break; }

    const disp = hw.display;
    if (!disp) {
      console.error('No display available');
      break;
    }

    // Get the native framebuffer using the Display API. Do not rescale.
    const frameBuf = disp.GetFrame ? disp.GetFrame(true) : (disp.frameBuffer ? disp.frameBuffer : null);
    if (!frameBuf) {
      console.error('Unable to get frame buffer for frame', f);
      continue;
    }

    // frameBuf is a Uint32Array whose underlying ArrayBuffer contains RGBA bytes
    const rawBuf = Buffer.from((frameBuf as Uint32Array).buffer);
    const outRaw = path.join(outDir, `frame_${String(f).padStart(3,'0')}.raw`);
    fs.writeFileSync(outRaw, rawBuf);
    console.log('Wrote', outRaw, 'bytes=', rawBuf.length, `(${FRAME_W}x${FRAME_H})`);

    // try to write PNG if pngjs is installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PNG } = require('pngjs');
      const png = new PNG({ width: FRAME_W, height: FRAME_H });
      // copy raw RGBA bytes directly into png.data
      rawBuf.copy(png.data, 0, 0, rawBuf.length);
      const outPng = path.join(outDir, `frame_${String(f).padStart(3,'0')}.png`);
      await new Promise<void>((res, rej) => {
        const ws = fs.createWriteStream(outPng);
        png.pack().pipe(ws).on('finish', () => res()).on('error', (err: any) => rej(err));
      });
      console.log('Wrote', outPng);
    } catch (e) {
      // pngjs not installed — skip silently
    }

    // print basic hw stats
    try {
      const cc = hw.Request(HardwareReq.GET_CC).cc;
      const frameNum = disp.frameNum;
      console.log(`Frame ${f}: frameNum=${frameNum}, cc=${cc}`);
    } catch (e) {
      console.log('Frame', f, 'stats not available');
    }
  }

  try { hw.Request(HardwareReq.EXIT); } catch (e) {}
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(10); });
