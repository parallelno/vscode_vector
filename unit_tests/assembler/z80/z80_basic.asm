; Z80 subset coverage to mirror i8080 opcodes
    ld bc,0x1234
    ld de,0x5678
    ld hl,0x9abc
    ld sp,0xdef0
    ld (bc),a
    ld (de),a
    ld a,(bc)
    ld a,(de)
    ld (0x2000),hl
    ld hl,(0x2000)
    ld (0x2100),a
    ld a,(0x2100)
    inc bc
    dec bc
    inc (hl)
    dec (hl)
    ld (hl),0x42
    rlca
    rla
    scf
    ccf
    ld h,a
    ld (hl),b
    ld a,(hl)
    halt
    add a,(hl)
    adc a,l
    sub (hl)
    sbc a,h
    and e
    xor d
    or c
    cp (hl)
    ret nz
    jp nz,0x1234
    call nz,0x3456
    out (0x10),a
    in a,(0x10)
