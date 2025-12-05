; Test unary < and > operators with various immediate instructions
ADDR = 0x1234
        .org 0x0000

        ; ADI with high byte
        adi >ADDR       ; ADI 0x12

        ; SUI with low byte
        sui <ADDR       ; SUI 0x34

        ; ANI with expression
        ani <0xABCD     ; ANI 0xCD

        ; ORI with expression
        ori >0xABCD     ; ORI 0xAB

        ; CPI with expression
        cpi <ADDR + 1   ; CPI 0x35

        ; IN with expression
        in <0x1200      ; IN 0x00

        ; OUT with expression
        out >0x1200     ; OUT 0x12
