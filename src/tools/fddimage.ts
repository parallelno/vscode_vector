/**
 * fddimage.ts
 *
 * TypeScript implementation of FDD (Floppy Disk Drive) image handling.
 * Ported from the Python implementation at:
 * https://github.com/parallelno/fddutil_python/blob/main/src/fddimage.py
 *
 * This module provides classes and functions for handling FDD image structure,
 * including managing headers, directories, and the filesystem.
 */

// Physical sector size constants
export const FDD_SIDES = 2;
export const FDD_TRACKS_PER_SIDE = 82;
export const FDD_SECTORS_PER_TRACK = 5;
export const FDD_SECTOR_LEN = 1024;
export const FDD_SIZE = FDD_SIDES * FDD_TRACKS_PER_SIDE * FDD_SECTORS_PER_TRACK * FDD_SECTOR_LEN;

// File status constants
export const STATUS_FILE_EXISTS = 0x0f;
export const STATUS_FILE_DOESNT_EXISTS = 0x10;
export const EMPTY_MARKER = 0xe5;

// If MDHeader.records < 0x80 then this is the last extent of the file
export const RECORD_SIZE = 0x80;

// Directory structure constants
export const DIRECTORY_START_OFFSET = 0xa000; // Directory starts at 40960
export const DIRECTORY_END_OFFSET = 0xb000; // Directory ends at 45056
export const ENTRY_SIZE = 32; // Size of each directory entry
export const MAX_ENTRIES = (DIRECTORY_END_OFFSET - DIRECTORY_START_OFFSET) / ENTRY_SIZE; // 128 entries

// File system constants
export const CLUSTER_LEN = 2048;

// Empty file markers (8 and 3 chars of 0xE5 interpreted as characters)
const EMPTY_FILENAME_MARKER = String.fromCharCode(EMPTY_MARKER).repeat(8);
const EMPTY_FILETYPE_MARKER = String.fromCharCode(EMPTY_MARKER).repeat(3);

/**
 * MicroDOS header structure for directory entries
 */
export class MDHeader {
    /**
     * 0x0 - 0x0F: file exists
     * 0xE5 - deleted
     */
    status: number = 0;

    /** 8 bytes of 7-bit ASCII characters */
    filename: string = '';

    /** 3 bytes of 7-bit ASCII characters */
    filetype: string = '';

    /**
     * Extent counter. If a file grows above 16k, then it will have multiple
     * directory entries. The first entry has Extent=0, the second has Extent=1 etc.
     * EX ranges from 0 to 31, thus allowing files up to 512k. CP/M 1.4 only
     * allows 256k discs anyway.
     */
    extent: number = 0;

    /** Reserved, always 0 */
    unknown1: number = 0;

    /** Reserved, always 0 */
    unknown2: number = 0;

    /**
     * Number of records (1 record=128 bytes) used in this extent. If it is
     * >= 80h, this extent is full and there may be another one on the disc.
     * File lengths are only saved to the nearest 128 bytes.
     */
    records: number = 0;

    /** FAT with 8 elements */
    fat: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

    /** Reference to the mapped data in the filesystem */
    mapped: Uint8Array | null = null;

    /** Index of this header in the directory */
    index: number = 0;

    /**
     * Initialize header from a byte array
     */
    fromArray(data: Uint8Array): MDHeader {
        this.status = data[0];

        // Convert bytes to string without assuming ASCII encoding
        let name = '';
        for (let i = 1; i < 9; i++) {
            name += String.fromCharCode(data[i]);
        }
        this.filename = name.trim();

        let ext = '';
        for (let i = 9; i < 12; i++) {
            ext += String.fromCharCode(data[i]);
        }
        this.filetype = ext.trim();

        this.extent = data[12];
        this.unknown1 = data[13];
        this.unknown2 = data[14];
        this.records = data[15];

        // Read FAT entries as 16-bit little-endian values
        for (let i = 0; i < 8; i++) {
            this.fat[i] = data[16 + 2 * i] | (data[16 + 2 * i + 1] << 8);
        }

        this.mapped = data;
        return this;
    }

    /**
     * Write header to a byte array
     */
    toBytes(destination: Uint8Array): void {
        destination[0] = this.status;

        const name = this.filename.padEnd(8, ' ');
        for (let i = 0; i < 8; i++) {
            destination[1 + i] = name.charCodeAt(i);
        }

        const ext = this.filetype.padEnd(3, ' ');
        for (let i = 0; i < 3; i++) {
            destination[9 + i] = ext.charCodeAt(i);
        }

        destination[12] = this.extent;
        destination[13] = this.unknown1;
        destination[14] = this.unknown2;
        destination[15] = this.records;

        for (let i = 0; i < 8; i++) {
            destination[16 + 2 * i] = this.fat[i] & 0xff;
            destination[16 + 2 * i + 1] = (this.fat[i] >> 8) & 0xff;
        }
    }

    /**
     * Initialize header from a filename
     */
    fromName(filename: string): MDHeader {
        const nameext = filename.toUpperCase().split('.');
        this.filename = nameext[0];
        this.filetype = nameext.length > 1 ? nameext[1] : '';
        return this;
    }
}

/**
 * Directory entry representing a file in the filesystem
 */
export class DirectoryEntry {
    filesystem: Filesystem;
    header: MDHeader | null = null;
    chain: number[] = [];
    size: number = 0;

    constructor(filesystem: Filesystem) {
        this.filesystem = filesystem;
    }

    /**
     * Initialize directory entry from a header
     */
    fromHeader(header: MDHeader): DirectoryEntry {
        this.header = header;
        this.chain = [];
        const lastHeader = this.findLastHeader(header);
        if (lastHeader) {
            this.size = lastHeader.extent * 2048 * 8 + lastHeader.records * 128;
        }
        return this;
    }

    /**
     * Find the last header in a chain of extents for a file
     */
    private findLastHeader(sought: MDHeader): MDHeader | null {
        let lastHeader: MDHeader | null = null;

        this.filesystem.readDir((header: MDHeader): boolean => {
            if (
                header.status <= STATUS_FILE_EXISTS &&
                header.filename === sought.filename &&
                header.filetype === sought.filetype
            ) {
                this.chain.push(...header.fat);
                if (header.records < RECORD_SIZE) {
                    lastHeader = header;
                    return true;
                }
            }
            return false;
        });

        return lastHeader;
    }
}

/**
 * Callback type for directory reading operations
 */
export type FileCallback = (header: MDHeader) => boolean;

/**
 * Filesystem class for handling FDD image operations
 */
export class Filesystem {
    bytes: Uint8Array;

    private static readonly MAXCLUST = 390;

    constructor(size: number = 0) {
        // Erase disk data with empty marker
        this.bytes = new Uint8Array(size);
        this.bytes.fill(EMPTY_MARKER);
    }

    /**
     * Initialize filesystem from an existing byte array
     */
    fromArray(data: Uint8Array | Buffer): Filesystem {
        if (data.length > this.bytes.length) {
            this.bytes = new Uint8Array(data.length);
        }
        this.bytes.set(data);
        return this;
    }

    /**
     * Map a sector in the filesystem to its byte offset
     */
    mapSector(trackID: number, sideID: number, sector: number): Uint8Array {
        const sectors = FDD_SECTORS_PER_TRACK * (trackID * FDD_SIDES + sideID);
        // In CHS addressing the sector numbers always start at 1, 
        // but in the data buffer the sector numbers always start at 0.
        const sectorAdjusted = Math.max(0, sector - 1);
        const offset = (sectors + sectorAdjusted) * FDD_SECTOR_LEN;

        return this.bytes.subarray(offset, offset + FDD_SECTOR_LEN);
    }

    /**
     * Read directory entries and call callback for each
     */
    readDir(fileCallback: FileCallback): void {
        const sectorSize = 32;

        for (let position = DIRECTORY_START_OFFSET; position < DIRECTORY_END_OFFSET; position += sectorSize) {
            const header = new MDHeader();
            header.fromArray(this.bytes.subarray(position, position + sectorSize));
            header.index = (position - DIRECTORY_START_OFFSET) / sectorSize;
            if (fileCallback(header)) {
                break;
            }
        }
    }

    /**
     * Convert cluster number to track, head, sector
     */
    clusterToThs(cluster: number): [number, number, number] {
        let track = 8 + Math.floor(cluster / 5);
        const head = track % 2;
        track >>= 1;
        const sector = 1 + (cluster % 5);
        return [track, head, sector];
    }

    /**
     * List all files in the directory
     */
    listDir(): void {
        this.readDir((header: MDHeader): boolean => {
            if (header.status <= STATUS_FILE_EXISTS && header.extent === 0) {
                const d = new DirectoryEntry(this).fromHeader(header);
                console.log(`\x1b[90m${header.filename}.${header.filetype}, size: ${d.size} bytes\x1b[0m`);
            }
            return false;
        });
    }

    /**
     * Build a list of available (unallocated) clusters
     */
    buildAvailableChain(): number[] {
        const usedClusters = new Uint8Array(Filesystem.MAXCLUST);

        this.readDir((header: MDHeader): boolean => {
            if (header.status <= STATUS_FILE_EXISTS) {
                for (const clusterIndex of header.fat) {
                    if (clusterIndex < usedClusters.length) {
                        usedClusters[clusterIndex] = 1;
                    }
                }
            }
            return false;
        });

        const unusedClusters: number[] = [];
        for (let clusterIndex = 2; clusterIndex < usedClusters.length; clusterIndex++) {
            if (usedClusters[clusterIndex] === 0) {
                unusedClusters.push(clusterIndex);
            }
        }
        return unusedClusters;
    }

    /**
     * Save a file to the filesystem
     * @param fileName Name of the file (e.g., "TEST.COM")
     * @param fileBytes File data as Uint8Array
     * @returns Remaining free space in bytes, or false if disk is full
     */
    saveFile(fileName: string, fileBytes: Uint8Array): number | false {
        let availableClusters = this.buildAvailableChain();
        let freeSpace = availableClusters.length * CLUSTER_LEN;

        if (freeSpace < fileBytes.length) {
            console.log(
                `\x1b[90mDisk full, free space: ${freeSpace} bytes, remaining clusters: ${availableClusters.length}\x1b[0m`
            );
            return false;
        }

        const header = new MDHeader().fromName(fileName);

        // Allocate clusters for the file
        let clusterIndex = 0;
        let extent = 0;
        let remainingBytes = fileBytes.length;

        this.readDir((existingHeader: MDHeader): boolean => {
            if (existingHeader.status >= STATUS_FILE_DOESNT_EXISTS) {
                // Take this header slot
                let oldFile = '';
                if (existingHeader.filename !== EMPTY_FILENAME_MARKER || existingHeader.filetype !== EMPTY_FILETYPE_MARKER) {
                    oldFile = existingHeader.filename + '.' + existingHeader.filetype;
                }

                console.log(`\x1b[90mSaved to header: ${existingHeader.index}. Previously stored file: ${oldFile}\x1b[0m`);

                // Allocate clusters
                header.records = Math.ceil(remainingBytes / 128);
                header.extent = extent;
                extent += 1;
                header.records = Math.min(header.records, RECORD_SIZE);

                for (let i = 0; i < 8; i++) {
                if (clusterIndex < availableClusters.length) {
                    header.fat[i] = remainingBytes > 0 ? availableClusters[clusterIndex] : 0;
                } else {
                    header.fat[i] = 0;
                }
                if (remainingBytes > 0 && clusterIndex < availableClusters.length) {
                    remainingBytes -= 2048;
                    clusterIndex++;
                }
                }

                if (existingHeader.mapped) {
                    header.toBytes(existingHeader.mapped);
                }

                if (remainingBytes <= 0) {
                    return true; // All mapped
                }
            }
            return false;
        });

        // Write file data to clusters
        if (clusterIndex !== 0) {
            let srcptr = 0;
            for (let ci = 0; ci < clusterIndex; ci++) {
                if (srcptr >= fileBytes.length) {
                    break;
                }

                const clust = availableClusters[ci] << 1;
                for (let i = 0; i < 2; i++) {
                    const [track, head, sector] = this.clusterToThs(clust + i);
                    const mapped = this.mapSector(track, head, sector);

                    for (let p = 0; p < 1024; p++) {
                        if (srcptr >= fileBytes.length) {
                            break;
                        }
                        mapped[p] = fileBytes[srcptr];
                        srcptr++;
                    }
                }
            }
        }

        // Recalculate free space
        availableClusters = this.buildAvailableChain();
        freeSpace = availableClusters.length * CLUSTER_LEN;
        return freeSpace;
    }
}
