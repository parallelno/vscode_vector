; Comprehensive test for .incbin directive
; Demonstrates all use cases from the problem statement

; Example 1 from problem statement: Load entire file at $1000
.org $1000
music_start:
.incbin "test_data.bin"
music_end:

; Example 2 style from problem statement: Load portion with offset and length
.org $8000
graphics_start:
.incbin "test_data.bin", $04, $08  ; Load 8 bytes starting at offset 4
graphics_end:

; Additional test: Load remaining bytes from offset
.org $9000
remaining_start:
.incbin "test_data.bin", $0A      ; Load from offset 10 to end
remaining_end:

; Final marker
end_marker:
    db $FF
