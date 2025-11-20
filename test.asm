; It starts at 0x0100 so labels/addresses are stable.
.org 0x100
DI
HLT

; label examples
LABEL_ONE: CALL @sub1
@sub1: CALL i8080_set_test_end


; -------------------------
; include i8080 instruction set test
.include "test_i8080_set.asm"
	call @sub1
@sub1:
	INR C
	RET
