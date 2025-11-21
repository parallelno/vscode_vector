import Keyboard from './keyboard';

export class IO {
  // Constants matching C++ timings (in pixels / 12MHz units, but we use pixels)
  static readonly OUT_COMMIT_TIME = 1; // pixels
  static readonly PALETTE_COMMIT_TIME = 5; // pixels
  static readonly DISPLAY_MODE_COMMIT_TIME = 2 * 4;

  // ports / palette
  palette: Uint8Array;
  portsA = 0xff;
  portsB = 0xff;
  portsC = 0xff;

  // commit timers (in pixels)
  outCommitTimer = 0;
  paletteCommitTimer = 0;
  displayModeTimer = 0;

  // temp registers
  outPort = 0;
  outByte = 0;
  hwColor = 0;
  reqDisplayMode = false;
  brdColorIdx = 0;
  displayMode = false; // false = 256 mode, true = 512 mode

  keyboard?: Keyboard;

  // debugging storage (not used extensively)
  portsInData = new Uint8Array(256);
  portsOutData = new Uint8Array(256);

  constructor(_keyboard?: Keyboard) {
    this.keyboard = _keyboard;
    this.palette = new Uint8Array(16);
    this.init();
  }

  init() {
    this.portsA = this.portsB = this.portsC = 0xff;
    this.outPort = this.outByte = this.hwColor = this.brdColorIdx = 0;
    this.displayMode = false;
    this.outCommitTimer = this.paletteCommitTimer = this.displayModeTimer = 0;
  }

  // Called by CPU emulation when OUT instruction executed: schedule commit
  portOut(port: number, value: number) {
    this.portsOutData[port & 0xff] = value & 0xff;
    this.outPort = port & 0xff;
    this.outByte = value & 0xff;
    this.outCommitTimer = IO.OUT_COMMIT_TIME;

    // if this is a palette/border write, schedule palette commit
    if (port === 0x0c || port === 0x0d || port === 0x0e || port === 0x0f) {
      this.hwColor = value & 0xff;
      this.paletteCommitTimer = IO.PALETTE_COMMIT_TIME;
    }
    if (port === 0x02) {
      // display mode / border color port
      this.portsB = value & 0xff;
      this.brdColorIdx = value & 0x0f;
      this.reqDisplayMode = (value & 0x10) !== 0;
      this.displayModeTimer = IO.DISPLAY_MODE_COMMIT_TIME;
    }
    if (port === 0x03) {
      this.portsA = value & 0xff; // scroll
    }
  }

  // Called by rasterizer every pixel to decrement timers and commit when ready
  tryToCommit(colorIdx: number) {
    if (this.outCommitTimer > 0) {
      this.outCommitTimer -= 1;
      if (this.outCommitTimer <= 0) {
        this.portOutHandling(this.outPort, this.outByte);
      }
    }

    if (this.paletteCommitTimer > 0) {
      this.paletteCommitTimer -= 1;
      if (this.paletteCommitTimer <= 0) {
        // commit hwColor into palette at colorIdx
        const idx = colorIdx & 0x0f;
        this.palette[idx] = this.hwColor & 0xff;
      }
    }

    if (this.displayModeTimer > 0) {
      this.displayModeTimer -= 1;
      if (this.displayModeTimer <= 0) {
        this.displayMode = this.reqDisplayMode;
      }
    }
  }

  portOutHandling(port: number, value: number) {
    switch (port & 0xff) {
      case 0x00:
        // control word / port C handling simplified
        this.portsC = value & 0xff;
        break;
      case 0x01:
        this.portsC = value & 0xff;
        break;
      case 0x02:
        this.portsB = value & 0xff;
        this.brdColorIdx = value & 0x0f;
        this.reqDisplayMode = (value & 0x10) !== 0;
        break;
      case 0x03:
        this.portsA = value & 0xff;
        break;
      default:
        break;
    }
  }

  // Minimal port in with keyboard handling for port 0x02 and simplified port1/0 behavior
  portIn(port: number): number {
    const p = port & 0xff;
    let out = 0xff;
    switch (p) {
      case 0x02:
        // return keyboard read for selected rows (portsA)
        if (this.keyboard) {
          out = this.keyboard.read(this.portsA);
          break;
        }
        out = this.portsB;
        break;
      case 0x01:
        // return PORT_C mixing in modifier states
        out = this.portsC & 0x0f;
        // high nibble: supply modifier bits
        let high = 0;
        if (!this.keyboard) high = (this.portsC & 0xf0);
        else {
          high = ((this.keyboard.m_keySS ? 0 : 1 << 5) |
                  (this.keyboard.m_keyUS ? 0 : 1 << 6) |
                  (this.keyboard.m_keyRus ? 0 : 1 << 7));
        }
        out = (out & 0x0f) | (high & 0xf0);
        break;
      default:
        out = this.portsInData[p] || 0xff;
        break;
    }
    this.portsInData[p] = out & 0xff;
    return out & 0xff;
  }

  // getters used by display
  getColor(idx: number) { return this.palette[idx & 0x0f] & 0xff; }
  getBorderColor() { return this.palette[this.brdColorIdx & 0x0f] & 0xff; }
  getOutCommitTimer() { return this.outCommitTimer; }
  getPaletteCommitTimer() { return this.paletteCommitTimer; }
  getDisplayMode() { return this.displayMode; }
  getScroll() { return this.portsA; }
  getKeyboard() { return this.keyboard; }
}

export default IO;
