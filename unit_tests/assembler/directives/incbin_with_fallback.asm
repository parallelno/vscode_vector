; This file tests the incbin fallback behavior
.org 0x0400
.include "subdir/incbin_from_subdir.asm"
final_marker:
        db 0xAA
