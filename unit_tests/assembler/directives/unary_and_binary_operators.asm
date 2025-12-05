; Test that < and > still work as binary comparison operators in .if conditions
; alongside their unary low/high byte usage

VALUE = 0x1234
        .org 0x0100

        ; Test unary operators
        db <VALUE       ; low byte of 0x1234 = 0x34
        db >VALUE       ; high byte of 0x1234 = 0x12

        ; Test binary comparison operators
        .if 5 > 3
        db 0xAA         ; should be emitted because 5 > 3 is true
        .endif

        .if 3 < 5
        db 0xBB         ; should be emitted because 3 < 5 is true
        .endif

        .if 3 > 5
        db 0xCC         ; should NOT be emitted because 3 > 5 is false
        .endif

        .if 5 < 3
        db 0xDD         ; should NOT be emitted because 5 < 3 is false
        .endif

        ; Test combination: unary inside a conditional
        .if >VALUE == 0x12
        db 0xEE         ; should be emitted because high byte of 0x1234 == 0x12
        .endif

        .if <VALUE == 0x34
        db 0xFF         ; should be emitted because low byte of 0x1234 == 0x34
        .endif
