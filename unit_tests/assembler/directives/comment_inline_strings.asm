; Ensure inline comment markers inside strings are preserved
        .org 0x0100

        .text "http://x" // trailing comment should be ignored
        .text "semi;colon"
        .text "// not comment"
        db 0xAA ; real comment after data
