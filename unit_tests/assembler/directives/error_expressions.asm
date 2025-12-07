; Test .error with labels and expressions
LIMIT = 100
START = 0x1234

        .org 0x0100
label1:
        db 0xFF
        
        .if (>START == 0x12)
          .error "Address high byte is", >START, "at label", label1
        .endif
