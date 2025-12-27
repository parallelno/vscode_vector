; Test multiline comments with code
        .org 0x0080

/*
 * Block comment before code
 * Testing multiple lines
 */
        mvi a, 0x10
        
        /* Comment between instructions */
        
        mvi b, 0x20
        
/* Comment
   around
   instruction */ mvi c, 0x30
        
        db 0xAA /* inline comment */ , 0xBB
