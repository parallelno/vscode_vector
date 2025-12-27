; Test basic multiline comment support
        .org 0x0100

/* This is a multiline comment
   that spans multiple lines
   and should be ignored by the assembler */
start:
        db 0x01

/* Another comment */ db 0x02

        db 0x03 /* inline multiline comment */

/* Comment
with multiple
lines
*/
        db 0x04
