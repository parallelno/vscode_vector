.org 0x100
    MVI A, 0x5
@loop:
    DCR A
    JNZ @loop
@end:
    JMP @end