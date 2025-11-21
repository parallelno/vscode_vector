import IO from './io';

export class Display {
  static readonly FRAME_W = 768;
  static readonly FRAME_H = 312;
  static readonly FRAME_LEN = Display.FRAME_W * Display.FRAME_H;
  static readonly SCAN_VSYNC = 24;
  static readonly SCAN_VBLANK_TOP = 16;
  static readonly SCAN_VBLANK_BOTTOM = 16;
  static readonly SCAN_ACTIVE_AREA_TOP = Display.SCAN_VSYNC + Display.SCAN_VBLANK_TOP;
  static readonly ACTIVE_AREA_W = 512;
  static readonly ACTIVE_AREA_H = 256;
  static readonly BORDER_LEFT = 128;
  static readonly BORDER_RIGHT = Display.BORDER_LEFT + Display.ACTIVE_AREA_W;
  static readonly RASTERIZED_PXLS_MAX = 16;

  memory: any;
  io: IO;
  // framebuffers use 32-bit ARGB values
  frameBuffer: Uint32Array;
  backBuffer: Uint32Array;
  framebufferIdx = 0;
  frameNum = 0;

  constructor(memory: any, io: IO) {
    this.memory = memory;
    this.io = io;
    this.frameBuffer = new Uint32Array(Display.FRAME_LEN);
    this.backBuffer = new Uint32Array(Display.FRAME_LEN);
    // initialize palette to identity mapping
    for (let i = 0; i < Display.FRAME_LEN; i++) this.frameBuffer[i] = 0xff000000;
    this.framebufferIdx = 0;
  }

  // Convert vector color (BBGGGRRR) -> ARGB (32-bit)
  static vectorColorToArgb(v: number) {
    const r = v & 0x07;
    const g = (v & 0x38) >> 3;
    const b = (v & 0xc0) >> 6;
    const color = 0xff000000 |
      ((r & 0xff) << (5 + 0)) |
      ((g & 0xff) << (5 + 8)) |
      ((b & 0xff) << (6 + 16));
    return color >>> 0;
  }

  // Reads 4 screen bytes at _screenAddrOffset, matching C++ GetScreenBytes
  getScreenBytes(screenAddrOffset: number): number {
    const base = screenAddrOffset & 0xffff;
    const b8 = this.memory.getByte(0x8000 + base) | 0;
    const bA = this.memory.getByte(0xA000 + base) | 0;
    const bC = this.memory.getByte(0xC000 + base) | 0;
    const bE = this.memory.getByte(0xE000 + base) | 0;
    return (b8 << 24) | (bA << 16) | (bC << 8) | bE;
  }

  // Extract 4-bit color index (256 mode) from 4 screen bytes and bit index
  bytesToColorIdx256(screenBytes: number, bitIdx: number) {
    return ((screenBytes >> (bitIdx + 0)) & 1) |
      (((screenBytes >> (bitIdx - 1 + 8)) & 1) << 1) |
      (((screenBytes >> (bitIdx - 2 + 16)) & 1) << 2) |
      (((screenBytes >> (bitIdx - 3 + 24)) & 1) << 3);
  }

  // Extract 3-bit color index (512 mode) - simplified to match C++ logic
  bytesToColorIdx512(screenBytes: number, bitIdx: number) {
    const even = (bitIdx & 1) === 1;
    let idx = 0;
    const b = bitIdx >> 1;
    if (even) {
      idx = ((screenBytes >> (b + 0)) & 1) | (((screenBytes >> (b - 1 + 8)) & 1) << 1);
    } else {
      idx = (((screenBytes >> (b + 16)) & 1) | (((screenBytes >> (b - 1 + 24)) & 1) << 1)) * 4;
    }
    return idx;
  }

  // Rasterize up to RASTERIZED_PXLS_MAX pixels. Should be called once per 4 CPU cycles.
  rasterizeChunk() {
    let rasterLine = Math.floor(this.framebufferIdx / Display.FRAME_W);
    let rasterPixel = this.framebufferIdx % Display.FRAME_W;

    const rasterizedPixels = Math.min(Display.BORDER_RIGHT - rasterPixel, Display.RASTERIZED_PXLS_MAX);

    for (let i = 0; i < rasterizedPixels; i++) {
      const isActiveScan = rasterLine >= Display.SCAN_ACTIVE_AREA_TOP && rasterLine < Display.SCAN_ACTIVE_AREA_TOP + Display.ACTIVE_AREA_H;
      const isActiveArea = isActiveScan && rasterPixel >= Display.BORDER_LEFT && rasterPixel < Display.BORDER_RIGHT;

      let color = 0xff000000;

      if (isActiveArea) {
        // compute screen bytes
        const addrHigh = Math.floor((rasterPixel - Display.BORDER_LEFT) / Display.RASTERIZED_PXLS_MAX);
        const addrLow = Display.ACTIVE_AREA_H - 1 - (rasterLine - Display.SCAN_ACTIVE_AREA_TOP);
        const screenAddrOffset = ((addrHigh << 8) | (addrLow & 0xff)) & 0xffff;
        const screenBytes = this.getScreenBytes(screenAddrOffset);
        const bitIdx = 7 - (((this.framebufferIdx - Display.BORDER_LEFT) % Display.RASTERIZED_PXLS_MAX) >> 1);
        const colorIdx = this.bytesToColorIdx256(screenBytes, bitIdx) & 0x0f;
        // let IO decide palette mapping
        const palIdx = this.io.getColor(colorIdx);
        color = Display.vectorColorToArgb(palIdx);
        // inform IO about pixel for commit timers
        this.io.tryToCommit(colorIdx);
      } else {
        // border
        const brd = this.io.getBorderColor();
        color = Display.vectorColorToArgb(brd);
        this.io.tryToCommit(brd);
      }

      this.frameBuffer[this.framebufferIdx++] = color >>> 0;

      // wrap frame
      if (this.framebufferIdx >= Display.FRAME_LEN) {
        this.frameNum++;
        // copy frameBuffer to backBuffer
        this.backBuffer.set(this.frameBuffer);
        this.framebufferIdx = 0;
      }

      rasterPixel++;
      if (rasterPixel >= Display.FRAME_W) {
        rasterPixel = 0; rasterLine++;
      }
    }
  }

  // Return a scaled 256x192 RGBA buffer derived from the full frame buffer
  getScaledFrame(): { width: number; height: number; data: Uint8ClampedArray } {
    const outW = 256, outH = 192;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      const srcY = Display.SCAN_ACTIVE_AREA_TOP + Math.floor(y * Display.ACTIVE_AREA_H / outH);
      for (let x = 0; x < outW; x++) {
        const srcX = Display.BORDER_LEFT + x * 2; // map 256 -> 512
        const srcIdx = srcY * Display.FRAME_W + srcX;
        const col = this.backBuffer[srcIdx] || 0xff000000;
        const base = (y * outW + x) * 4;
        out[base + 0] = (col >> 16) & 0xff; // R (ARGB->RGBA ordering)
        out[base + 1] = (col >> 8) & 0xff; // G
        out[base + 2] = (col >> 0) & 0xff; // B
        out[base + 3] = 255;
      }
    }
    return { width: outW, height: outH, data: out };
  }
}

export default Display;
