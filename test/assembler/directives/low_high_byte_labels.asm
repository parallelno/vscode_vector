; Test for low byte (<) and high byte (>) operators with labels
; This tests forward references to labels

        .org 0x8000
start:
        ; Use low/high byte of a forward-referenced label
        db <target_addr ; low byte of 0x800A = 0x0A
        db >target_addr ; high byte of 0x800A = 0x80
        
        ; Use low/high byte of a backward-referenced label (start at 0x8000)
        db <start       ; low byte of 0x8000 = 0x00
        db >start       ; high byte of 0x8000 = 0x80
        
        ; Arithmetic with labels
        db <(target_addr + 0x0034) ; low byte of 0x803E = 0x3E
        db >(target_addr + 0x0034) ; high byte of 0x803E = 0x80
        
        ; Use in .word directive with expressions
        .word <target_addr | (>target_addr << 8)  ; should reconstruct 0x800A

        ; Padding to reach target_addr
        ds 2

target_addr:
        db 0xAA ; marker byte at 0x800A

end:
