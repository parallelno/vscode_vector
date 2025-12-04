.macro EmitValue(count, value)
    .loop count
        db value
    .endloop
.endmacro

        .org 0x0300
EmitValue(2, 0x11)
EmitValue(3, 0x22)
