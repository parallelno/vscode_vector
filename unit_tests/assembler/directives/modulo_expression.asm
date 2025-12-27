; Validate modulo operator works in expressions and directives
.org 0x0100

VAL = 10 % 3       ; expect 1
DB VAL             ; 1
DB 14 % 4          ; 2
DW 0x1234 % 256    ; 0x0034
DB (5 % 2) + (9 % 5) ; 1 + 4 = 5
