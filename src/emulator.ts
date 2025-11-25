import Hardware from './hardware';

export type SettingsType = { [key: string]: any };

// Thin wrapper kept for compatibility: previous code imported `{ Emulator }` from
// `./emulator`. We expose `Emulator` which composes the new `CPU` class and
// forwards the commonly used properties and methods (memory, regs, load,
// runCycles, breakpoints, cycles).
export class Emulator {

  hardware: Hardware;

  ramDiskDataPath: string|null = null;
  ramDiskClearAfterRestart = false;

  constructor(settingsPath: string, settings: SettingsType, romFddRecPath: string) {
    this.Init();
  }

  Init() {
    this.HardwareInit();
  }

  HardwareInit() {
    const pathBootData = 'boot//boot.bin';
    this.ramDiskDataPath = null;
    this.ramDiskClearAfterRestart = false;
    this.hardware = new Hardware(pathBootData, this.ramDiskDataPath, this.ramDiskClearAfterRestart);
  }
}
