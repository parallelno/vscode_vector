.org 0x100
  LXI SP, 0x8000

  LXI H, 0x8000
; HL - start of screen memory
; B - value to fill with
fill_scr:
  MVI M, 0xFF
  INX H
  MOV A, H
  ORA L
  JNZ fill_scr
  DI
  HLT