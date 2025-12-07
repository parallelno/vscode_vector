type KeyCode = string;
type RowColumnCode = number;
export enum KbOperation {
  NONE = 0,
  RESET = 1,
  RESTART = 2
}

export class Keyboard
{
  private encodingMatrix: Uint8Array = new Uint8Array(8).fill(0);
  private keymap: Map<KeyCode, RowColumnCode> = new Map();

  public keySS = false; // key on russian keyboard 'CC'
  public keyUS = false; // key on russian keyboard 'УС'
  public keyRus = false; // key on russian keyboard 'Рус Lat'

  rebootType: KbOperation = KbOperation.NONE;

  constructor() {
    this.InitMapping();
  }

  KeyHandling(code: string, action: string): KbOperation
  {
    switch (code) {
      case 'F11': // BLK + VVOD functionality
        if (action === 'up') return KbOperation.RESET;
        break;
      case 'F12': // BLK + SBR functionality
        if (action === 'up') return KbOperation.RESTART;
        break;
      case 'ShiftLeft': // SS (shift) key
      case 'ShiftRight':
        this.keySS = action === 'down';
        break;
      case 'ControlLeft': // US (ctrl) key
      case 'ControlRight':
        this.keyUS = action === 'down';
        break;
      case 'AltLeft': // RUS/LAT (cmd) key
      case 'AltRight':
      case 'MetaLeft':
      case 'F6':
        this.keyRus = action === 'down';
        break;
      default:
        const mapped = this.keymap.get(code);
        if (mapped != undefined)
        {
          const row = mapped >> 8;
          const column = mapped & 0xff;
          if (action === 'up') this.encodingMatrix[row] &= ~column;
          else this.encodingMatrix[row] |= column;
        }
    }

    return KbOperation.NONE;
  }

  // rows: bitmask where 0 bit means the row is selected (active-low). Returns ~encoded result like C++
  Read(rows: number): number {
    let result = 0;
    for (let row = 0; row < 8; row++) {
      const rowBit = 1 << row;
      result |= (rows & rowBit) == 0 ? this.encodingMatrix[row] : 0;
    }
    return (~result) & 0xff;
  }

  private InitMapping() {
    // Map DOM KeyboardEvent.code values to row<<8 | (1<<column) based on C++ mapping
    // Keyboard encoding matrix:
    //              columns
    //     │ 7   6   5   4   3   2   1   0
    // ────┼───────────────────────────────
    //   7 │SPC  ^   ]   \   [   Z   Y   X
    //   6 │ W   V   U   T   S   R   Q   P
    // r 5 │ O   N   M   L   K   J   I   H
    // o 4 │ G   F   E   D   C   B   A   @
    // w 3 │ /   .   =   ,   ;   :   9   8
    // s 2 │ 7   6   5   4   3   2   1   0
    //   1 │F5  F4  F3  F2  F1  AR2 STR LDA,
    //   0 │DN  RT  UP  LFT ZB  VK  PS  TAB
    //
    // LDA - left diagonal arrow
    const map = (code: string, rowCol: number) => this.keymap.set(code, rowCol);

    // KeyCode, RowColumnCode = row<<8 | 1<<column
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
    map('Minus', 0x401); // '@'

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
    map('Escape', 0x104); // AR2
    map('F8', 0x102);     // STR
    map('F7', 0x101);     // LDA, left diagonal arrow

    // Row 0 (arrows and others)
    map('ArrowDown', 0x080);
    map('ArrowRight', 0x040);
    map('ArrowUp', 0x020);
    map('ArrowLeft', 0x010);
    map('Backspace', 0x008);  // ZB
    map('Enter', 0x004);      // VK
    map('AltRight', 0x002);   // PS
    map('Tab', 0x001);        // TAB
  }
}

export default Keyboard;
