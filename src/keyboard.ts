export class Keyboard {
  private encodingMatrix: number[] = new Array(8).fill(0);
  private keymap: Map<string, number> = new Map();
  public m_keySS = false; // shift
  public m_keyUS = false; // ctrl
  public m_keyRus = false; // alt/cmd

  constructor() {
    this.initMapping();
  }

  // action: 'down' | 'up'
  keyHandling(code: string, action: 'down' | 'up') {
    // special keys
    if (code === 'F11' && action === 'up') return 'RESET';
    if (code === 'F12' && action === 'up') return 'RESTART';
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.m_keySS = action === 'down'; return 'NONE'; }
    if (code === 'ControlLeft' || code === 'ControlRight') { this.m_keyUS = action === 'down'; return 'NONE'; }
    if (code === 'AltLeft' || code === 'AltRight' || code === 'MetaLeft') { this.m_keyRus = action === 'down'; return 'NONE'; }

    const mapped = this.keymap.get(code);
    if (mapped === undefined) return 'NONE';

    const row = mapped >> 8;
    const colMask = mapped & 0xff;
    if (action === 'down') this.encodingMatrix[row] |= colMask;
    else this.encodingMatrix[row] &= ~colMask;
    return 'NONE';
  }

  // rows: bitmask where 0 bit means the row is selected (active-low). Returns ~encoded result like C++
  read(rows: number): number {
    let result = 0;
    for (let row = 0; row < 8; row++) {
      const rowBit = 1 << row;
      if ((rows & rowBit) === 0) {
        result |= this.encodingMatrix[row];
      }
    }
    return (~result) & 0xff;
  }

  private initMapping() {
    // Map DOM KeyboardEvent.code values to row<<8 | (1<<column) based on C++ mapping
    const map = (code: string, rowCol: number) => this.keymap.set(code, rowCol);

    // Row 7
    map('Space', 0x780); // SPC
    map('Backquote', 0x701); // ` (mapped as @ in C++ minus)
    map('BracketRight', 0x720);
    map('Backslash', 0x710);
    map('BracketLeft', 0x708);
    map('KeyZ', 0x704);
    map('KeyY', 0x702);
    map('KeyX', 0x701);

    // Row 6
    map('KeyW', 0x680);
    map('KeyV', 0x640);
    map('KeyU', 0x620);
    map('KeyT', 0x610);
    map('KeyS', 0x608);
    map('KeyR', 0x604);
    map('KeyQ', 0x602);
    map('KeyP', 0x601);

    // Row 5
    map('KeyO', 0x580);
    map('KeyN', 0x540);
    map('KeyM', 0x520);
    map('KeyL', 0x510);
    map('KeyK', 0x508);
    map('KeyJ', 0x504);
    map('KeyI', 0x502);
    map('KeyH', 0x501);

    // Row 4
    map('KeyG', 0x480);
    map('KeyF', 0x440);
    map('KeyE', 0x420);
    map('KeyD', 0x410);
    map('KeyC', 0x408);
    map('KeyB', 0x404);
    map('KeyA', 0x402);
    map('Minus', 0x401);

    // Row 3
    map('Slash', 0x380);
    map('Period', 0x340);
    map('Equal', 0x320);
    map('Comma', 0x310);
    map('Semicolon', 0x308);
    map('Quote', 0x304);
    map('Digit9', 0x302);
    map('Digit8', 0x301);

    // Row 2
    map('Digit7', 0x280);
    map('Digit6', 0x240);
    map('Digit5', 0x220);
    map('Digit4', 0x210);
    map('Digit3', 0x208);
    map('Digit2', 0x204);
    map('Digit1', 0x202);
    map('Digit0', 0x201);

    // Row 1 (F keys / escape)
    map('F5', 0x180);
    map('F4', 0x140);
    map('F3', 0x120);
    map('F2', 0x110);
    map('F1', 0x108);
    map('Escape', 0x104);
    map('F8', 0x102);
    map('F7', 0x101);

    // Row 0 (arrows and others)
    map('ArrowDown', 0x080);
    map('ArrowRight', 0x040);
    map('ArrowUp', 0x020);
    map('ArrowLeft', 0x010);
    map('Backspace', 0x008);
    map('Enter', 0x004);
    map('AltRight', 0x002);
    map('Tab', 0x001);
  }
}

export default Keyboard;
