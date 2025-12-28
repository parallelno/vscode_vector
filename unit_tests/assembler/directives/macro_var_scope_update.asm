.macro CounterTest()
    counter .var 0
    counter = counter + 1
    .if counter == 1
        db 0xAA
    .endif
    counter = counter + 1
    .if counter == 2
        db 0xBB
    .endif
.endmacro

        .org 0x0200
CounterTest()
