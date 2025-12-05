import { DebugSession, InitializedEvent, StoppedEvent, TerminatedEvent, Thread, StackFrame, Scope, Source, Handles, Variable } from 'vscode-debugadapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emulator } from './emulator';
import { assemble } from './assembler';
import { HardwareReq } from './emulator/hardware_reqs';

class I8080DebugSession extends DebugSession {
  private emulator: Emulator | null = null;
  private sourceMap: Record<number, number> = {};
  private breakpoints = new Set<number>();

  public constructor() {
    super();
  }

  protected initializeRequest(response: any, args: any): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected launchRequest(response: any, args: any): void {
    const program = args.program;
    if (!program) {
      this.sendErrorResponse(response, 1, 'No program provided');
      return;
    }

    let bin: Buffer | null = null;
    let romPath = program;
    if (program.endsWith('.asm')) {
      const src = fs.readFileSync(program, 'utf8');
      const res = assemble(src);
      if (!res.success || !res.output) { this.sendErrorResponse(response, 2, 'Assemble failed'); return; }
      bin = res.output as Buffer;
      this.sourceMap = res.map || {};
      // write assembled binary to a temp ROM file and use that path
      const tmp = path.join(os.tmpdir(), `vscode_vector_${Date.now()}.rom`);
      fs.writeFileSync(tmp, bin);
      romPath = tmp;
    } else {
      this.sourceMap = {};
    }

    // Construct Emulator and load the ROM via constructor
    this.emulator = new Emulator('', {}, romPath);

    this.sendResponse(response);
  }

  protected setBreakPointsRequest(response: any, args: any): void {
    this.breakpoints.clear();
    const src = args.source.path || '';
    const clientBPs = args.breakpoints || [];
    for (const bp of clientBPs) {
      // map source line to address if possible
      const line = bp.line;
      const addr = this.sourceMap[line] ?? -1;
      if (addr >= 0) this.breakpoints.add(addr);
    }

    // ack
    response.body = { breakpoints: clientBPs.map((b: any) => ({ verified: true, line: b.line })) };
    this.sendResponse(response);
  }

  protected threadsRequest(response: any): void {
    // single thread
    response.body = { threads: [ new Thread(1, 'i8080') ] };
    this.sendResponse(response);
  }

  protected stackTraceRequest(response: any, args: any): void {
    const frames: StackFrame[] = [];
    if (this.emulator) {
      const pc = this.emulator.hardware?.cpu?.state.regs.pc.word ?? 0;
      // Find all lines that map to this PC address, then pick the highest line number.
      // This ensures we highlight the actual code line, not the label preceding it.
      const matchingLines = Object.keys(this.sourceMap)
        .map(k => parseInt(k))
        .filter(lineNum => this.sourceMap[lineNum] === pc);
      const lineNum = matchingLines.length > 0 ? Math.max(...matchingLines) : 1;
      frames.push(new StackFrame(1, 'main', new Source('program', args && args.source ? args.source.path : undefined), lineNum, 0));
    }
    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected scopesRequest(response: any, args: any): void {
    const scopes = [ new Scope('Registers', this.createVariableHandle('regs'), false) ];
    response.body = { scopes };
    this.sendResponse(response);
  }

  private handleId = 1;
  private handleMap = new Map<any, number>();
  private reverseHandle = new Map<number, any>();

  private createVariableHandle(obj: any) {
    const id = this.handleId++;
    this.handleMap.set(obj, id);
    this.reverseHandle.set(id, obj);
    return id;
  }

  protected variablesRequest(response: any, args: any): void {
    const variables: any[] = [];
    const handle = args.variablesReference;
    const obj = this.reverseHandle.get(handle);
    if (obj === 'regs' || obj === 'regsHandle' || obj === undefined) {
      if (!this.emulator || !this.emulator.hardware?.cpu?.state) { response.body = { variables }; this.sendResponse(response); return; }
      const r = this.emulator.hardware.cpu.state.regs;
      const regs: Array<[string, number]> = [['A', r.af.a], ['B', r.bc.h], ['C', r.bc.l], ['D', r.de.h], ['E', r.de.l], ['H', r.hl.h], ['L', r.hl.l], ['PC', r.pc.word], ['SP', r.sp.word]];
      for (const [k, v] of regs) {
        variables.push({ name: k, value: (v ?? 0).toString(), variablesReference: 0 });
      }
      variables.push({ name: 'Z', value: (r.af.z ? '1' : '0'), variablesReference: 0 });
    }
    response.body = { variables };
    this.sendResponse(response);
  }

  protected continueRequest(response: any, args: any): void {
    if (!this.emulator) { this.sendResponse(response); return; }
    // Execute a single frame (synchronous) and then report stopped or breakpoint
    try {
      this.emulator.hardware?.Request(HardwareReq.STOP);
      this.emulator.hardware?.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
    } catch (e) { /* ignore execution errors */ }

    const pc = this.emulator.hardware?.cpu?.state.regs.pc.word ?? 0;
    if (this.breakpoints.has(pc)) this.sendEvent(new StoppedEvent('breakpoint', 1));
    else this.sendEvent(new StoppedEvent('step', 1));
    this.sendResponse(response);
  }

  protected nextRequest(response: any, args: any): void {
    if (!this.emulator) { this.sendResponse(response); return; }
    try {
      this.emulator.hardware?.Request(HardwareReq.EXECUTE_INSTR);
    } catch (e) { /* ignore */ }
    const halted = this.emulator.hardware?.cpu?.state.ints?.hlta ?? false;
    if (halted) this.sendEvent(new TerminatedEvent());
    else this.sendEvent(new StoppedEvent('step', 1));
    this.sendResponse(response);
  }

  protected disconnectRequest(response: any, args: any): void {
    this.sendResponse(response);
  }
}

DebugSession.run(I8080DebugSession);
