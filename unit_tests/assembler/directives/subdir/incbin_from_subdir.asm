; This file is in a subdirectory
; It includes a binary file from the parent directory using a project-root-relative path
.org 0x0300
.incbin "test_data.bin", 0, 4
after_bin:
        db 0x99
