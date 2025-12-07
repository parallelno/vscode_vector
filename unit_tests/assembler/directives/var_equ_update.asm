; Test .var with EQU update
.org 0x0100
Value .var 20
DB Value        ; Emit 20
Value EQU 30
DB Value        ; Emit 30
