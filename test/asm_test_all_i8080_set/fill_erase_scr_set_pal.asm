OPCODE_EI = 0xFB
OPCODE_RET = 0xC9

.org 0x100
		di
		lxi sp, 0x8000
		mvi a, OPCODE_EI
		sta 0x38
		mvi a, OPCODE_RET
		sta 0x39
		ei

	  	hlt
	  	call set_palette

test_start:
		; fill
  		lxi h, 0x80ff
		lxi b, 0x80
		mvi a, 0xff
  		call fill_scr
		hlt ; to capture the screen

		; erase
		lxi h, 0x80ff
		lxi b, 0x80
		mvi a, 0x00
  		CALL fill_scr
		hlt ; to capture the screen

		jmp test_start
end:
	  di
	  hlt ; end of program and for capture the final screen

; reversed fill
; in:
; hl - start of screen memory
; bc - length
; a - value to fill with
TEMP_BYTE = 0x00
fill_scr:
  sta @loop + 1
@loop:
  mvi m, TEMP_BYTE
  dcx h
  dcx b
  mov a, b
  ora c
  jnz @loop
  ret

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
			ei
			ret

palette:
  			DB b11_111_000, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, b00_000_000,
  			DB 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,