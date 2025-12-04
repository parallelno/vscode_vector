TRUE_VAL = 1
FALSE_VAL = 0

        .org 0x0080
        .if TRUE_VAL
true_block:
        db 0x0F
        .endif

        .if FALSE_VAL
        db 0xAA
        .endif

        db 0xBB
