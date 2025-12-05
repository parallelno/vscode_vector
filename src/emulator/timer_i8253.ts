// from vector06sdl (c) 2018 Viacheslav Slavinsky
// https://github.com/svofski/vector06sdl/blob/master/src/8253.h
// Ported to TypeScript from:
// https://github.com/parallelno/Devector/blob/master/src/core/timer_i8253.h
// https://github.com/parallelno/Devector/blob/master/src/core/timer_i8253.cpp

// Constants for timing delays (from original i8253 timing)
// WRITE_DELAY and READ_DELAY are defined in the original C++ code but unused
// const WRITE_DELAY = 2;
// const READ_DELAY = 0;
const LATCH_DELAY = 1;

export class CounterUnit {
  private latchValue: number = -1;
  private writeState: number = 0;
  private latchMode: number = 0;
  private out: number = 0;
  private value: number = 0;
  private modeInt: number = 0;

  private writeLsb: number = 0;
  private writeMsb: number = 0;
  private loadValue: number = 0;

  private delay: number = 0;

  // Flags stored as individual booleans for clarity
  private flagArmed: boolean = false;
  private flagLoad: boolean = false;
  private flagEnabled: boolean = false;
  private flagBcd: boolean = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.latchValue = -1;
    this.writeState = 0;
    this.value = 0;
    this.modeInt = 0;
    this.loadValue = 0;
    this.flagArmed = false;
    this.flagLoad = false;
    this.flagEnabled = false;
    this.flagBcd = false;
    this.delay = 0;
    this.writeLsb = 0;
    this.writeMsb = 0;
    this.out = 0;
    this.latchMode = 0;
  }

  setMode(mode: number, latchMode: number, flagBcd: boolean): void {
    this.clock(LATCH_DELAY);
    this.delay = LATCH_DELAY;

    this.flagBcd = flagBcd;
    if ((mode & 0x03) === 2) {
      this.modeInt = 2;
    } else if ((mode & 0x03) === 3) {
      this.modeInt = 3;
    } else {
      this.modeInt = mode;
    }

    switch (this.modeInt) {
      case 0:
        this.out = 0;
        this.flagArmed = true;
        this.flagEnabled = false;
        break;
      case 1:
        this.out = 1;
        this.flagArmed = true;
        this.flagEnabled = false;
        break;
      case 2:
        this.out = 1;
        this.flagEnabled = false;
        // armed?
        break;
      default:
        this.out = 1;
        this.flagEnabled = false;
        // armed?
        break;
    }
    this.flagLoad = false;
    this.latchMode = latchMode;
    this.writeState = 0;
  }

  latch(): void {
    this.clock(LATCH_DELAY);
    this.delay = LATCH_DELAY;
    this.latchValue = this.value;
  }

  clock(cycles: number): number {
    if (this.delay) {
      --this.delay;
      cycles = 0;
    }
    if (!cycles) return this.out;
    if (!this.flagEnabled && !this.flagLoad) return this.out;

    let result = this.out;

    switch (this.modeInt) {
      case 0: // Interrupt on terminal count
        if (this.flagLoad) {
          this.value = this.loadValue;
          this.flagEnabled = true;
          this.flagArmed = true;
          this.out = 0;
          result = 0;
        }
        if (this.flagEnabled) {
          const previous = this.value;
          this.value -= cycles;
          if (this.value <= 0) {
            if (this.flagArmed) {
              if (previous !== 0) this.out = 1;
              result = -this.value + 1;
              this.flagArmed = false;
            }
            this.value += this.flagBcd ? 10000 : 65536;
          }
        }
        break;
      case 1: // Programmable one-shot
        if (!this.flagEnabled && this.flagLoad) {
          // value = loadvalue; -- quirk!
          this.flagEnabled = true;
        }
        if (this.flagEnabled) {
          this.value -= cycles;
          if (this.value <= 0) {
            const reload =
              this.loadValue === 0
                ? this.flagBcd
                  ? 10000
                  : 0x10000
                : this.loadValue + 1;
            this.value += reload;
          }
        }
        break;
      case 2: // Rate generator
        if (!this.flagEnabled && this.flagLoad) {
          this.value = this.loadValue;
          this.flagEnabled = true;
        }
        if (this.flagEnabled) {
          this.value -= cycles;
          if (this.value <= 0) {
            const reload =
              this.loadValue === 0
                ? this.flagBcd
                  ? 10000
                  : 0x10000
                : this.loadValue;
            this.value += reload;
          }
        }
        // out will go low for one clock pulse but in our machine it should not be
        // audible
        break;
      case 3: // Square wave generator
        if (!this.flagEnabled && this.flagLoad) {
          this.value = this.loadValue;
          this.flagEnabled = true;
        }
        if (this.flagEnabled) {
          this.value -=
            this.value === this.loadValue && (this.value & 1) === 1
              ? this.out === 0
                ? 3
                : 1
              : 2;

          if (this.value <= 0) {
            this.out ^= 1;

            const reload =
              this.loadValue === 0
                ? this.flagBcd
                  ? 10000
                  : 0x10000
                : this.loadValue;
            this.value += reload;
          }
        }
        result = this.out;
        break;
      case 4: // Software triggered strobe
        break;
      case 5: // Hardware triggered strobe
        break;
      default:
        break;
    }

    this.flagLoad = false;
    return result;
  }

  write(w8: number): void {
    if (this.latchMode === 3) {
      // lsb, msb
      switch (this.writeState) {
        case 0:
          this.writeLsb = w8;
          this.writeState = 1;
          break;
        case 1:
          this.writeMsb = w8;
          this.writeState = 0;
          this.loadValue = ((this.writeMsb << 8) & 0xffff) | (this.writeLsb & 0xff);
          this.flagLoad = true;
          break;
        default:
          break;
      }
    } else if (this.latchMode === 1) {
      // lsb only
      this.loadValue = w8;
      this.flagLoad = true;
    } else if (this.latchMode === 2) {
      // msb only
      this.value = w8 << 8;
      this.value &= 0xffff;
      this.loadValue = this.value;
      this.flagLoad = true;
    }
    if (this.flagLoad) {
      if (this.flagBcd) {
        this.loadValue = CounterUnit.fromBcd(this.loadValue);
      }
      // Set the delay cycles based on mode. Mode 0 always has 3-cycle delay.
      // Modes 1-3 have 3-cycle delay only when counter is not yet enabled.
      // Other modes have 4-cycle delay.
      switch (this.modeInt) {
        case 0:
          this.delay = 3;
          break;
        case 1:
          if (!this.flagEnabled) {
            this.delay = 3;
          }
          break;
        case 2:
          if (!this.flagEnabled) {
            this.delay = 3;
          }
          break;
        case 3:
          if (!this.flagEnabled) {
            this.delay = 3;
          }
          break;
        default:
          this.delay = 4;
          break;
      }
    }
  }

  read(): number {
    let value = 0;
    switch (this.latchMode) {
      case 0:
        // Should not happen in normal operation
        break;
      case 1:
        value = this.latchValue !== -1 ? this.latchValue : this.value;
        this.latchValue = -1;
        value = this.flagBcd ? CounterUnit.toBcd(value) : value;
        value &= 0xff;
        break;
      case 2:
        value = this.latchValue !== -1 ? this.latchValue : this.value;
        this.latchValue = -1;
        value = this.flagBcd ? CounterUnit.toBcd(value) : value;
        value = (value >> 8) & 0xff;
        break;
      case 3:
        value = this.latchValue !== -1 ? this.latchValue : this.value;
        value = this.flagBcd ? CounterUnit.toBcd(value) : value;
        switch (this.writeState) {
          case 0:
            this.writeState = 1;
            value = value & 0xff;
            break;
          case 1:
            this.latchValue = -1;
            this.writeState = 0;
            value = (value >> 8) & 0xff;
            break;
          default:
            break;
        }
        break;
      default:
        break;
    }
    return value;
  }

  static toBcd(x: number): number {
    let result = 0;
    for (let i = 0; i < 4; ++i) {
      result |= (x % 10) << (i * 4);
      x = Math.floor(x / 10);
    }
    return result;
  }

  static fromBcd(x: number): number {
    let result = 0;
    for (let i = 0; i < 4; ++i) {
      let digit = (x & 0xf000) >> 12;
      if (digit > 9) digit = 9;
      result = result * 10 + digit;
      x <<= 4;
      x &= 0xffff; // Keep it within 16 bits
    }
    return result;
  }
}

export class TimerI8253 {
  private counters: CounterUnit[] = [
    new CounterUnit(),
    new CounterUnit(),
    new CounterUnit(),
  ];
  private controlWord: number = 0;

  reset(): void {
    this.counters[0].reset();
    this.counters[1].reset();
    this.counters[2].reset();
  }

  writeCw(w8: number): void {
    const counterSet = (w8 >> 6) & 3;
    const modeSet = (w8 >> 1) & 3;
    const latchSet = (w8 >> 4) & 3;
    const bcdSet = w8 & 1;

    // i8253 only has 3 counters (0-2), counterSet value of 3 is invalid
    if (counterSet > 2) {
      // error - invalid counter selection
      return;
    }

    const counter = this.counters[counterSet];

    if (latchSet === 0) {
      counter.latch();
    } else {
      counter.setMode(modeSet, latchSet, bcdSet === 1);
    }
  }

  write(addr: number, w8: number): void {
    switch (addr & 3) {
      case 0x03:
        this.writeCw(w8);
        return;
      default:
        this.counters[addr & 3].write(w8);
        return;
    }
  }

  read(addr: number): number {
    switch (addr & 3) {
      case 0x03:
        return this.controlWord;
      default:
        return this.counters[addr & 3].read();
    }
  }

  clock(cycles: number): number {
    const ch0 = this.counters[0].clock(cycles);
    const ch1 = this.counters[1].clock(cycles);
    const ch2 = this.counters[2].clock(cycles);
    return (ch0 + ch1 + ch2) / 3.0;
  }
}

export default TimerI8253;
