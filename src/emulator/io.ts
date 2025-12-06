// the hardware logic is mostly taken from:
// https://github.com/parallelno/v06x/blob/master/src/board.cpp
// https://github.com/parallelno/v06x/blob/master/src/vio.h

import { Keyboard } from './keyboard';
import { Memory } from './memory';
import { TimerI8253 } from './timer_i8253';
import { SoundAY8910 } from './sound_ay8910';
import { Fdc1793, Port as FdcPort } from './fdc_wd1793';

const PALETTE_LEN = 16;
export type Palette = Uint8Array;

export type Ports = {
  CW: number;
  portA: number;
  portB: number;
  portC: number;
  CW2: number;
  portA2: number;
  portB2: number;
  portC2: number;
};

export class State {
  palette: Palette;
  ports: Ports;
  ruslatHistory: number;
  outport: number;
  outbyte: number;

  outCommitTimer: number; // in pixels (12Mhz clock)
  paletteCommitTimer: number; // in pixels (12Mhz clock)
  displayModeTimer: number; // in pixels (12Mhz clock)

  joy0: number;
  joy1: number;

  hwColor: number; // a tmp store for a output color before it commited to the HW. Vector06C color format : uint8_t BBGGGRRR
  reqDisplayMode: boolean; // a tmp store for a display mode before it commited to HW
  brdColorIdx: number; // border color idx
  displayMode: boolean; // false - 256 mode, true - 512 mode
  ruslat: boolean; // RUS/LAT keyboard language state

  constructor() {
    this.palette = new Uint8Array(PALETTE_LEN);
    this.ports = { CW: 0x08, portA: 0xFF, portB: 0xFF, portC: 0xFF, CW2: 0, portA2: 0xFF, portB2: 0xFF, portC2: 0xFF };
    this.ruslatHistory = 0;
    this.outport = 0;
    this.outbyte = 0;

    this.outCommitTimer = 0;
    this.paletteCommitTimer = 0;
    this.displayModeTimer = 0;

    this.joy0 = 0xFF;
    this.joy1 = 0xFF;

    this.hwColor = 0;
    this.reqDisplayMode = IO.MODE_256;
    this.brdColorIdx = 0;
    this.displayMode = IO.MODE_256;
    this.ruslat = IO.RUS;
  }
};

export class IO {
  // determines when the OUT command sends data into the port
  // this timing is based on the 12 MHz clock (equivalent to the number of pixels in 512 mode)
  // it's calculated from the start of the third machine cycle (4 cpu cycles each)
  static readonly OUT_COMMIT_TIME = 1; // pixels
  // determines when the color sent from the port is stored in the palette memory
	// this timing is based on the 12 MHz clock (equivalent to the number of pixels in 512 mode)
	// it's calculated from the start of the third machine cycle (4 cpu cycles each)
  static readonly PALETTE_COMMIT_TIME = 5; // pixels
  static readonly DISPLAY_MODE_COMMIT_TIME = 2 * 4;

  // ports
  static readonly PORT_OUT_BORDER_COLOR0 = 0x0C;
	static readonly PORT_OUT_BORDER_COLOR1 = 0x0D;
	static readonly PORT_OUT_BORDER_COLOR2 = 0x0E;
	static readonly PORT_OUT_BORDER_COLOR3 = 0x0F;
	static readonly PORT_OUT_DISPLAY_MODE = 0x02;
  static readonly MODE_256 = false;
  static readonly MODE_512 = true;
  static readonly RUS = false;
  static readonly LAT = true;

  state: State = new State();

  keyboard?: Keyboard;
	memory?: Memory;
  timer: TimerI8253 = new TimerI8253();
  ay: SoundAY8910 = new SoundAY8910();
  fdc: Fdc1793 = new Fdc1793();

  // commit timers (in pixels)
  outCommitTime = IO.OUT_COMMIT_TIME;
  paletteCommitTime = IO.PALETTE_COMMIT_TIME;
  displayModeTime = IO.DISPLAY_MODE_COMMIT_TIME;

  // debugging storage (not used extensively)
  portsInData = new Uint8Array(256);
  portsOutData = new Uint8Array(256);

  constructor(keyboard?: Keyboard, memory?: Memory) {
    this.keyboard = keyboard;
    this.memory = memory;
    this.Init();
  }

  Init() {
    this.state = new State();
  }

  // I8080 IN NN
  // handling the data receiving from ports
    PortInHandling(port: number): number
  {
    let result: number = 0xFF;
    let CW = this.state.ports.CW;
    let PORT_A = this.state.ports.portA;
    let PORT_B = this.state.ports.portB;
    let PORT_C = this.state.ports.portC;
    let CW2 = this.state.ports.CW2;
    let PORT_A2 = this.state.ports.portA2;
    let PORT_B2 = this.state.ports.portB2;
    let PORT_C2 = this.state.ports.portC2;
    let JOY_0 = this.state.joy0;
    let JOY_1 = this.state.joy1;

    switch (port) {
      case 0x00:
        result = 0xFF;
        break;
    case 0x01:
    {
      /* PortC.low input ? */
      let portCLow: number = (CW & 0x01) ? 0x0b : PORT_C & 0x0f;
      /* PortC.high input ? */
      let portCHigh: number = (CW & 0x08) ?
          /*(tape_player.sample() << 4) |*/
          ((this.keyboard?.keySS ?? false) ? 0 : 1 << 5) |
          ((this.keyboard?.keyUS ?? false) ? 0 : 1 << 6) |
          ((this.keyboard?.keyRus ?? false) ? 0 : 1 << 7) : (PORT_C & 0xf0);
      result = portCLow | portCHigh;
    }
      break;

    case 0x02:
      if ((CW & 0x02) != 0) {
        result = this.keyboard?.Read(PORT_A) ?? 0xFF; // input
      }
      else {
        result = PORT_B;       // output
      }
      break;
    case 0x03:
      if ((CW & 0x10) == 0) {
        result = PORT_A;       // output
      }
      else {
        result = 0xFF;          // input
      }
      break;

      // Parallel Port
    case 0x04:
      result = CW2;
      break;
    case 0x05:
      result = PORT_C2;
      break;
    case 0x06:
      result = PORT_B2;
      break;
    case 0x07:
      result = PORT_A2;
      break;

      // Timer
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
      return this.timer.read(~port & 3);

      // Joystick "C"
    case 0x0e:
      return JOY_0;
    case 0x0f:
      return JOY_1;

      // AY
    case 0x14:
    case 0x15:
      result = this.ay.Read(port & 1);
      break;

      // FDD
    case 0x18:
      result = this.fdc.read(FdcPort.DATA);
      break;
    case 0x19:
      result = this.fdc.read(FdcPort.SECTOR);
      break;
    case 0x1a:
      result = this.fdc.read(FdcPort.TRACK);
      break;
    case 0x1b:
      result = this.fdc.read(FdcPort.STATUS);
      break;
    case 0x1c:
      result = this.fdc.read(FdcPort.READY);
      break;
    default:
      break;
    }

    return result;
  }

  // I8080 OUT NN
  // called at the commit time. it's data sent by the cpu instruction OUT
  PortOutHandling(port: number, value: number)
  {
    switch (port) {
      // PortInputA
    case 0x00:
      this.state.ruslat = ((this.state.ports.portC >> 3) & 1) === 1;
      if ((value & 0x80) === 0) {
        // port C BSR:
        //   bit 0: 1 = set, 0 = reset
        //   bit 1-3: bit number
        let bit: number = (value >> 1) & 7;
        if ((value & 1) === 1) {
          this.state.ports.portC |= 1 << bit;
        }
        else {
          this.state.ports.portC &= ~(1 << bit);
        }
      }
      else {
        this.state.ports.CW = value;
        this.PortOutHandling(1, 0);
        this.PortOutHandling(2, 0);
        this.PortOutHandling(3, 0);
      }
      break;
    case 0x01:
      this.state.ruslat = ((this.state.ports.portC >> 3) & 1) === 1;
      this.state.ruslatHistory = (this.state.ruslatHistory<<1) + (this.state.ruslat ? 1 : 0);
      this.state.ports.portC = value;
      break;
    case 0x02:
      this.state.ports.portB = value;
      this.state.brdColorIdx = this.state.ports.portB & 0x0f;
      this.state.reqDisplayMode = (this.state.ports.portB & 0x10) !== 0;
      break;
      // Vertical Scrolling
    case 0x03:
      this.state.ports.portA = value;
      break;
      // Parallel Port
    case 0x04:
      this.state.ports.CW2 = value;
      break;
    case 0x05:
      this.state.ports.portC2 = value;
      break;
    case 0x06:
      this.state.ports.portB2 = value;
      break;
    case 0x07:
      this.state.ports.portA2 = value;
      break;

      // Timer
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
      this.timer.write(~port & 3, value);
      break;

      // Color pallete
    case IO.PORT_OUT_BORDER_COLOR0:
    case IO.PORT_OUT_BORDER_COLOR1:
    case IO.PORT_OUT_BORDER_COLOR2:
    case IO.PORT_OUT_BORDER_COLOR3:
      this.state.hwColor = value;
      break;

      // Ram Disk 0
    case 0x10:
      this.memory?.SetRamDiskMode(0, value);
      break;
      // Ram Disk 1
    case 0x11:
      this.memory?.SetRamDiskMode(1, value);
      break;
      // AY
    case 0x14:
    case 0x15:
      this.ay.Write(port & 1, value);
      break;

      // FDD
    case 0x18:
      this.fdc.write(FdcPort.DATA, value);
      break;
    case 0x19:
      this.fdc.write(FdcPort.SECTOR, value);
      break;
    case 0x1a:
      this.fdc.write(FdcPort.TRACK, value);
      break;
    case 0x1b:
      this.fdc.write(FdcPort.COMMAND, value);
      break;
    case 0x1c:
      this.fdc.write(FdcPort.SYSTEM, value);
      break;

      // Ram Disk 2
    case 0x20:
      this.memory?.SetRamDiskMode(2, value);
      break;
      // Ram Disk 3
    case 0x21:
      this.memory?.SetRamDiskMode(3, value);
      break;
      // Ram Disk 4
    case 0x40:
      this.memory?.SetRamDiskMode(4, value);
      break;
      // Ram Disk 5
    case 0x41:
      this.memory?.SetRamDiskMode(5, value);
      break;
      // Ram Disk 6
    case 0x80:
      this.memory?.SetRamDiskMode(6, value);
      break;
      // Ram Disk 7
    case 0x81:
      this.memory?.SetRamDiskMode(7, value);
      break;
      // Sends data to the emulator
    case 0xED:
      // TODO: do something meaningful.
      // For example: write to a file, breaks the app,
      // or let the emulator execute a custom command depending on the _value
      console.log(`Debug Port (0xED) out: ${value}`);
      break;
    default:
      break;
    }
  }

  // cpu IN instruction callback
  PortIn(port: number): number
  {
    let out = this.PortInHandling(port);
    // store it for debbuging
    this.portsInData[port] = out;
    return out;
  }

  // cpu OUT instruction callback
  PortOut(port: number, value: number): void
  {
    // store it for debbuging
    this.portsOutData[port] = value;

    // store port/val data to handle when ports are available (commit time)
    this.state.outport = port;
    this.state.outbyte = value;

    // set the commit time for port output
    this.state.outCommitTimer = this.outCommitTime;

    // set the palette commit time
    switch (port)
    {
      case IO.PORT_OUT_BORDER_COLOR0:
      case IO.PORT_OUT_BORDER_COLOR1:
      case IO.PORT_OUT_BORDER_COLOR2:
      case IO.PORT_OUT_BORDER_COLOR3:
        this.state.paletteCommitTimer = this.paletteCommitTime;
        break;
      case IO.PORT_OUT_DISPLAY_MODE:
        this.state.displayModeTimer = this.displayModeTime;
        break;
    }
  }

  TryToCommit(colorIdx: number)
  {
    if (this.state.outCommitTimer > 0){
      if (--this.state.outCommitTimer == 0)
      {
        this.PortOutCommit();
      }
    }

    if (this.state.paletteCommitTimer > 0) {
      if (--this.state.paletteCommitTimer == 0)
      {
        this.SetColor(colorIdx);
      }
    }

    if (this.state.displayModeTimer > 0) {
      if (--this.state.displayModeTimer == 0)
      {
        this.state.displayMode = this.state.reqDisplayMode;
      }
    }
  }

  PortOutCommit()
  {
    this.PortOutHandling(this.state.outport, this.state.outbyte);
  }

  SetColor(colorIdx: number) { this.state.palette[colorIdx] = this.state.hwColor; };
  GetOutCommitTimer(): number { return this.state.outCommitTimer; };
  GetPaletteCommitTimer(): number { return this.state.paletteCommitTimer; };
  GetPaletteCommitTime(): number { return this.paletteCommitTime; };
  SetPaletteCommitTime(_paletteCommitTime: number) { this.paletteCommitTime = _paletteCommitTime; };
  GetDisplayMode(): boolean { return this.state.displayMode; };
  GetBorderColorIdx(): number { return this.state.brdColorIdx; };
  GetBorderColor(): number { return this.state.palette[this.state.brdColorIdx]; };
  GetColor(colorIdx: number): number { return this.state.palette[colorIdx]; };
  GetScroll(): number { return this.state.ports.portA; };
  GetBeeper(): number { return this.state.ports.portC & 1; } // it also out to the tape
}


export default IO;
