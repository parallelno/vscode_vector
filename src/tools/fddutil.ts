#!/usr/bin/env node
/**
 * fddutil.ts
 *
 * TypeScript implementation of FDD (Floppy Disk Drive) utility tool.
 * Ported from the Python implementation at:
 * https://github.com/parallelno/fddutil_python/blob/main/src/fddutil.py
 *
 * This tool reads and writes FDD images, processes command-line arguments,
 * and manages files to be added to the FDD image.
 *
 * Usage: node fddutil.js -i file1 -i file2... -o output.fdd [-r ryba.fdd]
 *
 * Options:
 *   -h          Show help
 *   -r <file>   Template FDD image (ryba file) to use as base
 *   -i <file>   File to add to the FDD image (can be specified multiple times)
 *   -o <file>   Output FDD image file
 */

import * as fs from 'fs';
import * as path from 'path';
import { Filesystem } from './fddimage';

function printUsage(): void {
    console.log('Usage: fddutil -i file1 -i file2... -o output.fdd [-r ryba.fdd]');
    console.log('');
    console.log('Options:');
    console.log('  -h          Show this help message');
    console.log('  -r <file>   Template FDD image (ryba file) to use as base');
    console.log('              (default: os-t34.fdd in the script directory)');
    console.log('  -i <file>   File to add to the FDD image (can be specified multiple times)');
    console.log('  -o <file>   Output FDD image file');
}

function main(): void {
    const launchPath = __dirname;
    // Default template file - can be overridden with -r option
    let rybaFile = path.join(launchPath, 'os-t34.fdd');
    const filesToPut: string[] = [];
    let outputFile: string | null = null;

    try {
        let borrowHandler: ((value: string) => void) | null = null;
        const args = process.argv.slice(2);

        for (let i = 0; i < args.length; i++) {
            const arg = args[i].trim();

            if (borrowHandler) {
                borrowHandler(arg);
                borrowHandler = null;
                continue;
            }

            if (arg.startsWith('-')) {
                switch (arg) {
                    case '-h':
                        printUsage();
                        process.exit(0);
                        break;
                    case '-r':
                        // User-specified ryba file
                        borrowHandler = (v: string) => {
                            rybaFile = v;
                        };
                        break;
                    case '-i':
                        // File to add to filesystem
                        borrowHandler = (v: string) => {
                            filesToPut.push(v);
                        };
                        break;
                    case '-o':
                        // Output file
                        borrowHandler = (v: string) => {
                            outputFile = v;
                        };
                        break;
                    default:
                        console.log(`arg: "${arg}" does not compute`);
                        throw new Error('Invalid argument');
                }
            } else {
                console.log(`arg: "${arg}" does not compute`);
                throw new Error('Invalid argument');
            }
        }

        if (filesToPut.length === 0 || !outputFile) {
            throw new Error('Missing required arguments');
        }
    } catch {
        printUsage();
        process.exit(1);
    }

    // Read the ryba (template) file
    let rybaData: Buffer;
    try {
        rybaData = fs.readFileSync(rybaFile);
    } catch {
        console.error(`Error reading ryba file: ${rybaFile}`);
        process.exit(1);
    }

    // Create filesystem from ryba data
    const fdd = new Filesystem().fromArray(new Uint8Array(rybaData));
    console.log('Contents of ryba stomach:');
    fdd.listDir();

    // Add files to the FDD image
    for (const name of filesToPut) {
        let data: Buffer;
        try {
            data = fs.readFileSync(name);
        } catch {
            console.error(`Could not read file ${name}. Please check if the file exists and is readable.`);
            process.exit(1);
        }

        const basename = path.basename(name);
        fdd.saveFile(basename, new Uint8Array(data));
        console.log(`Saved file ${basename} to FDD image (${data.length} bytes)`);
    }

    // Write the FDD image to output file
    try {
        fs.writeFileSync(outputFile!, Buffer.from(fdd.bytes));
        console.log(`FDD image written to: ${outputFile}`);
    } catch {
        console.error(`Error writing FDD to: ${outputFile}`);
        process.exit(1);
    }
}

main();
