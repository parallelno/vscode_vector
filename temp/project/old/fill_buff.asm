; reversed fill
; in:
; hl - start of screen memory
; bc - length
; a - value to fill with
TEMP_BYTE = 0x00
fill_buff:
			sta @loop + 1
@loop:
			mvi m, TEMP_BYTE
			dcx h
			dcx b
			mov a, b
			ora c
			jnz @loop
			ret