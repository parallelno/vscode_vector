; ADD B test - adds register B to accumulator
.org 0x100
    MVI A, 0x11
    MVI B, 0x22
    ADD B
