; Test multiline comments with strings containing comment markers
        .org 0x0100

; String literals should not be affected by comment stripping
        .text "This /* is not a comment */"

/* This is a real comment */
        .text "Another string"

        db 0x01 /* comment */ , 0x02

; Character literals with asterisk and slash
        .text '*', '/'

/* Comment with quoted text inside */
        db 0x03
