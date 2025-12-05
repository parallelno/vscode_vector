import Breakpoints from './emulator/breakpoints';
import { Hardware } from './emulator/hardware';


export default class DebugData {
  hardware: Hardware;
  _breakpoints = new Breakpoints();


  constructor(hardware: Hardware)
  {
    this.hardware = hardware;
  }

  Reset() {
    // TODO: implement reset logic
    // this.memRuns.fill(0);
    // this.memReads.fill(0);
    // this.memWrites.fill(0);
  }

  get breakpoints(): Breakpoints {
    return this._breakpoints;
  }
}