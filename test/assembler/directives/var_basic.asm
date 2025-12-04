; Test .var directive - creates a variable that can be updated
; Format: Label .var Constant

        .org 0x0100

Counter .var 10         ; Create a Variable with the initial value 10

start:
        db Counter      ; Should emit 10 (0x0A)

Counter = Counter - 1   ; Update the Variable's value

        db Counter      ; Should emit 9 (0x09)

Counter = 5             ; Set to a specific value

        db Counter      ; Should emit 5 (0x05)

; Test using variable in expression
Counter = Counter + 3   ; 5 + 3 = 8

        db Counter      ; Should emit 8 (0x08)
