.org 0x100

CONST1 = 0x4020
CONST2 = 0x8000
BIG8   = 0x1234
BIG16  = 0x10000

	mvi c, CONST1 + >CONST2
	lxi h, BIG16

	sta BIG16
	lda BIG16
	shld BIG16
	lhld BIG16

	jmp BIG16
	jz BIG16
	jnz BIG16
	jnc BIG16
	jc BIG16
	jpo BIG16
	jpe BIG16
	jp BIG16
	jm BIG16

	call BIG16
	cnz BIG16
	cz BIG16
	cnc BIG16
	cc BIG16
	cpo BIG16
	cpe BIG16
	cp BIG16
	cm BIG16

	out BIG8
	in BIG8

	adi BIG8
	aci BIG8
	sui BIG8
	sbi BIG8
	ani BIG8
	ori BIG8
	xri BIG8
	cpi BIG8
