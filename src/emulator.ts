import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import * as pathModule from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ROM_LOAD_ADDR } from './emulator/memory';
import Debugger from './emulator/debugger';
import { FDD_SIZE } from './emulator/fdc_wd1793';

export type EmulatorSettings = { 
  ramDiskDataPath?: string;
  ramDiskClearAfterRestart?: boolean;
  fddDataPath?: string;
  [key: string]: any;
};


export class Emulator {
  private readonly EXT_ROM: string = ".ROM";
  private readonly EXT_FDD: string = ".FDD";
  private readonly EXT_REC: string = ".REC";

  private _hardware?: Hardware;
  private _debugger?: Debugger;

  ramDiskClearAfterRestart = true;
  ramDiskDataPath: string | null = null;
  fddDataPath: string | null = null;

  constructor(extensionPath: string, settingsPath: string, settings: EmulatorSettings, romFddRecPath: string) {
    // Load settings
    if (settings.ramDiskDataPath !== undefined) {
      this.ramDiskDataPath = settings.ramDiskDataPath;
    }
    if (settings.ramDiskClearAfterRestart !== undefined) {
      this.ramDiskClearAfterRestart = settings.ramDiskClearAfterRestart;
    }
    if (settings.fddDataPath !== undefined) {
      this.fddDataPath = settings.fddDataPath;
    }
    this.Init(extensionPath, romFddRecPath);
  }

  Init(extensionPath: string, romFddRecPath: string) {
    const path = pathModule.resolve(romFddRecPath);
    const ext = pathModule.extname(path).toUpperCase();

    this.HardwareInit(extensionPath, ext === this.EXT_FDD);
    this.Load(romFddRecPath);
  }

  HardwareInit(extensionPath: string, bootLoad: boolean) {
    let pathBootData: string = "";
    if (bootLoad) {
      pathBootData = pathModule.join(extensionPath, 'res', 'boot', 'boot.bin');
    }

    this._hardware = new Hardware(pathBootData, this.ramDiskDataPath ?? '', this.ramDiskClearAfterRestart, this.fddDataPath ?? '');
    this._debugger = new Debugger(this._hardware);
  }

  BeforeLoad(){
    this._hardware?.Request(HardwareReq.STOP);
    this._hardware?.Request(HardwareReq.RESET);
    this._hardware?.Request(HardwareReq.RESTART);
  }

  RunAfterLoad(){
    this._hardware?.Request(HardwareReq.RUN);
  }

  Load(romFddRecPath: string)
  {
    // load the rom/fdd/rec image if it was send via the console command
    if (!romFddRecPath) return;

    const path = pathModule.resolve(romFddRecPath);
    const ext = pathModule.extname(path).toUpperCase();

    switch(ext){
      case this.EXT_ROM:
        this.LoadRom(path);
        break;
      case this.EXT_FDD:
        // TODO: send this as parameters: driveIdx, autoBoot
        this.LoadFdd(path);
        break;
      case this.EXT_REC:
        // TODO: implement REC handling
        // LoadRecording(path);
        break;
      default:
        console.debug("Unsupported file type:", path);
        return;
    }
  }

  LoadRom(path: string)
  {
    const buffer = fs.readFileSync(path);
    const result = new Uint8Array(buffer);
    if (!result || result.length === 0) {
      console.log("Error occurred while loading the file. Path: " + path + ". " +
        "Please ensure the file exists and you have the correct permissions to read it.");
      return;
    }

    const reqData = { "data": result, "addr": ROM_LOAD_ADDR };
    this._hardware?.Request(HardwareReq.SET_MEM, reqData);

    //this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true }); // has to be called after Hardware loading Rom because it stores the last state of Hardware
    //this.debugger?.GetDebugData().LoadDebugData(path);
    //this.scheduler.AddSignal({dev::Signals::DISASM_UPDATE});

    console.log("File loaded: " + path);
  }



	LoadFdd(path: string, driveIdx: number = 0, autoBoot: boolean = true)
  {
    // If fddDataPath is set and exists, load from there instead of the original FDD file
    let loadPath = path;
    if (this.fddDataPath && fs.existsSync(this.fddDataPath)) {
      loadPath = this.fddDataPath;
      console.log(`Loading saved FDD data from ${this.fddDataPath}`);
    }

    const buffer = fs.readFileSync(loadPath);
    let fddimg = new Uint8Array(buffer);
    if (!fddimg || fddimg.length === 0) {
      console.log("Error occurred while loading the file. Path: " + loadPath + ". " +
        "Please ensure the file exists and you have the correct permissions to read it.");
      return;
    }

    if (fddimg.length > FDD_SIZE) {
      console.log("Fdc1793 Warning: disk image is too big. " +
        `It size will be concatenated to ${FDD_SIZE}. ` +
        `Original size: ${fddimg.length} bytes, path: ${loadPath}`);
      fddimg = fddimg.slice(0, FDD_SIZE);
    }

    if (autoBoot) this._hardware?.Request(HardwareReq.STOP);

    // loading the fdd data
    this._hardware?.Request(
      HardwareReq.LOAD_FDD, {"data": fddimg , "driveIdx": driveIdx, "path": path});

    // TODO: check if we still need this
    //this._debugger?.GetDebugData().LoadDebugData(_path);

    if (autoBoot)
    {
      this._hardware?.Request(HardwareReq.RESET);
      // has to be called after Hardware loading FDD
      // image because it stores the last state of Hardware
      this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true });

      // TODO: check if we still need this
      //this._scheduler.AddSignal({dev::Signals::DISASM_UPDATE});

      this._hardware?.Request(HardwareReq.RUN);
    }
  }

  get hardware(): Hardware | undefined { return this._hardware; }
  get debugger(): Debugger | undefined { return this._debugger; }

}
