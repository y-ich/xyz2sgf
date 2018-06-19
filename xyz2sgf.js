/* global module */

/**
 *  JavaScript version of https://github.com/fohristiwhirl/xyz2sgf
 */

const loaders = {
    ".gib": {
        "function": parseGib,
        "encoding": "utf8"
    },
    ".ngf": {
        "function": parseNgf,
        "encoding": "gb18030"
    },
    ".ugf": {
        "function": parseUgf,
        "encoding": "shift_jisx0213"
    },
    ".ugi": {
        "function": parseUgf,
        "encoding": "shift_jisx0213"
    }
};

// ---------------------------------------------------------------------

const fs = require('fs');
const MemoryStream = require('memorystream');

class ValueError extends Error {}
class BadBoardSize extends Error {}
class ParserFail extends Error {}
class UnknownFormat extends Error {}

class Node {
    constructor(parent) {
        this.properties = new Map();
        this.children = [];
        this.parent = parent;

        if (parent) {
            parent.children.push(this);
        }
    }

    safeCommit(key, value) {
        /**
         *  Note: destroys the key if value is ""
         */ 
        const safe_s = safeString(value);
        if (safe_s) {
            this.properties.set(key, [safe_s]);
        } else {
            this.properties.delete(key);
        }
    }

    addValue(key, value) {
        /**
         * Note that, if improperly used, could lead to odd nodes like ;B[ab][cd]
         */
        if (!this.properties.has(key)) {
            this.properties.set(key, []);
        }
        if (!this.properties.get(key).includes(value.toString())) {
            this.properties.get(key).push(value.toString());
        }
    }

    setValue(key, value) {
        /**
         * Like the above, but only allows the node to have 1 value for this key
         */
        this.properties.set(key, [value.toString()]);
    }
}

// ---------------------------------------------------------------------


function stringFromPoint(x, y) {
    /**
     * convert x, y into SGF coordinate e.g. "pd"
     */
    if (x < 1 || x > 26 || y < 1 || y > 26) {
        throw new ValueError();
    }
    let s = "";
    s += String.fromCharCode(x + 96);
    s += String.fromCharCode(y + 96);
    return s;
}


function safeString(s) {
    /**
     * "safe" meaning safely escaped \ && ] characters
     */
    return s.toString().replace(/([\]\\])/g, "\\$1");
}


function handicapPoints(boardsize, handicap, tygem = false) {
    const points = new Set();

    if (boardsize < 4) {
        return points;
    }

    if (handicap > 9) {
        handicap = 9
    }

    const d = boardsize < 13 ? 2 : 3;

    if (handicap >= 2) {
        points.add([boardsize - d, 1 + d]);
        points.add([1 + d, boardsize - d]);
    }

    // Experiments suggest Tygem puts its 3rd handicap stone in the top left

    if (handicap >= 3) {
        points.add(tygem ? [1 + d, 1 + d] : [boardsize - d, boardsize - d]);
    }

    if (handicap >= 4) {
        points.add(tygem ? [boardsize - d, boardsize - d] : [1 + d, 1 + d]);
    }

    if (boardsize % 2 === 0) {
        // No handicap > 4 on even sided boards
        return points;
    }

    const mid = Math.floor((boardsize + 1) / 2);

    if ([5, 7, 9].includes(handicap)) {
        points.add([mid, mid]);
    }

    if ([6, 7, 8, 9].includes(handicap)) {
        points.add([1 + d, mid]);
        points.add([boardsize - d, mid]);
    }

    if ([8, 9].includes(handicap)) {
        points.add([mid, 1 + d]);
        points.add([mid, boardsize - d]);
    }

    return points;
}


function getExtension(filename) {
    const match = filename.match(/(\.\w+)$/);
    return match ? match[1].toLowerCase() : null;
}


function load(filename) {
    /**
     * FileNotFoundError is just allowed to bubble up
     * All the parsers below can throw ParserFail
     */
    const ext = getExtension(filename);

    if (ext in loaders) {
        const contents = fs.readFileSync(
            filename,
            { encoding: loaders[ext]["encoding"] }
        );
        return parse(contents, ext);
    } else {
        console.log("Couldn't detect file type -- make sure it has an extension of .gib, .ngf, .ugf || .ugi");
        throw new UnknownFormat();
    }

}


function parse(contents, ext) {
    const root = loaders[ext]["function"](contents);

    root.setValue("FF", 4);
    root.setValue("GM", 1);
    root.setValue("CA", "UTF-8");   // Force UTF-8

    let size;
    if (root.properties.has("SZ")) {
        size = parseInt(root.properties.get("SZ")[0]);
    } else {
        size = 19;
        root.setValue("SZ", "19");
    }

    if (size > 19 || size < 1) {
        throw new BadBoardSize();
    }

    return root;
}


function saveFile(filename, root) {
    /**
     * Note: this version of the saver requires the root node
     */
    const outfile = fs.createWriteStream(filename);
    writeTree(outfile, root);
    outfile.end();
}

function fileToConvertedString(filename) {
    return new Promise(function(res, rej) {
        const root = load(filename);
        const stream = MemoryStream.createWriteStream();
        writeTree(stream, root);
        stream.end(function() {
            res(stream.toString());
        });
    });
}


function xyz2sgf(str, ext) {
    return new Promise(function(res, rej) {
        const root = parse(str, ext);
        const stream = MemoryStream.createWriteStream();
        writeTree(stream, root);
        stream.end(function() {
            res(stream.toString());
        });
    });
}

function writeTree(writeStream, node) {
    /**
     * Relies on values already being correctly backslash-escaped
     */
    writeStream.write("(");
    while (true) {
        writeStream.write(";");
        for (const [key, values] of node.properties) {
            writeStream.write(key);
            for (const value of values) {
                writeStream.write(`[${value}]`);
            }
        }
        if (node.children.length > 1) {
            for (const child of node.children) {
                writeTree(writeStream, child);
            }
            break;
        } else if (node.children.length === 1) {
            node = node.children[0];
            continue;
        } else {
            break;
        }
    }
    writeStream.write(")\n");
}


function parseUgf(ugf) {
    /**
     * Note that the files are often (always?) named .ugi
     */

    const root = new Node(null);
    let node = root;

    let boardsize = null;
    let handicap = null;

    let handicapStonesSet = 0;

    let coordinateType = "";

    const lines = ugf.split("\n");

    let section = null;

    for (let line of lines) {

        line = line.trim();

        try {
            if (line.chatAt(0) === "[" && line.charAt(line.length - 1) === "]") {

                const section = line.toUpperCase();

                if (section === "[DATA]") {

                    // Since we're entering the data section, we need to ensure we have
                    // gotten sane info from the header; check this now...

                    if (handicap == null || boardsize == null) {
                        throw new ParserFail();
                    }
                    if (boardsize < 1 || boardsize > 19 || handicap < 0) {
                        throw new ParserFail();
                    }
                }
                continue;
            }

        } catch (e) {}

        if (section === "[HEADER]") {

            if (line.toUpperCase().startsWith("HDCP=")) {
                try {
                    const handicapStr = line.split("=")[1].split(",")[0];
                    handicap = parseInt(handicapStr);
                    if (handicap >= 2) {
                        root.setValue("HA", handicap);      // The actual stones are placed in the data section
                    }

                    const komiStr = line.split("=")[1].split(",")[1];
                    const komi = parseFloat(komiStr);
                    root.setValue("KM", komi);
                } catch (e) {
                    continue;
                }

            } else if (line.toUpperCase().startsWith("SIZE=")) {
                const sizeStr = line.split("=")[1];
                try {
                    boardsize = parseInt(sizeStr);
                    root.setValue("SZ", boardsize);
                } catch (e) {
                    continue;
                }

            } else if (line.toUpperCase().startsWith("COORDINATETYPE=")) {
                coordinateType = line.split("=")[1].toUpperCase();
            }

            // Note that the properties that aren't being converted to int/float need to use the .safeCommit() method...

            else if (line.toUpperCase().startsWith("PLAYERB=")) {
                root.safeCommit("PB", line.slice(8));

            } else if (line.toUpperCase().startsWith("PLAYERW=")) {
                root.safeCommit("PW", line.slice(8));

            } else if (line.toUpperCase().startsWith("PLACE=")) {
                root.safeCommit("PC", line.slice(6));

            } else if (line.toUpperCase().startsWith("TITLE=")) {
                root.safeCommit("GN", line.slice(6));
            }

            // Determine the winner...

            else if (line.toUpperCase().startsWith("WINNER=B")) {
                root.setValue("RE", "B+");

            } else if (line.toUpperCase().startsWith("WINNER=W")) {
                root.setValue("RE", "W+");
            }

        } else if (section === "[DATA]") {

            line = line.toUpperCase();

            const slist = line.split(",");
            let xChr;
            let yChr;
            let colour;
            try {
                xChr = slist[0].charAt(0);
                yChr = slist[0].charAt(1);
                colour = slist[1].charAt(0);
                if (xChr === '' || yChr === '' || colour === '') {
                    continue;
                }
            } catch (e) {
                continue;
            }

            const nodeChr = slist[2] ? slist[2].charAt(0) : "";
            if (!["B", "W"].includes(colour)) {
                continue;
            }

            let x;
            let y;
            if (coordinateType === "IGS") {        // apparently "IGS" format is from the bottom left
                x = xChr.charCodeAt(0) - 64;
                y = (boardsize - (yChr.charCodeAt(0) - 64)) + 1;
            } else {
                x = xChr.charCodeAt(0) - 64;
                y = yChr.charCodeAt(0) - 64;
            }

            let value;
            if (x > boardsize || x < 1 || y > boardsize || y < 1) {    // Likely a pass, "YA" is often used as a pass
                value = "";
            } else {
                try {
                    value = stringFromPoint(x, y);
                } catch (e) {
                    continue;
                }
            }
            // In case of the initial handicap placement, don't create a new node...

            if (handicap >= 2 && handicapStonesSet !== handicap && nodeChr === "0" && colour === "B" && node === root) {
                handicapStonesSet += 1;
                const key = "AB";
                node.addValue(key, value);      // addValue not setValue
            } else {
                node = new Node(node);
                const key = colour;
                node.setValue(key, value);
            }
        }
    }
    if (root.children.length === 0) {     // We'll assume we failed in this case
        throw new ParserFail;
    }

    return root;
}


function parseNgf(ngf) {

    ngf = ngf.trim();
    const lines = ngf.split("\n");

    let boardsize;
    let handicap;
    let pw;
    let pb;
    let rawdate;
    let komi;
    boardsize = parseInt(lines[1]);
    if (Number.isInteger(boardsize)) {
        boardsize = 19;
    }
    handicap = parseInt(lines[5]);
    if (Number.isInteger(handicap)) {
        handicap = 0;
    }
    pw = lines[2] ? lines[2].trim().split(/\s+/)[0] : "";
    pb = lines[3] ? lines[3].trim().split(/\s+/)[0] : "";
    rawdate = lines[8] ? lines[8].slice(0, 8) : "";
    komi = parseFloat(lines[7]);
    if (Number.isFinite(komi)) {
        komi = 0;
    }
    if (handicap === 0 && parseInt(komi) === komi) {
        komi += 0.5;
    }

    let re = "";
    if (lines[10]) {
        if (/hite win/.test(lines[10])) {
            re = "W+";
        } else if (/lack win/.test(lines[10])) {
            re = "B+";
        }
    }

    if (handicap < 0 || handicap > 9) {
        throw new ParserFail();
    }

    const root = new Node(null);
    let node = root;

    // Set root values...

    root.setValue("SZ", boardsize);

    if (handicap >= 2) {
        root.setValue("HA", handicap);
        const stones = handicapPoints(boardsize, handicap, true);     // While this isn't Tygem, uses same layout I think
        for (const point of stones) {
            root.addValue("AB", stringFromPoint(point[0], point[1]));
        }
    }

    if (komi) {
        root.setValue("KM", komi);
    }

    if (rawdate.length === 8) {
        let ok = true;
        for (let n = 0; n < 8; n++) {
            if (!"0123456789".includes(rawdate[n])) {
                ok = false;
            }
        }
        if (ok) {
            const date = rawdate.slice(0, 4) + "-" + rawdate.slice(4, 6) + "-" + rawdate.slice(6, 8);
            root.setValue("DT", date);
        }
    }

    if (pw) {
        root.safeCommit("PW", pw);
    }
    if (pb) {
        root.safeCommit("PB", pb);
    }

    if (re) {
        root.setValue("RE", re);
    }

    // Main parser...

    for (let line of lines) {
        line = line.trim().toUpperCase();

        if (line.length >= 7) {
            if (line.slice(0, 2) == "PM") {
                if (["B", "W"].includes(line.charAt(4))) {

                    const key = line[4];

                    // Coordinates are from 1-19, but with "B" representing
                    // the digit 1. (Presumably "A" would represent 0.)

                    const x = line.charCodeAt(5) - 65;       // Therefore 65 is correct
                    const y = line.charCodeAt(6) - 65;

                    try {
                        const value = stringFromPoint(x, y);
                        node = new Node(node);
                        node.setValue(key, value);
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
    }

    if (root.children.length === 0) {     // We'll assume we failed in this case
        throw new ParserFail();
    }

    return root;
}

function gibMakeResult(grlt, zipsu) {

    const easycases = {
        3: "B+R",
        4: "W+R",
        7: "B+T",
        8: "W+T"
    };

    if (grlt in easycases) {
        return easycases[grlt];
    }

    if ([0, 1].includes(grlt)) {
        return `${grlt === 0 ? "B" : "W"}+${zipsu / 10}`;
    }

    return "";
}


function gibGetResult(line, grltRegex, zipsuRegex) {
    let grlt;
    let zipsu;
    let match = line.match(grltRegex);
    if (match) {
        grlt = parseInt(match[1]);
    } else {
        return "";
    }
    match = line.match(zipsuRegex);
    if (match) {
        zipsu = parseInt(match[1]);
    } else {
        return "";
    }
    return gibMakeResult(grlt, zipsu);
}


function parsePlayerName(raw) {

    let name = "";
    let rank = "";

    const foo = raw.split("(");
    if (foo.length === 2) {
        if (foo[1].charAt(foo[1].length - 1) === ")") {
            name = foo[0].trim();
            rank = foo[1].slice(0, -1);
        }
    }

    return name ? [name, rank] : [raw, ""];
}

function parseGib(gib) {

    const root = new Node(null);
    let node = root;

    const lines = gib.split("\n");

    for (let line of lines) {
        line = line.trim();

        if (line.startsWith("\\[GAMEBLACKNAME=") && line.endsWith("\\]")) {

            const s = line.slice(16, -2);
            const [name, rank] = parsePlayerName(s);
            if (name) {
                root.safeCommit("PB", name);
            }
            if (rank) {
                root.safeCommit("BR", rank);
            }
        }

        if (line.startsWith("\\[GAMEWHITENAME=") && line.endsWith("\\]")) {

            const s = line.slice(16, -2);
            const [name, rank] = parsePlayerName(s);
            if (name) {
                root.safeCommit("PW", name);
            }
            if (rank) {
                root.safeCommit("WR", rank);
            }
        }

        if (line.startsWith("\\[GAMEINFOMAIN=")) {

            if (!root.properties.has("RE")) {
                const result = gibGetResult(line, /GRLT:(\d+),/, /ZIPSU:(\d+),/);
                if (result) {
                    root.setValue("RE", result);
                }
            }

            if (!root.properties.has("KM")) {
                const match = line.match(/GONGJE:(\d+),/);
                if (match) {
                    const komi = parseInt(match[1]) / 10;
                    if (komi) {
                        root.setValue("KM", komi);
                    }
                }
            }
        }

        if (line.startsWith("\\[GAMETAG=")) {

            if (!root.properties.has("DT")) {
                const match = line.match(/C(\d\d\d\d):(\d\d):(\d\d)/);
                if (match) {
                    const date = match.slice(1).join("-");
                    root.setValue("DT", date);
                }
            }

            if (!root.properties.has("RE")) {
                const result = gibGetResult(line, /,W(\d+),/, /,Z(\d+),/);
                if (result) {
                    root.setValue("RE", result);
                }
            }

            if (!root.properties.has("KM")) {
                const match = line.match(/,G(\d+),/);
                if (match) {
                    const komi = parseInt(match[1]) / 10;
                    root.setValue("KM", komi);
                }
            }
        }

        if (line.slice(0, 3) === "INI") {

            if (node !== root) {
                throw new ParserFail();
            }

            const setup = line.trim().split(/\s+/);

            let handicap;
            if (setup[3]) {
                handicap = parseInt(setup[3]);
            } else {
                continue;
            }

            if (handicap < 0 || handicap > 9) {
                throw new ParserFail();
            }

            if (handicap >= 2) {
                node.setValue("HA", handicap);
                const stones = handicapPoints(19, handicap, true);
                for (const point of stones) {
                    node.addValue("AB", stringFromPoint(point[0], point[1]));
                }
            }
        }

        if (line.slice(0, 3) === "STO") {

            const move = line.trim().split(/\s+/);

            const key = move[3] === "1" ? "B" : "W";

            // Although one source claims the coordinate system numbers from the bottom left in range 0 to 18,
            // various other pieces of evidence lead me to believe it numbers from the top left (like SGF).
            // In particular, I tested some .gib files on http://gokifu.com

            let x;
            if (move[4]) {
                x = parseInt(move[4]) + 1;
            } else {
                continue;
            }
            let y;
            if (move[5]) {
                y = parseInt(move[5]) + 1;
            } else {
                continue;
            }

            try {
                const value = stringFromPoint(x, y);
                node = new Node(node);
                node.setValue(key, value);
            } catch (e) {
                continue;
            }
        }
    }

    if (root.children.length === 0) {     // We'll assume we failed in this case
        throw new ParserFail();
    }

    return root;
}


function baseName(str) {
    let base = new String(str).substring(str.lastIndexOf('/') + 1); 
    if (base.lastIndexOf(".") != -1) {
        base = base.substring(0, base.lastIndexOf("."));
    }
   return base;
}

function main() {

    if (process.argv.length === 2) {
        console.log(`Usage: ${baseName(process.argv[1])} <list of input files>`);
        return;
    }

    for (const filename of process.argv.slice(2)) {
        try {
            const root = load(filename);
            const outfilename = baseName(filename) + ".sgf";
            saveFile(outfilename, root);
        } catch (e) {
            console.log(`Conversion failed for ${filename}`);
            console.log(e);
        }
    }
}

exports.fileToConvertedString = fileToConvertedString;
exports.getExtension = getExtension;
exports.xyz2sgf = xyz2sgf;

if (require.main === module) {
    main();
}
