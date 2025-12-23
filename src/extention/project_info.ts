import path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as ext_consts from './consts';
import * as ext_utils from './utils';

// Project file structure
export class ProjectInfo {
  /** Project name. Used as the base name for output ROM files */
  name: string = 'NewProject';
  /** Path to the main assembly source file */
  asmPath: string | undefined = undefined;
  /** Path to the output debug file (tokens, breakpoints, etc source metadata) */
  debugPath: string | undefined = undefined;
  /** Path to the output ROM file */
  romPath: string | undefined = undefined;
  /** Path to the FDD data file for persistence */
  fddPath: string | undefined = undefined;
  /** Project settings */
  settings: ProjectSettings = new ProjectSettings();
  /** project absolute path. this setting is not stored to project file */
  absolute_path: string | undefined = undefined;
  /** Status message from last operation on this project.
   * This setting is not stored to project file  */
  error: string = '';


  constructor(input: string | Partial<ProjectInfo>) {
    if (typeof input === 'string') {
      if (!input ||
        !path.isAbsolute(input)) {
          this.error = `Project path is not absolute: ${input}`;
      }
      this.absolute_path = input;
      this.name = this.nameFromPath!;
    }
    else if (typeof input === 'object') {
      Object.assign(this, input);
      if (!this.name && this.absolute_path) {
        this.name = this.nameFromPath!;
      }
    }
  }

  save(): void {
    if (!this.absolute_path ||
      !path.isAbsolute(this.absolute_path))
    {
        this.error = 'Project save error: absolute_path is not set or invalid';
        return;
    }
    try {
      let text = JSON.stringify(this, null, 4);
      let obj = JSON.parse(text);
      // Remove non-stored fields
      delete obj.absolute_path;
      delete obj.error;
      fs.writeFileSync(this.absolute_path, JSON.stringify(obj, null, 4), 'utf8');
    } catch (err) {
      this.error = `Project save error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  load(): void {
    if (!this.absolute_path ||
      !path.isAbsolute(this.absolute_path) ||
      !fs.existsSync(this.absolute_path))
    {
        this.error = `Project load error: absolute_path is not set, invalid or file does not exist: ${this.absolute_path}`;
        return;
    }
    const { obj, error } = loadProjectObj(this.absolute_path);

    if (error) {
      this.error = error;
      return;
    }
    Object.assign(this, obj);
  }


  static async createFromFile(
    projectAbsolutePath: string)
    : Promise<ProjectInfo>  {

    let project = new ProjectInfo(projectAbsolutePath);
    if (project.error){
      return project;
    }

    if (!fs.existsSync(projectAbsolutePath)) {
        project.error = `Project file does not exist: ${projectAbsolutePath}`;
        return project;
    }

    const { obj, error } = loadProjectObj(projectAbsolutePath);
    project.error = error;
    if (error) {
      return project;
    }

    Object.assign(project, obj);
    return project;
  }


  get programPath(): string {
    return this.fddPath || this.romPath || '';
  }

  init_asm_path(): ProjectInfo {
    if (!this.asmPath){
      this.asmPath = ext_consts.MAIN_ASM;
    }
    return this;
  }
  init_debug_path(): ProjectInfo {
    if (!this.debugPath){
      this.debugPath = path.basename(this.name) + ext_consts.DEBUG_FILE_SUFFIX;
    }
    return this;
  }
  init_rom_path(): ProjectInfo {
    if (!this.romPath){
      this.romPath = path.basename(this.name) + ext_consts.EXT_ROM;
    }
    return this;
  }
  init_ram_disk_path(): ProjectInfo {
    if (!this.settings.ramDiskPath){
      this.settings.ramDiskPath = path.basename(this.name) + ext_consts.RAM_DISK_FILE_SUFFIX;
    }
    return this;
  }
  get absolute_asm_path(): string | undefined {
    if (!this.absolute_path || !this.asmPath) return undefined;
    return path.isAbsolute(this.asmPath)
      ? this.asmPath
      : path.join(this.projectDir!, this.asmPath);
  }
  get absolute_debug_path(): string | undefined {
    if (!this.absolute_path || !this.debugPath) return undefined;
    return path.isAbsolute(this.debugPath)
      ? this.debugPath
      : path.join(this.projectDir!, this.debugPath);
  }
  get absolute_rom_path(): string | undefined {
    if (!this.absolute_path || !this.romPath) return undefined;
    return path.isAbsolute(this.romPath)
      ? this.romPath
      : path.join(this.projectDir!, this.romPath);
  }
  get absolute_fdd_path(): string | undefined {
    if (!this.absolute_path || !this.fddPath) return undefined;
    return path.isAbsolute(this.fddPath)
      ? this.fddPath
      : path.join(this.projectDir!, this.fddPath);
  }
  get absolute_ram_disk_path(): string | undefined {
    if (!this.absolute_path || !this.settings.ramDiskPath) return undefined;
    return path.isAbsolute(this.settings.ramDiskPath)
      ? this.settings.ramDiskPath
      : path.join(this.projectDir!, this.settings.ramDiskPath);
  }
  get projectDir(): string | undefined {
    if (!this.absolute_path) return undefined;
    return path.dirname(this.absolute_path);
  }
  get relative_path(): string | undefined {
    return this.absolute_path
      ? path.relative(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', this.absolute_path)
      : undefined;
  }

  get nameFromPath(): string | undefined {
    if (!this.absolute_path) return undefined;
    let basename = path.basename(this.absolute_path, path.extname(this.absolute_path));
    return basename.split('.')[0];
  }
};

function loadProjectObj(
  projectAbsolutePath: string)
  : { obj : any, error: string }
{
  let text: string = '';
  let error: string = '';
  try {
    text = fs.readFileSync(projectAbsolutePath, 'utf8');
  } catch (err) {
    error = `Devector: Failed to load ${projectAbsolutePath}: ${err instanceof Error ? err.message : String(err)}`;
    return { obj: undefined, error };
  }

  if (!text || !text.trim().length) {
    error = `Devector: Project file is empty: ${projectAbsolutePath}`;
    return { obj: undefined, error };
  }

  let rawInfo: any;
  try {
    rawInfo = JSON.parse(text);
  } catch (err) {
    error = `Failed to parse ${projectAbsolutePath}: ${err instanceof Error ? err.message : String(err)}`;
    return { obj: undefined, error };
  }
  return { obj: rawInfo, error: error };
}



export class ProjectSettings {
  /** Emulation speed multiplier (e.g., 1, 2, 4) or 'max' for maximum speed */
  private _speed?: number | 'max' = undefined;
  /** View mode for display rendering: 'full' (768×312) or 'noBorder' (256×256 4:3 aspect) */
  private _viewMode?: 'full' | 'noBorder' = undefined;
  /** Path to the RAM disk data file for persistence */
  private _ramDiskPath?: string = undefined;
  /** Clear RAM disk data on emulator restart */
  private _ramDiskClearAfterRestart?: boolean | undefined = undefined;
  /** Floppy drive index to load fdd (0-3) */
  private _fddIdx?: number | undefined = undefined;
  /** Automatically boot FDD if pfddPath is set */
  private _autoBoot?: boolean | undefined = undefined;
  /** Open FDD in read-only mode */
  private _fddReadOnly?: boolean | undefined = undefined;

  get speed(): number | 'max' {
    return this._speed ?? 1;
  }
  get viewMode(): 'full' | 'noBorder' {
    return this._viewMode ?? 'noBorder';
  }
  get ramDiskPath(): string | undefined {
    return this._ramDiskPath ?? undefined;
  }
  get ramDiskClearAfterRestart(): boolean {
    return this._ramDiskClearAfterRestart ?? true;
  }
  get fddIdx(): number {
    return this._fddIdx ?? 0;
  }
  get autoBoot(): boolean {
    return this._autoBoot ?? true;
  }
  get fddReadOnly(): boolean {
    return this._fddReadOnly ?? true;
  }
  set speed(value: number | 'max') {
    this._speed = value;
  }
  set viewMode(value: 'full' | 'noBorder') {
    this._viewMode = value;
  }
  set ramDiskPath(value: string | undefined) {
    this._ramDiskPath = value;
  }
  set ramDiskClearAfterRestart(value: boolean) {
    this._ramDiskClearAfterRestart = value;
  }
  set fddIdx(value: number) {
    this._fddIdx = value;
  }
  set autoBoot(value: boolean) {
    this._autoBoot = value;
  }
  set fddReadOnly(value: boolean) {
    this._fddReadOnly = value;
  }
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////