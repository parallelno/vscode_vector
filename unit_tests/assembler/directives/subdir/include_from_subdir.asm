; This file is in a subdirectory
; It includes a file from the parent directory using a project-root-relative path
.org 0x0100
.include "include_child.asm"
after_subdir:
        db 0x77
