; Test .var fails when label already exists
.org 0x0400

MyLabel:
        nop

MyLabel .var 5          ; Should fail - MyLabel is already a label
