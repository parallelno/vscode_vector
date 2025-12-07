; Test .error directive inside .if blocks
VALUE = 150

        .if (VALUE < 100)
          db 0xAA
        .endif

        .if (VALUE > 100)
          .error "Value", VALUE, "exceeds maximum"
        .endif

        db 0xBB
