; MOV A,B test - transfer register B to A
.org 0x100
    MVI B, 0x55
    MOV A, B
