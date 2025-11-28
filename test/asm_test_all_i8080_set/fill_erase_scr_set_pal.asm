.org 0x100
    lxi sp, 0x8000
	  lxi h, 0x38
	  mvi m, 0xC3
	  lxi h, set_palette
	  shld 0x39
      ei
      hlt ; it invokes the set_palette routine

test_start:
  		MVI B, 0x00
  		CALL fill_scr
		hlt ; to capture the screen

  		MVI B, 0xFF
  		CALL fill_scr
end:
	  di
	  hlt ; end of program and for capture the final screen

PALETTE_LEN = 16

set_palette:
			lxi h, palette + PALETTE_LEN - 1
			mvi	a, 0x88
			out	0
			mvi	b, 0x0F

@loop:		mov	a, b
			out	2
			mov a, m
			out 0x0C
			push psw
			pop psw
			push psw
			pop psw
			dcx h
			dcr b
			out 0x0C

			jp	@loop
			ret

; in: B - value to fill with
; use: HL - start of screen memory
fill_scr:
  LXI H, 0x8000
@loop:
  MOV M, B
  INX H
  MOV A, H
  ORA L
  JNZ @loop
  ;CALL pause
  RET

; Simple delay
; use: C = delay count
pause:
  MVI C, 0xFF
@loop:
  NOP
  DCR C
  JNZ @loop
  RET


palette:
  			DB b11_111_000, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, b00_000_000,
  			DB 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,