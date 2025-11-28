.org 0x100
  LXI SP, 0x8000
start:
  LXI H, 0x8000
  MVI B, 0x00
  CALL fill_scr

  LXI H, 0x8000
  MVI B, 0xFF
  CALL fill_scr
JMP start

; HL - start of screen memory
; B - value to fill with
fill_scr:
@loop:
  MOV M, B
  INX H
  MOV A, H
  ORA L
  JNZ @loop
  CALL pause
  RET

pause:
  MVI C, 0xFF
@loop:
  NOP
  DCR C
  JNZ @loop
  RET