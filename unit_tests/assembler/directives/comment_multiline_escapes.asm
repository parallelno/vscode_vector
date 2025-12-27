; Test multiline comments with escaped quotes in strings
        .org 0x0100

; Test escaped quotes - these should not end the string
        .text "String with \" escaped quote"
        .text 'Char with \' escaped quote'

/* Comment outside string */
        db 0x01

; Test double backslash before quote - quote should end string
        .text "Path: C:\\"
        db 0x02

/* Another comment */
        .text "Backslash \\ and quote"
        db 0x03
