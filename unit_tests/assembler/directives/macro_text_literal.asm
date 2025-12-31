; Regression for macro param substitution wrapping string literals
_LINE_BREAK_ = 106
_PARAG_BREAK_ = 255
_EOD_ = 0
.macro TEXT (string, end_code=_EOD_)
.encoding "screencodecommodore", "mixed"
    .text string
    .byte end_code
.endmacro

TEXT("Hi!", _LINE_BREAK_)
