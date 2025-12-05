; Test .var fails when constant already exists
.org 0x0500

MyConst = 10

MyConst .var 5          ; Should fail - MyConst is already a constant
