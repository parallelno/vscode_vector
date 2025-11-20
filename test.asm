; It starts at 0x0100 so labels/addresses are stable.
.org 0x100
DI
HLT

; label examples
LABEL_ONE: CALL sub1
LABEL_TWO: CALL sub1


; -------------------------
; include i8080 instruction set test
.include "test_i8080_set.asm"

sub1:
	INR C
	RET
