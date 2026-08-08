export type Inline = {
    kind: "text";
    text: string;
} | {
    kind: "code";
    text: string;
} | {
    kind: "strong";
    children: Inline[];
} | {
    kind: "em";
    children: Inline[];
} | {
    kind: "link";
    href: string;
    children: Inline[];
};
export type Block = {
    kind: "p";
    children: Inline[];
} | {
    kind: "heading";
    level: number;
    children: Inline[];
}
/** `closed` is false when the input ended before the fence did — i.e. a
 *  block still streaming. The renderer can say so; nothing else changes. */
 | {
    kind: "code";
    lang: string;
    text: string;
    closed: boolean;
} | {
    kind: "list";
    ordered: boolean;
    items: Inline[][];
} | {
    kind: "quote";
    children: Inline[];
} | {
    kind: "hr";
};
export declare function parseMarkdown(src: string): Block[];
export declare function parseInline(src: string): Inline[];
//# sourceMappingURL=markdown.d.ts.map