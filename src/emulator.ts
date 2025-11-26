import { Hardware } from './hardware';
import { HardwareReq } from './hardware_reqs';
import * as pathModule from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ROM_LOAD_ADDR } from './memory';

export type SettingsType = { [key: string]: any };


export class Emulator {
  private readonly EXT_ROM: string = ".ROM";
  private readonly EXT_FDD: string = ".FDD";
  private readonly EXT_REC: string = ".REC";

  _hardware?: Hardware;

  ramDiskClearAfterRestart = true;
  // TODO: add ramDiskDataPath to settings
  ramDiskDataPath: string | null = null;

  constructor(settingsPath: string, settings: SettingsType, romFddRecPath: string) {
    this.Init(romFddRecPath);
  }

  Init(romFddRecPath: string) {
    this.HardwareInit();
    this.Load(romFddRecPath);
  }

  HardwareInit() {
    let pathBootData: string = "";
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      pathBootData = vscode.Uri.file(pathModule.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'boot//boot.bin')).fsPath;
    }
    // TODO: load these from settings
    this.ramDiskDataPath = null;
    // TODO: load these from settings
    this.ramDiskClearAfterRestart = true;
    this._hardware = new Hardware(pathBootData, this.ramDiskDataPath ?? '', this.ramDiskClearAfterRestart);
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

    if (ext == this.EXT_ROM)
    {
      this.LoadRom(path);
    }
    else if (ext == this.EXT_FDD)
    {
      // TODO: implement FDD handling
      // RecentFilesUpdate(FileType::FDD, path, 0, true);
    }
    else if (ext == this.EXT_REC)
    {
      // TODO: implement REC handling
      // LoadRecording(path);
    }
    else {
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

  get hardware(): Hardware | undefined { return this._hardware; }

}
