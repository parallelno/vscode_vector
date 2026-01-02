        org 0x0000
start:
        ld a, (bc)
        ld (de), a
        ld hl, (0x1234)
        ld (0x5678), hl
        ld sp, hl
        ld b, c
        ld (hl), 0x9A
        ld de, 0x1111
        ld a, (0x9ABC)
        ld (0x9ABC), a
        ld a, (hl)
        ld (hl), a
