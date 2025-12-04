; CMA test - complement accumulator
.org 0x100
    MVI A, 0xF0  ; 11110000
    DB 0x2F      ; CMA opcode - complement A -> 00001111 = 0x0F
