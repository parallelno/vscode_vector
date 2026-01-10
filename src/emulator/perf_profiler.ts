import { performance } from 'perf_hooks';

class PerfSample {
  rasterizeMs = 0;
  cpuMs = 0;
  audioMs = 0;
  debugMs = 0;
}

export class PerfProfiler {
  private sampleEvery: number;
  private reportEvery: number;
  private accum: PerfSample = new PerfSample();
  private frameStart = performance.now();
  private lastReportFrame = 0;

  constructor()
  {
    const sampleRate = Number(process.env.VECTOR_PROFILE_RATE || '1000');
    const reportEvery = Number(process.env.VECTOR_PROFILE_REPORT || '50');
    this.sampleEvery = Math.max(1, Math.floor(sampleRate));
    this.reportEvery = Math.max(1, Math.floor(reportEvery));

    console.log(`[perf] profiler enabled sampleEvery=${sampleRate} reportEvery=${reportEvery}`);
  }

  shouldSample(cycle: number): boolean {
    return cycle % this.sampleEvery === 0;
  }

  recordSample(rasterizeMs: number, cpuMs: number, audioMs: number, debugMs: number = 0) {
    this.accum.rasterizeMs += rasterizeMs;
    this.accum.cpuMs += cpuMs;
    this.accum.audioMs += audioMs;
    this.accum.debugMs += debugMs;
  }

  onFrame(frameNum: number) {
    if (frameNum - this.lastReportFrame < this.reportEvery) return;
    const weight = this.sampleEvery;
    const rasterizeMs = this.accum.rasterizeMs * weight;
    const cpuMs = this.accum.cpuMs * weight;
    const audioMs = this.accum.audioMs * weight;
    const debugMs = this.accum.debugMs * weight;

    const frameMs = (performance.now() - this.frameStart);
    const emuMs = rasterizeMs + cpuMs + audioMs + debugMs;
    const overheadMs = Math.max(0, frameMs - emuMs);
    const toFramePct = (vMs: number) => frameMs > 0 ? (vMs / frameMs * 100) : 0;

    console.log(`[perf] f# ${frameNum}: ` +
      `f=${frameMs.toFixed(0)}ms ` +
      `ohead=${overheadMs.toFixed(0)}ms (${toFramePct(overheadMs).toFixed(1)}%) ` +
      `disp=${rasterizeMs.toFixed(0)}ms (${toFramePct(rasterizeMs).toFixed(1)}%) ` +
      `cpu=${cpuMs.toFixed(0)}ms (${toFramePct(cpuMs).toFixed(1)}%) ` +
      `aud=${audioMs.toFixed(0)}ms (${toFramePct(audioMs).toFixed(1)}%) ` +
      `dbg=${debugMs.toFixed(0)}ms (${toFramePct(debugMs).toFixed(1)}%)`);
    // reset window
    this.accum.audioMs = 0;
    this.accum.cpuMs = 0;
    this.accum.rasterizeMs = 0;
    this.accum.debugMs = 0;
    this.frameStart = performance.now();
    this.lastReportFrame = frameNum;
  }
}
