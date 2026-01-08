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
  private _project?: ProjectInfo = undefined;

  result: type.EmulatorResult = new type.EmulatorResult();


  constructor(
    extensionPath: string, project: ProjectInfo)
  {
    this._project = project;
  }

  static async create(
    extensionPath: string,
    project: ProjectInfo): Promise<Emulator>
  {
    const emu = new Emulator(extensionPath, project);
    await emu.initialize(extensionPath);
    return emu;
  }

  private async initialize(extensionPath: string): Promise<void> {
    this.result.add(await this.HardwareInit(extensionPath));
    if (!this.result.success) return;
    this.result.add(await this.Load());
  }

  async Destructor(){
    await this._hardware?.Destructor();
    await this.SaveRamDisk();
    await this.SaveFdds();
  }


    private async HardwareInit(extensionPath: string): Promise<type.EmulatorResult>
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
    const ramDisk = await this.LoadRamDisk(this._project.absolute_ram_disk_path!);
    if (this._project.settings.RamDiskPath && !ramDisk) {
      result.addWarning(`Cannot load RAM disk file: ${this._project.absolute_ram_disk_path!}`);
    }
    this._hardware = new Hardware(bootRom, ramDisk);

    return result;
  }


  // Extension thread. HW thread must be stopped before calling this
  async Load(): Promise<type.EmulatorResult>
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
      const fddIdx = this._project.settings.FddIdx || 0;
      const autoBoot = this._project.settings.AutoBoot || true;
      result.add(await this.LoadFdd(this._project.absolute_fdd_path!, fddIdx, autoBoot));
    }
    // If no FDD image, load ROM file
    else if (this._project.absolute_rom_path){
      if (!fs.existsSync(this._project.absolute_rom_path!)) {
        return result.addError(`Invalid ROM filepath: ${this._project.absolute_rom_path!}`);
      }
      result.add(await this.LoadRom(this._project.absolute_rom_path!));
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
  private async LoadRom(path: string): Promise<type.EmulatorResult>
  {
    let result = new type.EmulatorResult();
    if (!path || !fs.existsSync(path)) return result.addError(`Invalid ROM filepath: ${path}`);

    await this._hardware?.Request(HardwareReq.STOP);
    await this._hardware?.Request(HardwareReq.RESET);
    await this._hardware?.Request(HardwareReq.RESTART);

    const data = fs.readFileSync(path);
    const buff = new Uint8Array(data);
    if (!buff || buff.length === 0) {
      return result.addError(`Cannot read ROM file: ${path}. Ensure the file exists.`);
    }

    const reqData = { "data": buff, "addr": ROM_LOAD_ADDR };
    await this._hardware?.Request(HardwareReq.SET_MEM, reqData);

    // has to be called after Hardware loading Rom because it stores the last state of Hardware
    await this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true });

    // TODO: implement if still needed
    //this.debugger?.GetDebugData().LoadDebugData(path);

    return result;
  }


  // Extension thread
  // Returns old FDD image if any
	private async LoadFdd(path: string, fddIdx: number = 0, autoBoot: boolean = true)
  : Promise<type.EmulatorResult>
  {
    let result = new type.EmulatorResult();

    if (!this._project) {
      return result.addError("Project info was not provided");
    }

    // Retrieve the old FDD image if any
    const old_resp = await this._hardware?.Request(
      HardwareReq.DISMOUNT_FDD, {"fddIdx": fddIdx});
    const old_img = old_resp?.data as FdcDiskImage;
    // save old fdd to the disk
    if (old_img && old_img.path && !this._project.settings.FddReadOnly) {
      fs.writeFileSync(old_img.path, old_img.data);
      result.addPrintMessage(`Saved old FDD image to path: ${old_img.path}`);
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

    await this._hardware?.Request(HardwareReq.STOP);

    // loading the fdd data
    const fdcDiskImage: FdcDiskImage = {"fddIdx": fddIdx, "data": fddimg, "path": path};
    await this._hardware?.Request(HardwareReq.MOUNT_FDD, fdcDiskImage);

    // TODO: check if we still need this
    //this._debugger?.GetDebugData().LoadDebugData(_path);

    if (autoBoot)
    {
      await this._hardware?.Request(HardwareReq.RESET);
      // has to be called after Hardware loading FDD
      // image because it stores the last state of Hardware
      await this._hardware?.Request(HardwareReq.DEBUG_RESET, { "resetRecorder": true });
    }

    result.addPrintMessage(`Loaded FDD ${path}, index: ${fddIdx}, autoBoot: ${autoBoot}`);

    return result;
  }


  // Extention thread
  // HW thread must be stopped before calling this
  private async SaveFdds(): Promise<type.EmulatorResult> {
    let result = new type.EmulatorResult();
    const resp = await this._hardware?.Request(HardwareReq.DISMOUNT_FDD_ALL);
    const fdd_imgs = resp?.["data"] as FdcDiskImage[] | undefined;
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
  async LoadRamDisk(ramDiskPath?: string): Promise<Uint8Array | undefined>
  {
    const isRunningResp = await this._hardware?.Request(HardwareReq.IS_RUNNING);
    await this._hardware?.Request(HardwareReq.STOP);

    let ramDisk: Uint8Array | undefined = undefined;
    if (!ramDiskPath || !fs.existsSync(ramDiskPath)) {
      return ramDisk;
    }
    ramDisk = fs.readFileSync(ramDiskPath);
    if (isRunningResp?.["isRunning"]) await this._hardware?.Request(HardwareReq.RUN);
    return ramDisk;
  }


  // Extention thread
  // HW thread will be paused while saving
  async SaveRamDisk(): Promise<type.EmulatorResult>
  {
    let result = new type.EmulatorResult();
    if (!this._project) return result.addError("Settings was not inited");

    if (this._project.settings.SaveRamDiskOnRestart && this._project.settings.RamDiskPath)
    {
      const ramDiskResp = await this._hardware?.Request(HardwareReq.GET_RAM_DISK);
      const ramDisk = ramDiskResp?.["data"] as Uint8Array | undefined;
      if (ramDisk)
      {
        const isRunningResp = await this._hardware?.Request(HardwareReq.IS_RUNNING);
        await this._hardware?.Request(HardwareReq.STOP);
        fs.writeFileSync(this._project.absolute_ram_disk_path!, ramDisk);
        result.addPrintMessage(`Saved RAM disk to path: ${this._project.absolute_ram_disk_path!}`);
        if (isRunningResp?.["isRunning"]) await this._hardware?.Request(HardwareReq.RUN);
      }
    }
    return result;
  }

  get hardware(): Hardware | undefined { return this._hardware; }
}
