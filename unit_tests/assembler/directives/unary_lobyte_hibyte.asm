; Test unary prefix operators < (low byte) and > (high byte)
CONST1 = 0xF00
        .org 515
start:  DB >CONST1      ; high byte of 0xF00 = 0x0F
CONST2 = <start         ; low byte of 515 = 3
        mvi a, >start   ; high byte of 515 = 2
        db <0x1234      ; low byte of 0x1234 = 0x34
        db >0x1234      ; high byte of 0x1234 = 0x12
