; This file tests the fallback behavior
; It includes a file from a subdirectory that references a root-level file
.org 0x0200
.include "subdir/include_from_subdir.asm"
final_label:
        db 0x88
