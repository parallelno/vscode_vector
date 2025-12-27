.org 0x0100
CONST1: = $2000
@data_end: = CONST1 * 2

db <@data_end, >@data_end

end_label:
@data_end: = CONST1 * 4

db <@data_end, >@data_end
