/** One file the page has custody of. The bytes are in a blob store beside
 *  this catalog (pewter-shell/web/db.ts); everything a list needs is here, so
 *  `pewt files` never opens a blob to render a row. */
export interface HeldFile {
    id: string;
    /** basename, as it was flung. */
    name: string;
    /** where in the pewter it came from — provenance, and what a re-fling of
     *  the same path supersedes on. The page can still read that path; a held
     *  copy is deliberately not looking at it. */
    from: string;
    type: string;
    size: number;
    /** when it landed here. */
    at: number;
}
/** A folder-relative path, or null if it is not one the page may read.
 *
 *  The page's reach is exactly the folder it was granted, so a path that
 *  climbs out of it, starts at the root, or names a drive is refused here
 *  rather than resolved and refused later by Chrome. Both ends run this: the
 *  command line to turn what you typed into what travels, and the page to
 *  check what arrived — anything that can write the folder can write anything
 *  (spec/PROTOCOL.md, threat model). */
export declare function safeRelPath(input: unknown): string | null;
export declare const basename: (path: string) => string;
export declare const newFileId: () => string;
/** A guess from the extension. Chrome reports one on the `File` it hands over
 *  and it is empty more often than not, so this is the fallback and usually
 *  the answer. A viewer choice is not a security boundary; sniffing content
 *  would be a bigger lie than the extension. */
export declare function mimeFor(name: string): string;
/** Which viewer a file gets. Text and image are the two the shell has;
 *  everything else says so rather than rendering mojibake. Adding a third is
 *  a case here and a branch in the viewer component, which is what "various
 *  viewers" has to mean before it means anything. */
export declare function viewerFor(type: string): "text" | "image" | "none";
/** Bytes, as a terminal and a footer both want them read. */
export declare const sizeText: (n: number) => string;
//# sourceMappingURL=files.d.ts.map