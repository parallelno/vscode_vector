; Test edge cases for multiline comments
        .org 0x0100

/* Single line multiline comment */
        db 0x01

/* Comment with internal slash-star: / * but not nested */
        db 0x02

        /* Comment before instruction */ mvi a, 0x03

        mvi b, /* comment between instruction and operand */ 0x04

; Traditional comment after multiline comment /* multiline in same line */ 
        db 0x05

/* Comment with special characters: $, @, %, #, &, *, etc. */
        db 0x06
