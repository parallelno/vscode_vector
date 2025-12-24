; Test case matching the problem statement's Example 2 format
; .org $8000
; .incbin "graphics.bin", 1000$, 500$ //Load a portion of the file at $8000. 
; The portion is 0x500 bytes long and it starts at 0x1000 in the binary file.

; Using our test_data.bin which has 16 bytes at 0x11, 0x22, ..., 0xFF, 0x00
; We'll load 4 bytes starting at offset 0x08 (byte 0x99)

.org $2000
.incbin "test_data.bin", $08, $04
after_incbin:
    db $FF
