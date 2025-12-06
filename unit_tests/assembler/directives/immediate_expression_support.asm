; Ensure every immediate-style opcode accepts expressions involving unary < and > operators
CONST1 = 0x4020
CONST2 = 0x8000
ADDR   = 0x1234

        .org 0x0000

        mvi     a, (<ADDR + 1)
        lxi     h, CONST1 + >ADDR
        sta     CONST1 + >CONST2
        lda     CONST1 + <ADDR
        shld    CONST1 + >CONST2
        lhld    CONST1 + <ADDR

        jmp     CONST1 + <ADDR
        jnz     CONST1 + <ADDR
        jz      CONST1 + <ADDR
        jnc     CONST1 + <ADDR
        jc      CONST1 + <ADDR
        jpo     CONST1 + <ADDR
        jpe     CONST1 + <ADDR
        jp      CONST1 + <ADDR
        jm      CONST1 + <ADDR

        call    CONST1 + >ADDR
        cnz     CONST1 + >ADDR
        cz      CONST1 + >ADDR
        cnc     CONST1 + >ADDR
        cc      CONST1 + >ADDR
        cpo     CONST1 + >ADDR
        cpe     CONST1 + >ADDR
        cp      CONST1 + >ADDR
        cm      CONST1 + >ADDR

        out     (>ADDR + 1)
        in      (<ADDR + 2)

        adi     (<ADDR + 3)
        sui     (<ADDR + 4)
        ani     (>ADDR + 1)
        ori     (<ADDR + 5)
        aci     (>ADDR + 2)
        sbi     (<ADDR + 6)
        xri     (>ADDR + 3)
        cpi     (<ADDR + 7)
