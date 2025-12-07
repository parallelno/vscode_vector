#!/usr/bin/env node
// Find the first difference between two text files, line by line.

// Usage: node scripts/find-first-diff.js [aFile] [bFile]
// example:
//    node .\scripts\find-first-diff.js test\asm_test_all_i8080_set\putup.debug.log test\asm_test_all_i8080_set\putup_trace_log.txt

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const [, , aArg, bArg] = process.argv;
const aPath = aArg || path.join('test', 'asm_test_all_i8080_set', 'fill_erase_scr_set_pal.debug.log');
const bPath = bArg || path.join('test', 'asm_test_all_i8080_set', 'fill_erase_scr_set_pal_trace_log_2025-11-29_21-34.txt');

if (!fs.existsSync(aPath)) {
    console.error(`ERROR: cannot read file '${aPath}'`);
    process.exit(2);
}
if (!fs.existsSync(bPath)) {
    console.error(`ERROR: cannot read file '${bPath}'`);
    process.exit(2);
}

async function compareFiles() {
    const fileStream1 = fs.createReadStream(aPath);
    const fileStream2 = fs.createReadStream(bPath);

    const rl1 = readline.createInterface({
        input: fileStream1,
        crlfDelay: Infinity
    });

    const rl2 = readline.createInterface({
        input: fileStream2,
        crlfDelay: Infinity
    });

    const it1 = rl1[Symbol.asyncIterator]();
    const it2 = rl2[Symbol.asyncIterator]();

    let lineNum = 0;
    while (true) {
        lineNum++;
        const p1 = it1.next();
        const p2 = it2.next();

        const [r1, r2] = await Promise.all([p1, p2]);

        if (r1.done && r2.done) {
            console.log(`NO DIFFERENCE: files are identical (lines=${lineNum - 1})`);
            break;
        }

        if (r1.done !== r2.done) {
            console.log(`FIRST DIFFERENCE AT LINE ${lineNum}`);
            console.log(`File lengths differ.`);
            if (r1.done) {
                console.log(`- ${aPath} ended at line ${lineNum - 1}`);
                console.log(`- ${bPath} has more content: "${r2.value}"`);
            } else {
                console.log(`- ${aPath} has more content: "${r1.value}"`);
                console.log(`- ${bPath} ended at line ${lineNum - 1}`);
            }
            break;
        }

        if (r1.value !== r2.value) {
            console.log(`FIRST DIFFERENCE AT LINE ${lineNum}`);
            console.log(`- ${aPath} (line ${lineNum}):`);
            console.log(r1.value);
            console.log(`- ${bPath} (line ${lineNum}):`);
            console.log(r2.value);
            break;
        }
    }

    rl1.close();
    rl2.close();
    fileStream1.destroy();
    fileStream2.destroy();
}

compareFiles().catch(err => {
    console.error('Error comparing files:', err);
    process.exit(1);
});
