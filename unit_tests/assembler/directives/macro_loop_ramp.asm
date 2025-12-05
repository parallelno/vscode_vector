.macro MakeBlock(count)
BlockStart:
    .loop count
        db 0x70
    .endloop
BlockEnd:
.endmacro

        .org 0x0310
MakeBlock(2)
MakeBlock(3)
