import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import * as pathModule from 'path';
import * as fs from 'fs';
import { ROM_LOAD_ADDR } from './emulator/memory';
import Debugger from './emulator/debugger';
import { FdcDiskImage, FDD_SIZE } from './emulator/fdc_wd1793';
import { ProjectInfo } from './extention/project_info';
import * as type from './emulator/type';


// Extension thread.
// Use Hardware.Request(HardwareReq....) to interact with Hardware.
// Use Hardware.Request(HardwareReq.DEBUG_...) to interact with Debugger.
export class Emulator {
  private BOOT_ROM_PATH: string = "res/boot/boot.bin";

  private _hardware?: Hardware;
  private _debugger?: Debugger;
  private _project?: ProjectInfo = undefined;

  result: type.EmulatorResult = new type.EmulatorResult();


  constructor(
    extensionPath: string, project: ProjectInfo)
  {
    this._project = project;
    this.result.add(this.HardwareInit(extensionPath));
    if (!this.result.success) return;
    this.result.add(this.Load());
  }

  Destructor(){
    this._hardware?.Destructor();
    this.SaveRamDisk();
    this.SaveFdds();
  }


    private HardwareInit(extensionPath: string): type.EmulatorResult
  {
    let result = new type.EmulatorResult();

    if (!this._project) {
      return result.addError("Project info was not provided");
    }

    const bootRomPath = pathModule.resolve(extensionPath, this.BOOT_ROM_PATH);
    const bootRom = this.LoadBootRom(bootRomPath);
    if (!bootRom) {
      result.addWarning(`Cannot load Boot ROM file: ${bootRomPath}`);
    }
    const ramDisk = this.LoadRamDisk(this._project.absolute_ram_disk_path!);
    if (this._project.settings.ramDiskPath && !ramDisk) {
      result.addWarning(`Cannot load RAM disk file: ${this._project.absolute_ram_disk_path!}`);
    }
    this._hardware = new Hardware(bootRom, ramDisk, this._project.settings.ramDiskClearAfterRestart);
    this._debugger = new Debugger(this._hardware);

    return result;
  }


  // Extension thread. HW thread must be stopped before calling this
  Load(): type.EmulatorResult
  {
    let result = new type.EmulatorResult();

    if (!this._project) {
      return result.addError("Project info was not provided");
    }

    // Load Fdd image
    if (this._project.absolute_fdd_path){
      if (!fs.existsSync(this._project.absolute_fdd_path)) {
        return result.addError(`Invalid FDD filepath: ${this._project.absolute_fdd_path}`);
      }
      const fddIdx = this._project.settings.fddIdx || 0;
      const autoBoot = this._project.settings.autoBoot || true;
      result.add(this.LoadFdd(this._project.absolute_fdd_path!, fddIdx, autoBoot));
    }
    // If no FDD image, load ROM file
    else if (this._project.absolute_rom_path){
      if (!fs.existsSync(this._project.absolute_rom_path!)) {
        return result.addError(`Invalid ROM filepath: ${this._project.absolute_rom_path!}`);
      }
      result.add(this.LoadRom(this._project.absolute_rom_path!));
    }
    return result;
  }


  // Extention thread
  // HW thread must be stopped before calling this
  private LoadBootRom(bootRomPath: string): Uint8Array | undefined
  {
    let bootRom: Uint8Array | undefined = undefined;
    if (bootRomPath && fs.existsSync(bootRomPath)) {
      bootRom = fs.readFileSync(bootRomPath);
    }
    return bootRom;
  }


  // Extension thread
  private LoadRom(path: string): type.EmulatorResult
  {
    let result = new type.EmulatorResult();
    if (!path || !fs.existsSync(path)) return result.addError(`Invalid ROM filepath: ${path}`);

    this._hardware?.Request(HardwareReq.STOP);
    this._hardware?.Request(HardwareReq.RESET);
    this._hardware?.Request(HardwareReq.RESTART);

    const data = fs.readFileSync(path);
    const buff = new Uint8Array(data);
    if (!buff || buff.length === 0) {
      return result.addError(`Cannot read ROM file: ${path}. Ensure the file exists.`);
    }

    const reqData = { "data": buff, "addr": ROM_LOAD_ADDR };
    this._hardware?.Request(HardwareReq.SET_MEM, reqData);

    // has to be called after Hardware loading Rom because it stores the last state of Hardware
    this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true });

    // TODO: implement if still needed
    //this.debugger?.GetDebugData().LoadDebugData(path);

    return result;
  }


  // Extension thread
  // Returns old FDD image if any
	private LoadFdd(path: string, fddIdx: number = 0, autoBoot: boolean = true)
  : type.EmulatorResult
  {
    let result = new type.EmulatorResult();

    if (!this._project) {
      return result.addError("Project info was not provided");
    }

    const buffer = fs.readFileSync(path);
    let fddimg = new Uint8Array(buffer);
    if (!fddimg || fddimg.length === 0) {
      return result.addError(`FDD image is invalid or empty: ${path}.`);
    }

    if (fddimg.length > FDD_SIZE) {
      result.addWarning(`Fdc1793 Warning: disk image is too big. Loaded first ${FDD_SIZE} bytes. ` +
            `Original size: ${fddimg.length}, path: ${path}`);
      fddimg = fddimg.slice(0, FDD_SIZE);
    }

    this._hardware?.Request(HardwareReq.STOP);

    // loading the fdd data
    const fdcDiskImage: FdcDiskImage = {fddIdx: fddIdx, data: fddimg, path: path};
    const old_img = this._hardware?.Request(
      HardwareReq.MOUNT_FDD, {"data": fdcDiskImage})["data"] as FdcDiskImage;

    // TODO: check if we still need this
    //this._debugger?.GetDebugData().LoadDebugData(_path);

    if (autoBoot)
    {
      this._hardware?.Request(HardwareReq.RESET);
      // has to be called after Hardware loading FDD
      // image because it stores the last state of Hardware
      this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true });
    }

    result.addPrintMessage(`Loaded FDD ${path}, index: ${fddIdx}, autoBoot: ${autoBoot}`);

    // save old fdd to the disk
    if (!this._project.settings.fddReadOnly && old_img.data.length > 0) {
      fs.writeFileSync(old_img.path, old_img.data);
      result.addPrintMessage(`Saved old FDD image to path: ${old_img.path}`);
    }
    return result;
  }


  // Extention thread
  // HW thread must be stopped before calling this
  private SaveFdds(): type.EmulatorResult {
    let result = new type.EmulatorResult();
    const fdd_imgs = this._hardware?.Request(HardwareReq.DISMOUNT_FDD_ALL)["data"] as FdcDiskImage[] | undefined;
    if (fdd_imgs) {
      for (const fdd_img of fdd_imgs){
        fs.writeFileSync(fdd_img.path, fdd_img.data);
        result.addPrintMessage(`Saved FDD image to path: ${fdd_img.path}`);
      }
    }
    return result;
  }


  // Extention thread
  // HW thread will be paused while loading
  LoadRamDisk(ramDiskPath?: string): Uint8Array | undefined
  {
    const isRunning = this._hardware?.Request(HardwareReq.IS_RUNNING);
    this._hardware?.Request(HardwareReq.STOP);

    let ramDisk: Uint8Array | undefined = undefined;
    if (!ramDiskPath || !fs.existsSync(ramDiskPath)) {
      return ramDisk;
    }
    ramDisk = fs.readFileSync(ramDiskPath);
    if (isRunning) this._hardware?.Request(HardwareReq.RUN);
    return ramDisk;
  }


  // Extention thread
  // HW thread will be paused while saving
  SaveRamDisk(): type.EmulatorResult
  {
    let result = new type.EmulatorResult();
    if (!this._project) return result.addError("Settings was not inited");

    if (!this._project.settings.ramDiskClearAfterRestart && this._project.settings.ramDiskPath)
    {
      const ramDisk = this._hardware?.Request(HardwareReq.GET_RAM_DISK)["data"] as Uint8Array | undefined;
      if (ramDisk)
      {
        const isRunning = this._hardware?.Request(HardwareReq.IS_RUNNING);
        this._hardware?.Request(HardwareReq.STOP);
        fs.writeFileSync(this._project.absolute_ram_disk_path!, ramDisk);
        result.addPrintMessage(`Saved RAM disk to path: ${this._project.absolute_ram_disk_path!}`);
        if (isRunning) this._hardware?.Request(HardwareReq.RUN);
      }
    }
    return result;
  }

  get hardware(): Hardware | undefined { return this._hardware; }
}
