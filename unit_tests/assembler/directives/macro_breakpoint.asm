.macro Fill(byte, address, len)
    lxi h, address
    lxi b, len
    mvi a, byte
    nop
.endmacro

        .org 0x0100
loop:
        Fill(0xFF, 0x80FF, 0x80)
        Fill(0x80, 0x80FF, 0x80)
        jmp loop
