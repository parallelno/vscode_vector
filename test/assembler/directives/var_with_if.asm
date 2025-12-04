; Test .var directive with .if conditional
; Variables should work in conditional expressions

        .org 0x0100

Counter .var 3          ; Create variable with initial value 3

; Test variable in .if condition
        .if Counter > 0
        db 0xAA         ; Should emit - Counter is 3
        .endif

Counter = Counter - 1   ; Counter is now 2

        .if Counter > 0
        db 0xBB         ; Should emit - Counter is 2
        .endif

Counter = Counter - 2   ; Counter is now 0

        .if Counter > 0
        db 0xCC         ; Should NOT emit - Counter is 0
        .endif

        db 0xDD         ; Always emits
