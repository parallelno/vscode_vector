; JMP test - unconditional jump
.org 0x100
    JMP skip
    MVI A, 0xAA     ; This should be skipped
skip:
    MVI A, 0xBB
