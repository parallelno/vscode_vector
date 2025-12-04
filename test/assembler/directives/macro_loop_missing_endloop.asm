.macro Broken(count)
    .loop count
        db 0x00
.endmacro

Broken(2)
