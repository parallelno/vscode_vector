.org 0x100
      lxi sp, 0x8000
	  lxi h, 0x38
	  mvi m, 0xC3
	  lxi h, set_palette
	  shld 0x39
      ei
      hlt
	  di
	  hlt

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

palette:
  			DB b11000000, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  			DB 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,