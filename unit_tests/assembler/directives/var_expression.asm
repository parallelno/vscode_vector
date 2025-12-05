; Test .var directive with expression as initial value
.org 0x0300

BASE = 100
Offset .var BASE + 5    ; Initialize with expression = 105
        db Offset       ; Should emit 0x69 (105)

Offset = Offset * 2     ; Update to 210
        db Offset       ; Should emit 0xD2 (210)
