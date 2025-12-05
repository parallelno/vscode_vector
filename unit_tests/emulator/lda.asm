; LDA test - load accumulator from memory
.org 0x100
    MVI A, 0x99
    STA 0x0200
    LDA 0x0200
