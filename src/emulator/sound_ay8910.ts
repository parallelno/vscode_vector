// vector06sdl (c) 2018 Viacheslav Slavinsky
// AY kernel
//
// Modified AY implementation from Emuscriptoria project
// https://sourceforge.net/projects/emuscriptoria/

// Amplitude table for AY-3-8910 volume levels
const AMP: readonly number[] = [
  0.0, 0.0137, 0.0205, 0.0291,
  0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499,
  0.5704, 0.6873, 0.8482, 1.0
];

// Register masks for AY-3-8910 registers
const RMASK: readonly number[] = [
  0xff, 0x0f, 0xff, 0x0f,
  0xff, 0x0f, 0x1f, 0xff,
  0x1f, 0x1f, 0x1f, 0xff,
  0xff, 0x0f, 0xff, 0xff
];

/**
 * AY-3-8910 Programmable Sound Generator emulation
 */
export class SoundAY8910 {
  // AY registers (16 registers + 3 channel counters)
  private ayr: number[] = new Array(16 + 3).fill(0);

  private envc: number = 0;   // envelope counter
  private envv: number = 0;   // envelope value
  private envx: number = 0;   // envelope position
  private ay13: number = 0;   // envelope shape register state
  private tons: number = 0;   // tone state bits for channels
  private noic: number = 0;   // noise counter
  private noiv: number = 0;   // noise value
  private noir: number = 1;   // noise shift register
  private ayreg: number = 0;  // currently selected register

  constructor() {
    this.Reset();
  }

  Reset(): void {
    this.Init();
  }

  Init(): void {
    this.ayr.fill(0);
    this.envc = 0;
    this.envv = 0;
    this.envx = 0;
    this.ay13 = 0;
    this.tons = 0;
    this.noic = 0;
    this.noiv = 0;
    this.noir = 1;
    this.ayreg = 0;
  }

  /**
   * Channel step - calculates the output for one channel
   * @param ch Channel number (0, 1, or 2)
   * @returns Channel output value (0.0 to 1.0)
   */
  private cstep(ch: number): number {
    const chOffset = ch << 1;
    const periodLow = this.ayr[chOffset];
    const periodHigh = this.ayr[1 | chOffset];
    const period = periodLow | (periodHigh << 8);

    if (++this.ayr[ch + 16] >= period) {
      this.ayr[ch + 16] = 0;
      this.tons ^= 1 << ch;
    }

    const modeL = this.ayr[8 + ch] & 0x10;  // channel M bit: 1 = env, 0 = ayr[8+ch] lsb
    const mixer = this.ayr[7];               // ayr[7] mixer control: x x nC nB nA tC tB tA
    const toneEnaL = mixer >> ch;            // tone enable
    const toneSrc = this.tons >> ch;         // tone source
    const noiseEnaL = mixer >> (ch + 3);     // noise enable
    const noiseGenOp = this.noiv;            // noise source
    const mix = ((toneEnaL | toneSrc) & (noiseEnaL | noiseGenOp)) & 1;

    const amplitude = modeL ? this.envv : (this.ayr[8 + ch] & 0x0f);
    const result = mix * AMP[amplitude];
    return result;
  }

  /**
   * Envelope step - advances the envelope generator
   * @returns Current envelope value (0-15)
   */
  private estep(): number {
    if (this.envx >> 4) {
      if (this.ay13 & 1) { // ENV.HOLD
        return ((this.ay13 >> 1) ^ this.ay13) & 2 ? 15 : 0;
      }
      this.envx = 0;
      this.ay13 ^= (this.ay13 << 1) & 4;
    }
    return this.ay13 & 4 ? this.envx++ : 15 - this.envx++;
  }

  /**
   * Clock the AY-3-8910 - advances all generators by one step
   * @returns Mixed output from all three channels (0.0 to 1.0)
   */
  Clock(): number {
    const envPeriod = (this.ayr[11] << 1) | (this.ayr[12] << 9);
    if (++this.envc >= envPeriod) {
      this.envc = 0;
      this.envv = this.estep();
    }

    const noisePeriod = this.ayr[6] << 1;
    if (++this.noic >= noisePeriod) {
      this.noic = 0;
      this.noiv = this.noir & 1;
      this.noir = (this.noir ^ (this.noiv * 0x24000)) >> 1;
    }

    return (this.cstep(0) + this.cstep(1) + this.cstep(2)) / 3.0;
  }

  /**
   * Mute operation - advances counters without producing output
   */
  aymute(): void {
    const envPeriod = (this.ayr[11] << 1) | (this.ayr[12] << 9);
    if (++this.envc >= envPeriod) {
      this.envc = 0;
      if ((this.envx >> 4) && !(this.ay13 & 1)) {
        this.envx = 0;
        this.ay13 ^= (this.ay13 << 1) & 4;
      }
    }

    const noisePeriod = this.ayr[6] << 1;
    if (++this.noic >= noisePeriod) {
      this.noic = 0;
      this.noiv = this.noir & 1;
      this.noir = (this.noir ^ (this.noiv * 0x24000)) >> 1;
    }

    // Channel A
    const periodA = this.ayr[0] | (this.ayr[1] << 8);
    if (++this.ayr[16] >= periodA) {
      this.ayr[16] = 0;
      this.tons ^= 1;
    }

    // Channel B
    const periodB = this.ayr[2] | (this.ayr[3] << 8);
    if (++this.ayr[17] >= periodB) {
      this.ayr[17] = 0;
      this.tons ^= 2;
    }

    // Channel C
    const periodC = this.ayr[4] | (this.ayr[5] << 8);
    if (++this.ayr[18] >= periodC) {
      this.ayr[18] = 0;
      this.tons ^= 4;
    }
  }

  /**
   * Write to AY register
   * @param addr Address (1 = select register, other = write data)
   * @param val Value to write
   */
  Write(addr: number, val: number): void {
    if (addr === 1) {
      this.ayreg = val & 0x0f;
    } else {
      this.ayr[this.ayreg] = val & RMASK[this.ayreg];
      if (this.ayreg === 13) {
        this.envx = 0;
        // CONT|ATT|ALT|HOLD: 00xx => 1001, 01xx => 1111
        const shape = val & 0x0c;
        if (shape === 0x00) {
          this.ay13 = 9;
        } else if (shape === 4) {
          this.ay13 = 15;
        } else {
          this.ay13 = val;
        }
      }
    }
  }

  /**
   * Read from AY register
   * @param addr Address (1 = read selected register number, other = read register data)
   * @returns Register value
   */
  Read(addr: number): number {
    if (addr === 1) {
      return this.ayreg;
    }
    return this.ayr[this.ayreg];
  }
}

/**
 * AY Wrapper - handles timing conversion between CPU cycles and AY clock
 */
export class AYWrapper {
  private ay: SoundAY8910;
  private last: number = 0;
  private ayAccu: number = 0;

  constructor(ay: SoundAY8910) {
    this.ay = ay;
    this.Init();
  }

  Reset(): void {
    this.ay.Reset();
  }

  Init(): void {
    this.ayAccu = 0;
    this.last = 0;
  }

  /**
   * Clock the AY wrapper with CPU cycles
   * @param cycles Number of CPU cycles elapsed
   * @returns Average audio output for this period
   */
  Clock(cycles: number): number {
    this.ayAccu += 7 * cycles;
    let aysamp = 0;
    let avg = 0;

    for (; this.ayAccu >= 96; this.ayAccu -= 96) {
      aysamp += this.ay.Clock();
      ++avg;
    }

    this.last = avg > 0 ? aysamp / avg : this.last;
    return this.last;
  }
}

export default SoundAY8910;
