import IO from './io';
import Memory from './memory';

// phisical frame config:
// 312 scanlines in a frame:
//		vsync: 22 lines
//		vblank (top): 18 lines
//		vertical resolution: 256 lines
//      vblank (bottom): 16 lines

// scanline has 768/384 pxls (MODE_512/MODE_256).
// A scanline rasterising time takes 192 cpu cycles (3 Mhz tick rate) or
// 768 quarters of a cpu cycle (12 Mhz tick rate).
//		hblank (left): 128/64 pxls
//		horizontal resolution : 512/256 pxls
//		hblank (right): 128/64 pxls

// For simplisity of the logic the diplay buffer horizontal resolution
// is always 768 pxls to fit the 512 mode.
// It rasters 4 horizontal pxls every cpu cycle no mater the mode.
// In MODE_256 it dups every 2 horizontal pxls.

export const FRAME_W: number = 768;					// a frame resolution including borders
export const FRAME_H: number = 312;					// a frame resolution including borders
export const FRAME_LEN: number = FRAME_W * FRAME_H;	// the size of a frame buffer

// For the realtime emulation it should be called
//  every 0.019968 seconds by 3000000/59904 Mz timer
const VSYC_DELAY: number = 19968; // in microseconds

const FRAMES_PER_SECOND: number = 50;

const SCAN_VSYNC: number = 24;
const SCAN_VBLANK_TOP: number = 16;
const SCAN_VBLANK_BOTTOM: number = 16;
export const SCAN_ACTIVE_AREA_TOP: number = SCAN_VSYNC + SCAN_VBLANK_TOP;
// horizontal screen resolution in MODE_512
export const ACTIVE_AREA_W: number = 512;
// vertical screen resolution
export const ACTIVE_AREA_H: number = 256;
// horizontal screen resolution in MODE_512
export const BORDER_LEFT: number = 128;
// horizontal screen resolution in MODE_512
const BORDER_RIGHT: number = BORDER_LEFT;
const BORDER_TOP: number = SCAN_ACTIVE_AREA_TOP;
const BORDER_BOTTOM: number = SCAN_VBLANK_BOTTOM;
const ACTIVE_AREA_RIGHT: number = BORDER_LEFT + ACTIVE_AREA_W;
// border visible on the screen in pxls in 256 mode
const BORDER_VISIBLE: number = 16;
// the amount of rasterized pxls every 4 cpu cycles in MODE_512
const RASTERIZED_PXLS_MAX: number = 16;
// this timer in pixels.
// if the palette is set inside the active area,
// the fourth and the fifth pixels get corrupted colors
const COLORS_POLUTED_DELAY: number = 4;

// interrupt request.
// time's counted by 12 MHz clock (equals amount of pixels in 512 mode)
const IRQ_COMMIT_PXL: number = 112;
const SCROLL_COMMIT_PXL: number = BORDER_LEFT + 3;
// vertical scrolling, 0xff - no scroll
const SCROLL_DEFAULT = 0xff;

const FULL_PALETTE_LEN: number = 256;

export class Update	{
  frameNum: number = 0;	// counts frames
  irq: boolean = false;			// interruption request
  framebufferIdx: number = 0;		// currently rendered pixel idx to m_frameBuffer
  scrollIdx: number = SCROLL_DEFAULT;	// vertical scrolling
}

export enum BufferType { FRAME_BUFFER = 0, BACK_BUFFER = 1, GPU_BUFFER = 2 }

export class DisplayState {
  update: Update = new Update();
	frameBuffer?: Uint32Array;
  // TODO: should be used by Recorder
  BuffUpdate?: ((buffer: BufferType) => void);
}

export class Display {
  state: DisplayState = new DisplayState();
  memory?: Memory;
  io?: IO;

  // framebuffers use 32-bit RGBA values (little-endian: bytes in memory are R,G,B,A)
  // rasterizer draws here
  frameBuffer: Uint32Array = new Uint32Array(FRAME_LEN);
  // for VSYNC. it's a copy of a frame buffer when a frame is done
  backBuffer: Uint32Array = new Uint32Array(FRAME_LEN);
  // temp buffer for loading on GPU
  gpuBuffer: Uint32Array = new Uint32Array(FRAME_LEN);

  borderLeft = BORDER_LEFT;
  irqCommitPxl = IRQ_COMMIT_PXL;

  // prebaked look-up vector_color->RGBA palette (packed as 0xAABBGGRR so
  // that in little-endian memory the bytes are [R,G,B,A])
  fullPalette: Uint32Array = new Uint32Array(FULL_PALETTE_LEN);


  constructor(memory: Memory, io: IO)
  {
    this.memory = memory;
    this.io = io;
    this.PrebakeFullPalette();
    this.state.frameBuffer = this.frameBuffer;
    this.state.BuffUpdate = this.BuffUpdate.bind(this);
    this.Init();
  }

  // rasterizes the memory into the frame buff
  BuffUpdate(bufferType: BufferType)
  {
    switch (bufferType)
    {
    case BufferType.FRAME_BUFFER:
      this.FrameBuffUpdate();
      break;

    case BufferType.BACK_BUFFER:
      this.backBuffer.set(this.frameBuffer);
      break;

    case BufferType.GPU_BUFFER:
      this.gpuBuffer.set(this.frameBuffer);
      break;

    default:
      break;
    }
  }

  Init()
  {
    this.state.update.framebufferIdx = 0;
    this.frameBuffer.fill(0xff000000);
  }

  RasterizeActiveArea(rasterizedPixels: number)
  {
    const rasterLine: number = this.rasterLine;
    const rasterPixel: number = this.rasterPixel;
    const commitTime: boolean =
      (this.io?.GetOutCommitTimer() ?? 0) > 0 ||
      (this.io?.GetPaletteCommitTimer() ?? 0) > 0;

    const scrollTime: boolean = rasterLine == SCAN_ACTIVE_AREA_TOP &&
                            rasterPixel < this.borderLeft + RASTERIZED_PXLS_MAX;

    if (commitTime || scrollTime)
    {
      if ((this.io?.GetDisplayMode() ?? IO.MODE_256) == IO.MODE_256) {
        this.FillActiveArea256PortHandling(rasterizedPixels);
      }
      else {
        this.FillActiveArea512PortHandling(rasterizedPixels);
      }
    }
    else {
      if ((this.io?.GetDisplayMode() ?? IO.MODE_256) == IO.MODE_256) {
        this.FillActiveArea256(rasterizedPixels);
      }
      else {
        this.FillActiveArea512(rasterizedPixels);
      }
    }
  }

  RasterizeBorder(rasterizedPixels: number)
  {
    const rasterLine: number = this.rasterLine;
    const commitTime: boolean =
      (this.io?.GetOutCommitTimer() ?? 0) >= 0 ||
      (this.io?.GetPaletteCommitTimer() ?? 0) >= 0;

    if (commitTime || rasterLine == 0 || rasterLine == 311)
    {
      this.FillBorderPortHandling(rasterizedPixels);
    }
    else {
      this.FillBorder(rasterizedPixels);
    }
  }

  // renders 16 pixels (in the 512 mode) from left to right
  Rasterize()
  {
    // reset the interrupt request. it can be set during border drawing.
    this.state.update.irq = false;

    const rasterLine: number = this.rasterLine;
    const rasterPixel: number = this.rasterPixel;

    const isActiveScan: boolean = rasterLine >= SCAN_ACTIVE_AREA_TOP &&
                              rasterLine < SCAN_ACTIVE_AREA_TOP + ACTIVE_AREA_H;
    const isActiveArea: boolean = isActiveScan &&
                    rasterPixel >= this.borderLeft && rasterPixel < ACTIVE_AREA_RIGHT;

    // Rasterize the Active Area
    if (isActiveArea)
    {
      let rasterizedPixels: number =
        Math.min(ACTIVE_AREA_RIGHT - rasterPixel, RASTERIZED_PXLS_MAX);

      this.RasterizeActiveArea(rasterizedPixels);
      // Rasterize the border if there is a leftover
      if (rasterizedPixels < RASTERIZED_PXLS_MAX)
      {
        rasterizedPixels = RASTERIZED_PXLS_MAX - rasterizedPixels;
        this.RasterizeBorder(rasterizedPixels);
      }
    }
    // Rasterize the Border
    else {
      let rasterizedPixels: number = !isActiveScan || rasterPixel >= ACTIVE_AREA_RIGHT ?
              RASTERIZED_PXLS_MAX :
              Math.min(this.borderLeft - rasterPixel, RASTERIZED_PXLS_MAX);

      this.RasterizeBorder(rasterizedPixels);

      // Rasterize the Active Area if there is a leftover
      if (rasterizedPixels < RASTERIZED_PXLS_MAX)
      {
        rasterizedPixels = RASTERIZED_PXLS_MAX - rasterizedPixels;
        this.RasterizeActiveArea(rasterizedPixels);
      }
    }
  }

  FillBorder(rasterizedPixels: number)
  {
    let borderColor: number = this.fullPalette[this.io?.GetBorderColor() ?? 0];
    for (let i = 0; i < rasterizedPixels; i++)
    {
      this.frameBuffer[this.state.update.framebufferIdx++] = borderColor;
    }
  }

  FillBorderPortHandling(rasterizedPixels: number)
  {
    for (let i = 0; i < rasterizedPixels; i++)
    {
      this.io?.TryToCommit(this.io?.GetBorderColorIdx() ?? 0);
      let color = this.fullPalette[this.io?.GetBorderColor() ?? 0];

      this.frameBuffer[this.state.update.framebufferIdx++] = color;
      let isNewFrame = (this.state.update.framebufferIdx / FRAME_LEN) | 0;
      this.state.update.framebufferIdx %= FRAME_LEN;

      let rasterLine = this.rasterLine;
      let rasterPixel = this.rasterPixel;
      this.state.update.irq ||= this.state.update.framebufferIdx == this.irqCommitPxl;

      if (isNewFrame)
      {
        this.state.update.frameNum++;
        // copy a frame to a back buffer for sync rasterization
        this.backBuffer.set(this.frameBuffer);
      }
    }
  }

  FillActiveArea256(rasterizedPixels: number)
  {
    // scrolling
    let rasterLine = this.rasterLine;
    let rasterPixel = this.rasterPixel;
    let rasterLineScrolled = (
      rasterLine - SCAN_ACTIVE_AREA_TOP + (255 - this.state.update.scrollIdx) + ACTIVE_AREA_H) %
      ACTIVE_AREA_H + SCAN_ACTIVE_AREA_TOP;

    // rasterization
    let screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
    let bitIdx = 7 - (
      ((this.state.update.framebufferIdx - this.borderLeft) % RASTERIZED_PXLS_MAX) >> 1);

    for (let i = 0; i < rasterizedPixels; i++)
    {
      let colorIdx = this.BytesToColorIdx256(screenBytes, bitIdx);
      let color = this.fullPalette[this.io?.GetColor(colorIdx) ?? 0];

      this.frameBuffer[this.state.update.framebufferIdx++] = color;

      bitIdx -= i % 2;
      if (bitIdx < 0) {
        bitIdx = 7;
        screenBytes = this.GetScreenBytes(rasterLineScrolled, this.rasterPixel);
      }
    }
  }

  FillActiveArea256PortHandling(rasterizedPixels: number)
  {
    // scrolling
    const rasterLine = this.rasterLine;
    let rasterPixel = this.rasterPixel;
    const rasterLineScrolled = (
      rasterLine - SCAN_ACTIVE_AREA_TOP + (255 - this.state.update.scrollIdx) + ACTIVE_AREA_H) %
      ACTIVE_AREA_H + SCAN_ACTIVE_AREA_TOP;

    // rasterization
    let screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
    let bitIdx = 7 - (
      ((this.state.update.framebufferIdx - this.borderLeft) % RASTERIZED_PXLS_MAX) >> 1);

    for (let i = 0; i < rasterizedPixels; i++)
    {
      rasterPixel = this.rasterPixel;
      if (rasterLine == SCAN_ACTIVE_AREA_TOP && rasterPixel == SCROLL_COMMIT_PXL) {
        this.state.update.scrollIdx = this.io?.GetScroll() ?? SCROLL_DEFAULT;
      }

      let colorIdx = this.BytesToColorIdx256(screenBytes, bitIdx);
      this.io?.TryToCommit(colorIdx);
      let color = this.fullPalette[this.io?.GetColor(colorIdx) ?? 0];

      this.frameBuffer[this.state.update.framebufferIdx++] = color;

      bitIdx -= i % 2;
      if (bitIdx < 0){
        bitIdx = 7;
        screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
      }
    }
  }

  FillActiveArea512PortHandling(rasterizedPixels: number)
  {
    // scrolling
    const rasterLine = this.rasterLine;
    let rasterPixel = this.rasterPixel;
    const rasterLineScrolled = (rasterLine - SCAN_ACTIVE_AREA_TOP +
                          (255 - this.state.update.scrollIdx) +
                          ACTIVE_AREA_H) % ACTIVE_AREA_H + SCAN_ACTIVE_AREA_TOP;

    // rasterization
    // 4 bytes. One byte per screen buffer
    let screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
    // 0-15
    let pxlIdx = 15 - (
      (this.state.update.framebufferIdx - this.borderLeft) % RASTERIZED_PXLS_MAX);

    for (let i = 0; i < rasterizedPixels; i++)
    {
      rasterPixel = this.rasterPixel;

      if (rasterLine == SCAN_ACTIVE_AREA_TOP && rasterPixel == SCROLL_COMMIT_PXL) {
        this.state.update.scrollIdx = this.io?.GetScroll() ?? SCROLL_DEFAULT;
      }

      let colorIdx = this.BytesToColorIdx512(screenBytes, pxlIdx);
      this.io?.TryToCommit(colorIdx);
      let color = this.fullPalette[this.io?.GetColor(colorIdx) ?? 0];

      this.frameBuffer[this.state.update.framebufferIdx++] = color;

      pxlIdx--;
      if (pxlIdx < 0){
        pxlIdx = 15;
        screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
      }
    }
  }

  FillActiveArea512(rasterizedPixels: number)
  {
    // scrolling
    let rasterLine = this.rasterLine;
    let rasterPixel = this.rasterPixel;
    let rasterLineScrolled = (
      rasterLine - SCAN_ACTIVE_AREA_TOP + (255 - this.state.update.scrollIdx) + ACTIVE_AREA_H) %
      ACTIVE_AREA_H + SCAN_ACTIVE_AREA_TOP;

    // rasterization
    // 4 bytes. One byte per screen buffer
    let screenBytes = this.GetScreenBytes(rasterLineScrolled, rasterPixel);
    // 0-15
    let pxlIdx = 15 - (
      (this.state.update.framebufferIdx - this.borderLeft) % RASTERIZED_PXLS_MAX);

    for (let i = 0; i < rasterizedPixels; i++)
    {
      let colorIdx = this.BytesToColorIdx512(screenBytes, pxlIdx);
      let color = this.fullPalette[this.io?.GetColor(colorIdx) ?? 0];

      this.frameBuffer[this.state.update.framebufferIdx++] = color;

      pxlIdx--;
      if (pxlIdx < 0){
        pxlIdx = 15;
        screenBytes = this.GetScreenBytes(rasterLineScrolled, this.rasterPixel);
      }
    }
  }

  IsIRQ(): boolean { return this.state.update.irq; }

  GetFrame(vsync: boolean = true): Uint32Array
  {
    this.gpuBuffer.set(vsync ? this.backBuffer : this.frameBuffer);
    return this.gpuBuffer;
  }

  /**
   * Retrieves four screen bytes at the current raster line and pixel.
   * Each byte for each graphic buffer.
   */
  GetScreenBytes(_rasterLine: number, _rasterPixel: number): number
  {
    let addrHigh = ((_rasterPixel - this.borderLeft) / RASTERIZED_PXLS_MAX) | 0;
    let addrLow = ACTIVE_AREA_H - 1 - (_rasterLine - SCAN_ACTIVE_AREA_TOP);
    let screenAddrOffset = (addrHigh << 8 | addrLow) & 0xffff;
    return this.memory?.GetScreenBytes(screenAddrOffset) ?? 0;
  }

  // 256 screen mode
  // extract a 4-bit color index from the four screen bytes.
  // _bitIdx is in the range [0..7]
  BytesToColorIdx256(screenBytes: number, bitIdx: number): number
  {
    return (screenBytes >> (bitIdx - 0 + 0))  & 1 |
        (screenBytes >> (bitIdx - 1 + 8))  & 2 |
        (screenBytes >> (bitIdx - 2 + 16)) & 4 |
        (screenBytes >> (bitIdx - 3 + 24)) & 8;
  }

  // 512 screen mode
  // extract a 3-bit color index from the four screen bytes.
  // _bitIdx is in the range [0..15]
  // In the 512x256 mode, the even pixel colors are stored in screen buffers 3 and 2,
  // and the odd ones - in screen buffers 0 and 1
  BytesToColorIdx512(screenBytes: number, bitIdx: number): number
  {
    const even: boolean = (bitIdx & 1) !== 0;
    bitIdx >>= 1;

    if (even) {
      const result = (screenBytes >> (bitIdx - 0 + 0)) & 1 |
                     (screenBytes >> (bitIdx - 1 + 8)) & 2;
      return result;
    }

    const result =((screenBytes >> (bitIdx - 0 + 16)) & 1 |
                   (screenBytes >> (bitIdx - 1 + 24)) & 2) * 4;
    return result;
  }


  FrameBuffUpdate()
  {
    const framebufferIdxTemp = this.state.update.framebufferIdx;
    this.state.update.framebufferIdx = 0;

    for(let i=0; i < FRAME_LEN; i += 16)
    {
      const rasterLine: number = this.rasterLine;
      const rasterPixel: number = this.rasterPixel;

      const isActiveScan: boolean = rasterLine >= SCAN_ACTIVE_AREA_TOP &&
                              rasterLine < SCAN_ACTIVE_AREA_TOP + ACTIVE_AREA_H;
      const isActiveArea: boolean = isActiveScan &&
                                    rasterPixel >= this.borderLeft &&
                                    rasterPixel < ACTIVE_AREA_RIGHT;

      // Rasterize the Active Area
      if (isActiveArea)
      {
        let rasterizedPixels = Math.min(ACTIVE_AREA_RIGHT - rasterPixel, RASTERIZED_PXLS_MAX);

        if ((this.io?.GetDisplayMode() ?? IO.MODE_256) == IO.MODE_256) {
          this.FillActiveArea256(rasterizedPixels);
        }
        else {
          this.FillActiveArea512(rasterizedPixels);
        }

        // Rasterize the border if there is a leftover
        if (rasterizedPixels < RASTERIZED_PXLS_MAX)
        {
          rasterizedPixels = RASTERIZED_PXLS_MAX - rasterizedPixels;
          this.FillBorder(rasterizedPixels);
        }
      }
      // Rasterize the Border
      else {
        let rasterizedPixels = !isActiveScan || rasterPixel >= ACTIVE_AREA_RIGHT ?
          RASTERIZED_PXLS_MAX :
          Math.min(this.borderLeft - rasterPixel, RASTERIZED_PXLS_MAX);

        this.FillBorder(rasterizedPixels);

        // Rasterize the Active Area if there is a leftover
        if (rasterizedPixels < RASTERIZED_PXLS_MAX)
        {
          rasterizedPixels = RASTERIZED_PXLS_MAX - rasterizedPixels;
          if ((this.io?.GetDisplayMode() ?? IO.MODE_256) == IO.MODE_256) {
            this.FillActiveArea256(rasterizedPixels);
          }
          else {
            this.FillActiveArea512(rasterizedPixels);
          }
        }
      }
    }

    this.state.update.framebufferIdx = framebufferIdxTemp;
  }


  // Vector color format: uint8_t BBGGGRRR
  // Output Color: 32-bit word packed so memory bytes are [R,G,B,A]
  // For little-endian platforms the packed value is: (A<<24)|(B<<16)|(G<<8)|R
  VectorColorToRgbaPacked(vColor: number): number
  {
    const r: number = (vColor & 0x07);
    const g: number = (vColor & 0x38) >> 3;
    const b: number = (vColor & 0xc0) >> 6;
    const r8 = (r << 5) & 0xFF;
    const g8 = (g << 5) & 0xFF;
    const b8 = (b << 6) & 0xFF;
    const a8 = 0xFF;
    const packed = (a8 << 24) | (b8 << 16) | (g8 << 8) | r8;
    return packed >>> 0;
  }

  //Prebake palette to 256x256 color table
  PrebakeFullPalette() {
    for (let i = 0; i < FULL_PALETTE_LEN; i++) {
      this.fullPalette[i] = this.VectorColorToRgbaPacked(i) >>> 0;
    }
  }

  get frameNum(): number { return this.state.update.frameNum; };
  get rasterLine(): number { return (this.state.update.framebufferIdx / FRAME_W) | 0; }; // '| 0' converts to int
  get rasterPixel(): number { return this.state.update.framebufferIdx % FRAME_W; };
	get framebufferIdx(): number { return this.state.update.framebufferIdx; };
  get scrollIdx(): number { return this.state.update.scrollIdx; };
}

export default Display;
