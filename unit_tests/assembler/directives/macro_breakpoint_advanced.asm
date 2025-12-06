.macro Fill(byte, address, len=0xff, halts=true, lp=5)
    lxi h, address
    lxi b, len
    mvi a, byte
    nop
    .if halts
        .loop lp
            hlt
        .endloop
    .endif
.endmacro

        .org 0x0100
loop:
        Fill(0xFF, 0x80FF, 0x80, true, 3)
        Fill(0x80, 0x80FF, 0x80)
        jmp loop
