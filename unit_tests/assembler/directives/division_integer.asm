; Ensure division is integer (truncates toward zero)
.org 0x0100

CONST1 = 5 / 2      ; should be 2
DB CONST1            ; 2
DB -5 / 2            ; -2 -> 0xFE
DW 7 / 3             ; 2 -> 0x0002
