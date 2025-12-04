; Test for low byte (<) and high byte (>) operators
; <N gets the low byte of N (bits 0-7)
; >N gets the high byte of N (bits 8-15)

ADDR_CONST = $1234
LABEL_CONST EQU 0xABCD

        .org 0x0100
start:
        ; Test with literals
        db <$1234       ; low byte of $1234 = 0x34
        db >$1234       ; high byte of $1234 = 0x12
        
        ; Test with hex literal (0x prefix)
        db <0xBEEF      ; low byte of 0xBEEF = 0xEF
        db >0xBEEF      ; high byte of 0xBEEF = 0xBE
        
        ; Test with decimal literal
        db <4660        ; low byte of 4660 (0x1234) = 0x34
        db >4660        ; high byte of 4660 (0x1234) = 0x12
        
        ; Test with constant
        db <ADDR_CONST  ; low byte of $1234 = 0x34
        db >ADDR_CONST  ; high byte of $1234 = 0x12
        
        ; Test with EQU constant
        db <LABEL_CONST ; low byte of 0xABCD = 0xCD
        db >LABEL_CONST ; high byte of 0xABCD = 0xAB
        
        ; Test with parenthesized expression
        db <($1000 + $0234)  ; low byte of $1234 = 0x34
        db >(0x1000 + 0x234) ; high byte of $1234 = 0x12
        
        ; Test nested/combined with other ops
        db <($FF00 | $00CD)  ; low byte of $FFCD = 0xCD
        db >($FF00 | $00CD)  ; high byte of $FFCD = 0xFF

end:
