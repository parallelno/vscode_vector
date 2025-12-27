CONST_BASE = $01000000

        .org 0x1000
start:
        dd 0x12345678, CONST_BASE + 0x22
        .dword -1
after:
        db 0x00
