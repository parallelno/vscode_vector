// Audio module for Vector06c emulator
// Ported from C++ implementation:
// https://github.com/parallelno/Devector/blob/master/src/core/audio.h
// https://github.com/parallelno/Devector/blob/master/src/core/audio.cpp

import { TimerI8253 } from './timer_i8253';
import { AYWrapper } from './sound_ay8910';

/**
 * Audio class for emulating sound generation.
 * Combines output from the i8253 timer, AY-3-8910 PSG, and beeper.
 * 
 * Note: This TypeScript version handles audio sample generation and buffering.
 * Unlike the C++ version which uses SDL3 for playback, actual audio playback
 * must be handled externally (e.g., via Web Audio API in a webview).
 */
export class Audio {
  // Timing constants
  private static readonly INPUT_RATE = 1500000;  // 1.5 MHz timer input rate
  private static readonly OUTPUT_RATE = 50000;   // 50 KHz output rate
  private static readonly DOWNSAMPLE_RATE = Audio.INPUT_RATE / Audio.OUTPUT_RATE; // 30

  // Buffer configuration
  private static readonly CALLBACKS_PER_SEC = 100;
  private static readonly SDL_BUFFER = Audio.OUTPUT_RATE / Audio.CALLBACKS_PER_SEC; // 500 samples
  private static readonly SDL_BUFFERS = 8;
  private static readonly BUFFER_SIZE = Audio.SDL_BUFFER * Audio.SDL_BUFFERS; // 4000 samples

  // Buffering thresholds
  private static readonly TARGET_BUFFERING = Audio.SDL_BUFFER * 4; // 2000 samples
  private static readonly LOW_BUFFERING = Audio.TARGET_BUFFERING - Audio.SDL_BUFFER * 2; // 1000 samples
  private static readonly HIGH_BUFFERING = Audio.TARGET_BUFFERING + Audio.SDL_BUFFER * 2; // 3000 samples

  // References to sound generators
  private timer: TimerI8253;
  private aywrapper: AYWrapper;

  // Mute multiplier (0.0 = muted, 1.0 = full volume)
  private muteMul: number = 1.0;

  // Audio sample ring buffer
  private buffer: Float32Array;
  private readBuffIdx: number = 0;  // Index of last sample read for playback
  private writeBuffIdx: number = 0; // Index of last sample written by audio generation
  private lastSample: number = 0.0;

  // Initialization state
  private inited: boolean = false;

  // Adaptive downsample rate for buffer management
  private downsampleRate: number = Audio.DOWNSAMPLE_RATE;

  // Downsample state
  private sampleCounter: number = 0;
  private accumulator: number = 0;

  /**
   * Creates an Audio instance
   * @param timer - Reference to the TimerI8253 instance
   * @param aywrapper - Reference to the AYWrapper instance
   */
  constructor(timer: TimerI8253, aywrapper: AYWrapper) {
    this.timer = timer;
    this.aywrapper = aywrapper;
    this.buffer = new Float32Array(Audio.BUFFER_SIZE);
    this.init();
  }

  /**
   * Initialize the audio system
   */
  init(): void {
    this.buffer.fill(0);
    this.readBuffIdx = 0;
    this.writeBuffIdx = 0;
    this.lastSample = 0;
    this.sampleCounter = 0;
    this.accumulator = 0;
    this.downsampleRate = Audio.DOWNSAMPLE_RATE;
    this.muteMul = 1.0;
    this.inited = true;
  }

  /**
   * Reset the audio system
   */
  reset(): void {
    this.aywrapper.Reset();
    this.timer.reset();
    this.buffer.fill(0);
    this.lastSample = 0;
    this.readBuffIdx = 0;
    this.writeBuffIdx = 0;
    this.sampleCounter = 0;
    this.accumulator = 0;
    this.muteMul = 1.0;
  }

  /**
   * Mute or unmute audio output
   * @param mute - true to mute, false to unmute
   */
  mute(mute: boolean): void {
    this.muteMul = mute ? 0.0 : 1.0;
  }

  /**
   * Check if audio is muted
   */
  isMuted(): boolean {
    return this.muteMul === 0.0;
  }

  /**
   * Clock the audio system - advances all sound generators and produces samples.
   * @param cycles - Number of 1.5 MHz timer ticks to process
   * @param beeper - Beeper output value (0 or 1)
   */
  clock(cycles: number, beeper: number): void {
    if (!this.inited) return;

    for (let tick = 0; tick < cycles; ++tick) {
      // Mix timer, AY, and beeper outputs
      // Timer clocked at 1 cycle, AY at 2 cycles (as per original C++ code)
      const sample = (this.timer.clock(1) + this.aywrapper.Clock(2) + beeper) * this.muteMul;

      // Downsample and store if ready
      const downsampledSample = this.downsample(sample);
      if (downsampledSample !== null) {
        this.buffer[this.writeBuffIdx % Audio.BUFFER_SIZE] = downsampledSample;
        this.writeBuffIdx++;
        this.lastSample = downsampledSample;
      }
    }
  }

  /**
   * Downsample from input rate to output rate using linear interpolation/averaging.
   * @param sample - Input sample at 1.5 MHz rate
   * @returns Downsampled value if ready, null otherwise
   */
  private downsample(sample: number): number | null {
    this.accumulator += sample;

    if (++this.sampleCounter >= this.downsampleRate) {
      const result = this.accumulator / this.downsampleRate;
      this.sampleCounter = 0;
      this.accumulator = 0;
      return result;
    }

    return null;
  }

  /**
   * Read audio samples for playback.
   * This should be called by the audio playback system to get samples.
   * @param count - Number of samples to read
   * @returns Array of audio samples
   */
  readSamples(count: number): Float32Array {
    const samples = new Float32Array(count);
    const buffering = this.writeBuffIdx - this.readBuffIdx;
    const underBuffering = buffering < Audio.LOW_BUFFERING;
    const overBuffering = buffering > Audio.HIGH_BUFFERING;

    if (underBuffering) {
      // Fill with last sample when buffer is running low
      samples.fill(this.lastSample);
      // Adjust downsample rate: lower rate = more samples produced per input cycle
      this.downsampleRate = Math.max(1, this.downsampleRate - 1);
    } else {
      // Copy samples from buffer
      for (let i = 0; i < count; i++) {
        samples[i] = this.buffer[this.readBuffIdx % Audio.BUFFER_SIZE];
        this.readBuffIdx++;
      }

      if (overBuffering) {
        // Skip additional samples to catch up (on top of already read samples)
        this.readBuffIdx += count;
        // Adjust downsample rate: higher rate = fewer samples produced per input cycle
        this.downsampleRate++;
      }
    }

    return samples;
  }

  /**
   * Get the number of samples available in the buffer
   */
  getAvailableSamples(): number {
    return Math.max(0, this.writeBuffIdx - this.readBuffIdx);
  }

  /**
   * Get the current buffer fill level as a ratio (0.0 to 1.0+)
   */
  getBufferLevel(): number {
    return this.getAvailableSamples() / Audio.TARGET_BUFFERING;
  }

  /**
   * Get the last generated sample value
   */
  getLastSample(): number {
    return this.lastSample;
  }

  /**
   * Check if audio system is initialized
   */
  isInitialized(): boolean {
    return this.inited;
  }

  /**
   * Get the output sample rate
   */
  static getOutputRate(): number {
    return Audio.OUTPUT_RATE;
  }

  /**
   * Get the recommended buffer size for playback callbacks
   */
  static getRecommendedBufferSize(): number {
    return Audio.SDL_BUFFER;
  }
}

export default Audio;
