; Test that .error inside a false .if block does not trigger
        .org 0x1000
LIMIT = 0x2000
START_ADDR = 0x1000
        .if (START_ADDR > LIMIT)
          .error "The current memory address is too high..."
        .endif
start:  db 0x55
