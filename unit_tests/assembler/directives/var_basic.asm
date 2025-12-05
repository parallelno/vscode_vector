; Test basic .var directive - creates a variable with initial value
.org 0x0100

Counter .var 10
        db Counter      ; Should emit 10 (0x0A)

Counter = Counter - 1   ; Update to 9
        db Counter      ; Should emit 9 (0x09)

Counter = Counter - 1   ; Update to 8
        db Counter      ; Should emit 8 (0x08)
