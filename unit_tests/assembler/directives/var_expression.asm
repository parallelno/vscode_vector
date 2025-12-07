; Test .var with expression update
.org 0x0100
Counter .var 10
DB Counter           ; Emit 10
Counter = Counter - 1
DB Counter           ; Emit 9
